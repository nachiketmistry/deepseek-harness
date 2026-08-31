/**
 * Cloudflare Sandbox SDK Service Provider for the subprocess capability seam.
 * Processes run inside the shared container owned by `ctx.cfSandbox`; the
 * container supervisor, not this Worker, holds process state, so handles are
 * SDK subscriptions over its log and exit streams.
 *
 * Substrate limits: the SDK exposes no process stdin, so `stdin: 'pipe'` is
 * rejected and batch stdin is staged as a file the program reads from fd 0;
 * `'inherit'` output has no parent descriptor to inherit and is rejected;
 * there is no parent environment, so the explicit `env` layers onto the
 * container's sandbox-level environment, with `undefined` tombstones applied
 * through `env -u`.
 * @module @deepseek-ai/dsh-subprocess-cf-sandbox
 */

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-cf-sandbox'
import { asError } from './output.ts'
import { CfSandboxSubprocessHandle } from './process.ts'
import { spawnCfTerminal } from './terminal.ts'

/** Configuration for the container subprocess provider. */
export interface Config {
  /** Absolute container directory holding staged batch-stdin files; created on first use. */
  tempDir: string
}

/** Validated configuration. */
export const Config: z<Config> = z.object({
  tempDir: z.string().default('/tmp/dsh-subprocess'),
})

/**
 * Enforce the seam's documented grace bound (positive, finite, one timer).
 * @param graceMs - The spec's cleanup grace in milliseconds.
 */
function requireRepresentableGrace(graceMs: number): void {
  if (!Number.isFinite(graceMs) || graceMs <= 0 || graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subprocess graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/** Container process manager registered as `ctx.subprocess`. */
export class CfSandboxSubprocessRuntime extends SubprocessRuntime {
  static Config = Config
  static inject = ['cfSandbox']

  private readonly live = new Set<CfSandboxSubprocessHandle>()
  private readonly terminals = new Set<SubprocessTerminalHandle>()
  private disposing = false

  constructor(ctx: Context, readonly config: Config) {
    super(ctx)
    if (!posix.isAbsolute(config.tempDir)) throw new Error('subprocess-cf-sandbox: tempDir must be an absolute container path')
    ctx.effect(() => async () => {
      this.disposing = true
      const pending: Promise<unknown>[] = []
      for (const handle of this.live) {
        handle.terminate()
        pending.push(handle.waitForExit().then(() => { this.live.delete(handle) }))
      }
      for (const terminal of this.terminals) {
        pending.push(terminal.terminate().then(() => { this.terminals.delete(terminal) }))
      }
      const outcomes = await Promise.allSettled(pending)
      const failures = outcomes.flatMap<unknown>(outcome => outcome.status === 'rejected' ? [outcome.reason as unknown] : [])
      if (failures.length === 1) throw asError(failures[0])
      if (failures.length > 1) throw new AggregateError(failures, 'subprocess-cf-sandbox: teardown failed')
    }, 'cf-sandbox subprocess teardown')
  }

  /** @inheritdoc */
  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.length === 0) throw new Error('subprocess-cf-sandbox: executable name must be non-empty')
    signal?.throwIfAborted()
    const { cfSandbox } = this.ctx
    if (posix.isAbsolute(command)) {
      const probe = await cfSandbox.run(['test', '-f', command, '-a', '-x', command])
      signal?.throwIfAborted()
      if (probe.exitCode !== 0) throw new Error(`subprocess-cf-sandbox: ${command} is not an executable file in the container`)
      return command
    }
    if (command.includes('/')) {
      throw new Error(
        `subprocess-cf-sandbox: command ${JSON.stringify(command)} is a relative path; use an absolute path or a bare PATH name`,
      )
    }
    const path = env?.PATH
    const result = await cfSandbox.run(['sh', '-c', 'command -v -- "$1"', 'sh', command], {
      cwd: cfSandbox.workspaceRoot,
      ...(path === undefined ? {} : { env: { PATH: path } }),
    })
    signal?.throwIfAborted()
    const executable = result.stdout.trim()
    if (result.exitCode !== 0 || executable.includes('\n') || (!posix.isAbsolute(executable) && !executable.includes('/'))) {
      throw new Error(`subprocess-cf-sandbox: executable ${JSON.stringify(command)} did not resolve to one absolute path`)
    }
    // A relative result comes from a relative PATH entry; the lookup ran in the workspace root.
    return posix.resolve(cfSandbox.workspaceRoot, executable)
  }

  /** @inheritdoc */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (this.disposing) throw new Error('subprocess-cf-sandbox: service is disposing')
    const program = spec.argv[0]
    if (program === undefined || program.length === 0) {
      throw new Error('invalid argv: expected a non-empty program name at argv[0]')
    }
    requireRepresentableGrace(spec.graceMs)
    if (spec.stdio.stdin === 'pipe') {
      throw new Error('subprocess-cf-sandbox: stdin "pipe" is unsupported; the Sandbox SDK exposes no process stdin (use { data } or "ignore")')
    }
    if (spec.stdio.stdout === 'inherit' || spec.stdio.stderr === 'inherit') {
      throw new Error('subprocess-cf-sandbox: "inherit" output is unsupported; a Worker has no parent descriptors')
    }
    if (spec.signal?.aborted === true) {
      throw new Error(`aborted before spawn: ${String(spec.signal.reason)}`)
    }
    const stdinPath = typeof spec.stdio.stdin === 'object'
      ? posix.join(this.config.tempDir, `${randomUUID()}.stdin`)
      : undefined
    const handle = new CfSandboxSubprocessHandle(this.ctx.cfSandbox, spec, stdinPath)
    this.live.add(handle)
    const release = (): void => { this.live.delete(handle) }
    void handle.done.then(release, release)
    return handle
  }

  /** @inheritdoc */
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    if (this.disposing) throw new Error('subprocess-cf-sandbox: service is disposing')
    const program = spec.argv[0]
    if (program === undefined || program.length === 0) {
      throw new Error('subprocess-cf-sandbox: terminal argv must contain a program')
    }
    requireRepresentableGrace(spec.graceMs)
    spec.signal?.throwIfAborted()
    const terminal = await spawnCfTerminal(this.ctx.cfSandbox, spec)
    this.terminals.add(terminal)
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Remote allocation yields to disposal.
    if (this.disposing) {
      await terminal.terminate()
      this.terminals.delete(terminal)
      throw new Error('subprocess-cf-sandbox: service disposed during terminal setup')
    }
    const release = (): void => { this.terminals.delete(terminal) }
    void terminal.done.then(release, release)
    return terminal
  }
}

export default CfSandboxSubprocessRuntime
