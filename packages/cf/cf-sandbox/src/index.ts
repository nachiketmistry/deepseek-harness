/**
 * @deepseek-ai/dsh-cf-sandbox — shared ownership of the one Cloudflare
 * Sandbox SDK container a deployment gives its user. The filesystem and
 * subprocess providers await the same prepared handle, so files and processes
 * inhabit one Linux world whose `/workspace` holds the git projects. The
 * container is addressed by a stable sandbox id; the platform replaces the
 * container behind that id, so preparation (the workspace root, git identity
 * and the token-backed credential helper) is idempotent and re-runs on every
 * object wake.
 * @module @deepseek-ai/dsh-cf-sandbox
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { getSandbox, type ISandbox } from '@cloudflare/sandbox'

export { streamFile } from '@cloudflare/sandbox'
import type {} from '@deepseek-ai/dsh-cf-bindings'

export type {
  CreateTerminalOptions,
  ExecOptions,
  ISandbox,
  ProcessExit,
  ProcessLogEvent,
  ProcessOutput,
  SandboxProcess,
  Terminal,
  TerminalOutputEvent,
} from '@cloudflare/sandbox'

declare module '@deepseek-ai/cordis' {
  interface Context {
    cfSandbox: CfSandbox
  }
}

/** Configuration for the shared container owner. */
export interface Config {
  /** The Sandbox Durable Object namespace binding name. */
  binding: string
  /** The stable sandbox id; one container per id. */
  sandboxId: string
  /** Absolute directory holding the projects, created at preparation. */
  workspaceRoot: string
  /** Secret name of the GitHub token materialized as `GH_TOKEN`; unset leaves git unauthenticated. */
  gitTokenSecret?: string
  /** Git identity written to the container's global config. */
  gitUser: { name: string; email: string }
  /**
   * Idle time after which the platform stops the container; its disk is lost
   * then and projects are re-cloned on the next wake. `"10m"`-style durations.
   */
  sleepAfter: string
}

/** Validated configuration. */
export const Config: z<Config> = z.object({
  binding: z.string().default('SANDBOX'),
  sandboxId: z.string().default('default'),
  workspaceRoot: z.string().default('/workspace'),
  gitTokenSecret: z.string(),
  gitUser: z.object({
    name: z.string().default('dsh'),
    email: z.string().default('dsh@users.noreply.github.com'),
  }).default({ name: 'dsh', email: 'dsh@users.noreply.github.com' }),
  sleepAfter: z.string().default('1h'),
})


/**
 * The `cfSandbox` service: one prepared container handle per tree. `ready`
 * resolves once the workspace root exists and git is configured; adapters
 * await it before their first operation.
 */
export class CfSandbox extends Service {
  static Config = Config
  static inject = ['cf']

  /** The SDK handle; valid from construction. */
  readonly sandbox: ISandbox
  /** Absolute workspace root inside the container. */
  readonly workspaceRoot: string
  /**
   * Resolves when preparation has completed for this object wake and the
   * remembered projects have been checked recently; adapters await it before
   * every operation, so a container replaced mid-life gets its projects back
   * within {@link MATERIALIZE_INTERVAL_MS}.
   */
  get ready(): Promise<void> {
    const now = Date.now()
    if (this.materialized === undefined || now - this.materializedAt > MATERIALIZE_INTERVAL_MS) {
      this.materializedAt = now
      this.materialized = this.prepared.then(() => this.materialize()).then(() => undefined)
      this.materialized.catch(() => { this.materializedAt = 0 })
    }
    return this.materialized
  }

  private readonly prepared: Promise<void>
  private materialized: Promise<void> | undefined
  private materializedAt = 0
  /**
   * The environment every container process launches with: the git identity
   * and token-backed credential helper as `GIT_CONFIG_*` entries, `GH_TOKEN`,
   * and no terminal prompts. Carried per launch, never stored in the
   * container: the platform replaces containers behind the sandbox id, and
   * the SDK's stored environment does not survive that either.
   */
  readonly environment: Readonly<Record<string, string>>

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'cfSandbox')
    this.workspaceRoot = config.workspaceRoot
    // The SDK types its namespace parameter with the workerd global `DurableObjectNamespace`,
    // which this Node-typed package cannot name; the binding is the untyped environment value.
    this.sandbox = getSandbox(ctx.cf.binding(config.binding) as never, config.sandboxId, { sleepAfter: config.sleepAfter })
    const token = config.gitTokenSecret === undefined ? undefined : ctx.cf.secret(config.gitTokenSecret)
    this.environment = launchEnvironment(config, token)
    this.prepared = this.prepare()
  }

  /**
   * Run one command to completion with collected output.
   * @param argv - executable and arguments, no shell.
   * @param options - working directory, environment, and timeout.
   * @returns exit code and decoded output.
   */
  async run(
    argv: readonly [string, ...string[]],
    options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    await this.ready
    const process = await this.sandbox.exec(argv, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...this.environment, ...options.env },
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    })
    const output = await process.output({ encoding: 'utf8' })
    return { exitCode: output.exitCode, stdout: output.stdout, stderr: output.stderr }
  }

  /**
   * Record a project's clone origin so a replaced container gets it back.
   * @param path - absolute project directory under the workspace root.
   * @param url - the clone URL.
   */
  async rememberProject(path: string, url: string): Promise<void> {
    const projects = await this.projects()
    projects[path] = url
    await this.ctx.cf.storage.put(PROJECTS_KEY, projects)
  }

  /**
   * Clone every remembered project whose directory is missing: the
   * container's disk is ephemeral (sleep, replacement), git is the durable copy.
   * @returns the paths cloned by this call.
   */
  async materialize(): Promise<string[]> {
    const cloned: string[] = []
    for (const [path, url] of Object.entries(await this.projects())) {
      const { exists } = await this.sandbox.exists(path)
      if (exists) continue
      const parent = path.slice(0, path.lastIndexOf('/')) || '/'
      const name = path.slice(path.lastIndexOf('/') + 1)
      const process = await this.sandbox.exec(['git', 'clone', '--', url, name], { cwd: parent, env: { ...this.environment } })
      const result = await process.output({ encoding: 'utf8' })
      if (result.exitCode !== 0) throw new Error(`cf-sandbox: re-cloning ${url} into ${path} failed (${String(result.exitCode)}): ${result.stderr}`)
      cloned.push(path)
    }
    if (cloned.length > 0) this.ctx.logger.info('cf-sandbox: re-cloned %d project(s) into a fresh container', cloned.length)
    return cloned
  }

  private async projects(): Promise<Record<string, string>> {
    return (await this.ctx.cf.storage.get<Record<string, string>>(PROJECTS_KEY)) ?? {}
  }

  private async prepare(): Promise<void> {
    await this.sandbox.mkdir(this.config.workspaceRoot, { recursive: true })
  }
}

/** How long a project check stays fresh before `ready` probes the container again. */
const MATERIALIZE_INTERVAL_MS = 10_000

/** Durable Object storage key of the project origin table (path -> clone URL). */
const PROJECTS_KEY = 'cf-sandbox:projects'

/** Build the per-launch environment. */
function launchEnvironment(config: Config, token: string | undefined): Record<string, string> {
  const gitConfig: [string, string][] = [
    ['user.name', config.gitUser.name],
    ['user.email', config.gitUser.email],
    ['init.defaultBranch', 'main'],
  ]
  if (token !== undefined) {
    // `GH_TOKEN` is read at credential time, so the helper text carries no secret.
    gitConfig.push(['credential.helper', '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'])
  }
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: String(gitConfig.length) }
  gitConfig.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${String(i)}`] = key
    env[`GIT_CONFIG_VALUE_${String(i)}`] = value
  })
  if (token !== undefined) env.GH_TOKEN = token
  return env
}

export default CfSandbox
