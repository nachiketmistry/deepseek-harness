/** One container-supervised process projected onto the subprocess seam. */

import { PassThrough } from 'node:stream'
import { posix } from 'node:path'
import type { CfSandbox, ProcessLogEvent, SandboxProcess } from '@deepseek-ai/dsh-cf-sandbox'
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { asError, CfOutputReader, delay, outcomeOf, settledBefore, SIGNAL_NUMBERS } from './output.ts'

/**
 * POSIX `sh` prologue that attaches fd 0 to `$0` (a staged stdin file or
 * `/dev/null`), unlinks a staged file before the program can observe it, and
 * execs the real argv so no wrapper process survives.
 */
const STDIN_WRAPPER = [
  'exec 0<"$0" || exit 126',
  'case $0 in /dev/null) ;; *) rm -f -- "$0" ;; esac',
  'exec "$@"',
].join('\n')

function isCollect(mode: SubprocessOutputMode): mode is SubprocessCollect {
  return mode !== 'pipe' && mode !== 'inherit'
}

/**
 * Split the seam's environment layer into the SDK's overlay and the names it
 * cannot express: an `undefined` tombstone removes a sandbox-level entry, which
 * only `env -u` inside the container can do.
 * @param explicit - The spec's explicit environment entries.
 * @returns overlay entries and tombstoned names.
 */
export function splitEnvironment(explicit: NodeJS.ProcessEnv | undefined): { overlay: Record<string, string>; unset: string[] } {
  const overlay: Record<string, string> = {}
  const unset: string[] = []
  for (const [name, value] of Object.entries(explicit ?? {})) {
    if (name.length === 0 || name.includes('=') || name.includes('\0') || value?.includes('\0') === true) {
      throw new Error('subprocess-cf-sandbox: environment entries require non-empty NUL-free names without = and NUL-free values')
    }
    if (value === undefined) unset.push(name)
    else overlay[name] = value
  }
  return { overlay, unset }
}

/**
 * Compose the argv handed to the container supervisor: the stdin wrapper
 * (pipe processes only; a terminal keeps its PTY on fd 0), tombstone removal,
 * then the caller's program.
 * @param argv - The spec's program and arguments.
 * @param stdinPath - Staged stdin file or `/dev/null`; `undefined` leaves fd 0 untouched.
 * @param unset - Names removed from the inherited sandbox environment.
 * @returns executable and arguments for the SDK launch.
 */
export function wrapArgv(argv: readonly string[], stdinPath: string | undefined, unset: readonly string[]): [string, ...string[]] {
  const removal = unset.length === 0 ? [] : ['env', ...unset.flatMap(name => ['-u', name]), '--']
  const command = [...removal, ...argv] as [string, ...string[]]
  return stdinPath === undefined ? command : ['sh', '-c', STDIN_WRAPPER, stdinPath, ...command]
}

/** Container-backed subprocess handle; the SDK process starts after the shared container is ready. */
export class CfSandboxSubprocessHandle implements SubprocessHandle {
  readonly stdin = undefined
  readonly stdout: PassThrough | undefined
  readonly stderr: PassThrough | undefined
  readonly collected: SubprocessHandle['collected']
  readonly done: Promise<SubprocessOutcome>

  private readonly processState = Promise.withResolvers<SandboxProcess | undefined>()
  private readonly logsController = new AbortController()
  private readonly stdoutReader: CfOutputReader | undefined
  private readonly stderrReader: CfOutputReader | undefined
  private remotePid = -1
  private terminating = false
  private exited = false
  private terminationSignal: NodeJS.Signals | null = null

  /**
   * Begin one container process without blocking the synchronous spawn call.
   * @param owner - Shared container owner.
   * @param spec - Fully resolved subprocess request.
   * @param stdinPath - Absolute container path that will hold batch stdin, when the spec supplies data.
   */
  constructor(
    private readonly owner: CfSandbox,
    private readonly spec: SubprocessSpawnSpec,
    private readonly stdinPath: string | undefined,
  ) {
    const outMode = spec.stdio.stdout
    const errMode = spec.stdio.stderr
    this.stdout = outMode === 'pipe' ? new PassThrough() : undefined
    this.stderr = errMode === 'pipe' ? new PassThrough() : undefined
    this.stdoutReader = isCollect(outMode) ? new CfOutputReader(outMode.maxBytes) : undefined
    this.stderrReader = isCollect(errMode) ? new CfOutputReader(errMode.maxBytes) : undefined
    this.collected = {
      ...(this.stdoutReader !== undefined ? { stdout: this.stdoutReader } : {}),
      ...(this.stderrReader !== undefined ? { stderr: this.stderrReader } : {}),
    }
    spec.signal?.addEventListener('abort', this.onAbort, { once: true })
    this.done = this.run()
    void this.done.catch(() => {})
    if (spec.signal?.aborted === true) this.terminate()
  }

  /** Container process id after start; `-1` while startup is pending or after it fails. */
  get pid(): number {
    return this.remotePid
  }

  /** @inheritdoc */
  terminate(): void {
    if (this.terminating || this.exited) return
    this.terminating = true
    this.stdout?.destroy()
    this.stderr?.destroy()
    void this.escalate().catch((_terminationFailure: unknown) => {
      // The exit promise is the authority on liveness; a failed kill leaves `done` pending as the seam documents.
    })
  }

  /** @inheritdoc */
  waitForExit(signal?: AbortSignal): Promise<boolean> {
    // The SDK settles a process only after its whole supervised group has exited, so `done` is tree quiescence.
    return settledBefore(this.done, signal)
  }

  private readonly onAbort = (): void => { this.terminate() }

  private async escalate(): Promise<void> {
    const process = await this.processState.promise
    if (process === undefined || this.exited) return
    this.terminationSignal = 'SIGTERM'
    await process.kill(SIGNAL_NUMBERS.SIGTERM)
    if (await settledBefore(this.done, AbortSignal.timeout(this.spec.graceMs))) return
    this.terminationSignal = 'SIGKILL'
    await process.kill(SIGNAL_NUMBERS.SIGKILL)
  }

  private async run(): Promise<SubprocessOutcome> {
    let process: SandboxProcess | undefined
    try {
      await this.owner.ready
      const stdinPath = await this.stageStdin()
      if (this.terminating) {
        this.processState.resolve(undefined)
        return { exitCode: null, signal: 'SIGTERM' }
      }
      const { overlay, unset } = splitEnvironment(this.spec.env)
      process = await this.owner.sandbox.exec(wrapArgv(this.spec.argv, stdinPath, unset), {
        cwd: this.spec.cwd,
        env: { ...this.owner.environment, ...overlay },
      })
      this.remotePid = process.pid
      this.processState.resolve(process)
      const logs = await process.logs({ follow: true, replay: true, signal: this.logsController.signal })
      const pumped = this.pump(logs)
      void pumped.catch(() => {})
      const exit = await process.waitForExit()
      this.exited = true
      // A descendant holding the log pipe open cannot hold the outcome open past the grace period.
      await Promise.race([pumped, delay(this.spec.graceMs)])
      this.logsController.abort()
      const outcome = outcomeOf(exit)
      return outcome.signal === null && this.terminationSignal !== null && outcome.exitCode !== 0
        ? { exitCode: null, signal: this.terminationSignal }
        : outcome
    } catch (error: unknown) {
      this.processState.resolve(process)
      throw asError(error)
    } finally {
      this.exited = true
      this.spec.signal?.removeEventListener('abort', this.onAbort)
      this.stdout?.end()
      this.stderr?.end()
    }
  }

  private async stageStdin(): Promise<string> {
    const { stdin } = this.spec.stdio
    if (stdin === 'ignore') return '/dev/null'
    if (stdin === 'pipe') throw new Error('subprocess-cf-sandbox: stdin "pipe" is unsupported; the Sandbox SDK exposes no process stdin')
    if (this.stdinPath === undefined) throw new Error('subprocess-cf-sandbox: batch stdin requires a staging path')
    await this.owner.sandbox.mkdir(posix.dirname(this.stdinPath), { recursive: true })
    await this.owner.sandbox.writeFile(this.stdinPath, stdin.data)
    return this.stdinPath
  }

  private async pump(logs: ReadableStream<ProcessLogEvent>): Promise<void> {
    const reader = logs.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        if (this.dispatch(value)) return
      }
    } catch (error: unknown) {
      // Cancelling our own subscription after the drain grace is not a transport failure.
      if (!this.logsController.signal.aborted) throw error
    } finally {
      reader.releaseLock()
    }
  }

  private dispatch(event: ProcessLogEvent): boolean {
    switch (event.type) {
      case 'stdout':
        this.stdoutReader?.push(event.data)
        this.writePipe(this.stdout, event.data)
        return false
      case 'stderr':
        this.stderrReader?.push(event.data)
        this.writePipe(this.stderr, event.data)
        return false
      case 'terminal':
        return true
      case 'truncated':
        return false
    }
  }

  private writePipe(pipe: PassThrough | undefined, data: Uint8Array): void {
    if (pipe === undefined || pipe.destroyed || data.length === 0) return
    pipe.write(data)
  }
}
