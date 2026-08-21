/** One Sandbox SDK terminal projected onto the seam's terminal-process primitive. */

import { PassThrough } from 'node:stream'
import type { CfSandbox, Terminal, TerminalOutputEvent } from '@deepseek-ai/dsh-cf-sandbox'
import type {
  SubprocessOutcome,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { asError, delay, outcomeOf, settledBefore } from './output.ts'
import { splitEnvironment, wrapArgv } from './process.ts'

/**
 * Allocate one container PTY. The SDK owns the session: it exposes `write`,
 * `interrupt` (SIGINT to the foreground group) and `terminate`, but publishes
 * no foreground process-group id, so {@link SubprocessTerminalHandle.inspectForeground}
 * always reports none and only `SIGINT` can be delivered by name.
 * @param owner - Shared container owner.
 * @param spec - Fully specified terminal spawn.
 * @returns the live terminal handle after allocation succeeds.
 */
export async function spawnCfTerminal(owner: CfSandbox, spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
  await owner.ready
  spec.signal?.throwIfAborted()
  const { overlay, unset } = splitEnvironment(spec.env)
  const terminal = await owner.sandbox.createTerminal({
    command: wrapArgv(spec.argv, undefined, unset),
    cwd: spec.cwd,
    env: overlay,
    cols: spec.cols,
    rows: spec.rows,
  })
  const handle = new CfTerminalHandle(terminal, spec.graceMs)
  if (spec.signal?.aborted === true) {
    await handle.terminate()
    spec.signal.throwIfAborted()
  }
  await handle.start()
  return handle
}

class CfTerminalHandle implements SubprocessTerminalHandle {
  readonly output = new PassThrough()
  readonly done: Promise<SubprocessOutcome>
  pid = -1

  private readonly outputController = new AbortController()
  private termination: Promise<void> | undefined

  constructor(private readonly terminal: Terminal, private readonly graceMs: number) {
    this.done = this.observe()
    void this.done.catch(() => {})
  }

  async start(): Promise<void> {
    const snapshot = await this.terminal.getSnapshot()
    if (snapshot.pid !== undefined) this.pid = snapshot.pid
  }

  async write(data: string): Promise<void> {
    await this.terminal.write(new TextEncoder().encode(data))
  }

  inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    return Promise.resolve(undefined)
  }

  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    if (signal !== 'SIGINT') {
      throw new Error(`subprocess-cf-sandbox: terminal signal ${signal} is unsupported; the Sandbox SDK delivers only SIGINT to the foreground group`)
    }
    await this.terminal.interrupt()
    return this.pid
  }

  terminate(): Promise<void> {
    this.termination ??= this.terminateSession()
    return this.termination
  }

  private async terminateSession(): Promise<void> {
    try {
      await this.terminal.terminate()
    } catch (error: unknown) {
      if (!await settledBefore(this.done, AbortSignal.timeout(0))) throw asError(error)
    }
    if (!await settledBefore(this.done, AbortSignal.timeout(this.graceMs))) {
      throw new Error('subprocess-cf-sandbox: terminal session did not settle within graceMs after terminate')
    }
  }

  private async observe(): Promise<SubprocessOutcome> {
    try {
      const stream = await this.terminal.output({ follow: true, replay: true, signal: this.outputController.signal })
      const pumped = this.pump(stream)
      void pumped.catch(() => {})
      const exit = await this.terminal.waitForExit()
      await Promise.race([pumped, delay(this.graceMs)])
      this.outputController.abort()
      return outcomeOf(exit)
    } finally {
      this.output.end()
    }
  }

  private async pump(stream: ReadableStream<TerminalOutputEvent>): Promise<void> {
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        if (value.type === 'data') {
          if (!this.output.destroyed) this.output.write(value.data)
        } else if (value.type === 'terminal') {
          return
        }
      }
    } catch (error: unknown) {
      if (!this.outputController.signal.aborted) throw error
    } finally {
      reader.releaseLock()
    }
  }
}
