/**
 * Browse backend of the directory-picker seam over the Cloudflare Sandbox
 * container: registers `ctx.directoryPicker` with the `browse` capability —
 * one-level directory listing and child-directory creation against the
 * container filesystem the `cfSandbox` service owns. The container is the
 * user's own Linux world, so any absolute path lists; `home` is the sandbox
 * workspace root where the git projects live. The "new folder" box doubles
 * as the git-clone entry (see {@link CfDirectoryPicker}).
 * @module @deepseek-ai/dsh-directory-picker-cf
 */

import { basename, dirname, isAbsolute, join, normalize } from 'node:path/posix'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-cf-sandbox'
import { DirectoryPicker, DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryEntry, DirectoryListing, DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'
import { cloneBasename, isGitUrl } from './git-url.ts'

export { cloneBasename, isGitUrl } from './git-url.ts'

/** Ancestor chain from `/` to `target` inclusive — the breadcrumb rows of a listing. */
function ancestryCrumbs(target: string): DirectoryEntry[] {
  const crumbs: DirectoryEntry[] = []
  let current = target
  for (;;) {
    const parent = dirname(current)
    crumbs.unshift({ name: parent === current ? current : basename(current), path: current, hidden: false })
    if (parent === current) return crumbs
    current = parent
  }
}

/** The thrown value as an Error (wire/abort reasons may be anything). */
function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

/** Message text of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Await `operation`, but reject with the signal's reason the moment it
 * aborts. Container RPCs are not retractable, so the call keeps running
 * inside the SDK; its late settlement is swallowed here so an abandoned
 * request cannot surface as an unhandled rejection.
 * @param operation - the in-flight container step.
 * @param signal - caller lifetime; absent means plain awaiting.
 * @returns the operation's value.
 */
export function raceAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      operation.catch(() => {
        // Abandoned container call: the abort reason already carried the outcome.
      })
      reject(asError(signal.reason))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (reason: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(asError(reason))
      },
    )
  })
}

/** Validated plugin configuration. */
export interface Config {
  /** Complete-result bound of one listing level (hidden rows included); a cut level reports `truncated`. */
  maxEntries: number
  /** Upper bound on one `git clone` run inside the container, in milliseconds. */
  cloneTimeoutMs: number
}

/** Validated configuration. */
export const Config: z<Config> = z.object({
  maxEntries: z.natural().min(1).default(500),
  cloneTimeoutMs: z.natural().min(1).default(300_000),
})

/**
 * The `ctx.directoryPicker` browse implementation over the sandbox container
 * (stable capability object per service life).
 *
 * Clone convention: the UI bundles are unchanged in this phase, so the
 * browser's "new folder" box is also the clone entry. A `name` that is a git
 * remote URL (`https://…`, `ssh://…`, `git://…`, `git@host:owner/repo(.git)`)
 * runs a full `git clone <url>` inside `path` into the repository basename
 * without `.git`, and `createDirectory` returns that checkout's absolute
 * path. Private repositories authenticate through the credential helper
 * `cfSandbox` configures from `GH_TOKEN`. Any other `name` is one plain path
 * segment and creates an empty directory.
 */
export default class CfDirectoryPicker extends DirectoryPicker {
  static inject = ['cfSandbox']
  static Config = Config

  private readonly browseCapability: DirectoryPickerCapability = {
    kind: 'browse',
    list: (path, signal) => this.list(path, signal),
    createDirectory: (path, name) => this.createDirectory(path, name),
  }

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
  }

  /**
   * The browse interaction capability.
   * @returns the stable `browse` capability object.
   */
  capability(): DirectoryPickerCapability {
    return this.browseCapability
  }

  private async list(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const { cfSandbox } = this.ctx
    const home = cfSandbox.workspaceRoot
    // The seam takes fully qualified paths only; a relative wire value has no
    // cwd to resolve against inside the container.
    if (path !== undefined && !isAbsolute(path)) {
      throw new DirectoryPickerError('directory-unreadable', path, `cannot list "${path}": not a fully qualified path`)
    }
    const target = normalize(path ?? home)
    let rows: { name: string; path: string; type: string }[]
    try {
      await raceAbort(cfSandbox.ready, signal)
      const listing = await raceAbort(cfSandbox.sandbox.listFiles(target, { includeHidden: true }), signal)
      if (!listing.success) throw new Error(`listFiles reported failure (exit ${String(listing.exitCode)})`)
      rows = listing.files.map(file => ({ name: file.name, path: file.absolutePath, type: file.type }))
    } catch (error: unknown) {
      // An abort is the caller's own reason, not an unreadable directory.
      signal?.throwIfAborted()
      throw new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}: ${messageOf(error)}`)
    }
    // Only rows a browser could enter contend for the bound; a symlink needs
    // a probe to learn whether it points at a directory.
    const candidates = rows
      .filter(row => row.type === 'directory' || row.type === 'symlink')
      .sort((a, b) => a.name.localeCompare(b.name))
    const entries: DirectoryEntry[] = []
    let truncated = false
    for (const candidate of candidates) {
      signal?.throwIfAborted()
      if (candidate.type === 'symlink' && !await this.isDirectory(candidate.path, signal)) continue
      if (entries.length === this.config.maxEntries) {
        truncated = true
        break
      }
      entries.push({ name: candidate.name, path: join(target, candidate.name), hidden: candidate.name.startsWith('.') })
    }
    return { path: target, home, crumbs: ancestryCrumbs(target), entries, truncated }
  }

  /** Whether a symlink resolves to a directory; a broken or cyclic link is not enterable. */
  private async isDirectory(path: string, signal: AbortSignal | undefined): Promise<boolean> {
    try {
      const result = await raceAbort(this.ctx.cfSandbox.run(['test', '-d', path]), signal)
      return result.exitCode === 0
    } catch {
      if (signal?.aborted) throw asError(signal.reason)
      // The probe itself failed: treat the link as not enterable, like a broken link.
      return false
    }
  }

  private async createDirectory(path: string, name: string): Promise<string> {
    if (!isAbsolute(path)) {
      throw new DirectoryPickerError('directory-create-failed', path, `cannot create under "${path}": not a fully qualified parent path`)
    }
    const parent = normalize(path)
    if (isGitUrl(name)) return this.clone(parent, name)
    // The backend owns segment validation (the wire schema also refuses these,
    // but direct service consumers must hit the same fence).
    if (name.trim() === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
      throw new DirectoryPickerError('directory-create-failed', join(parent, name), `"${name}" is not a single path segment`)
    }
    const target = join(parent, name)
    const { cfSandbox } = this.ctx
    try {
      await cfSandbox.ready
      await this.refuseExisting(target)
      // Non-recursive: the parent is the directory the browser is showing, so
      // a missing parent is a real failure, not a level to invent.
      const result = await cfSandbox.sandbox.mkdir(target)
      if (!result.success) throw new Error(`mkdir reported failure (exit ${String(result.exitCode)})`)
      return target
    } catch (error: unknown) {
      if (error instanceof DirectoryPickerError) throw error
      throw new DirectoryPickerError('directory-create-failed', target, `cannot create ${target}: ${messageOf(error)}`)
    }
  }

  private async clone(parent: string, url: string): Promise<string> {
    const base = cloneBasename(url)
    if (base === null) {
      throw new DirectoryPickerError('directory-create-failed', parent, `cannot derive a checkout directory from "${url}"`)
    }
    const target = join(parent, base)
    const { cfSandbox } = this.ctx
    let result: { exitCode: number; stderr: string }
    try {
      await cfSandbox.ready
      await this.refuseExisting(target)
      result = await cfSandbox.run(['git', 'clone', '--', url, base], { cwd: parent, timeoutMs: this.config.cloneTimeoutMs })
    } catch (error: unknown) {
      if (error instanceof DirectoryPickerError) throw error
      throw new DirectoryPickerError('directory-create-failed', target, `cannot clone ${url} into ${target}: ${messageOf(error)}`)
    }
    if (result.exitCode !== 0) {
      throw new DirectoryPickerError('directory-create-failed', target, `git clone ${url} failed (exit ${String(result.exitCode)}): ${result.stderr.trim()}`)
    }
    await cfSandbox.rememberProject(target, url)
    return target
  }

  /** Throw `directory-exists` when `target` is already present in the container. */
  private async refuseExisting(target: string): Promise<void> {
    const probe = await this.ctx.cfSandbox.sandbox.exists(target)
    if (probe.exists) throw new DirectoryPickerError('directory-exists', target, `${target} already exists`)
  }
}
