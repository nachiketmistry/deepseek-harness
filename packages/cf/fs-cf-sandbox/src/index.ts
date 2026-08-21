/**
 * Cloudflare Sandbox SDK provider for the filesystem capability seam. Paths,
 * contents, and atomic staging files stay inside the container owned by
 * `ctx.cfSandbox`; the SDK file API serves reads, writes, listings, and
 * existence probes, and container commands (`realpath`, `stat`, `chmod`,
 * `ln`, `mv`, `rm`) serve canonical identity, metadata, and publication.
 * @module @deepseek-ai/dsh-fs-cf-sandbox
 */

import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { streamFile } from '@deepseek-ai/dsh-cf-sandbox'

/** Configuration for the Cloudflare Sandbox filesystem provider. */
export interface Config {
  /** Timeout for each metadata or publication command run inside the container. */
  commandTimeoutMs: number
}

/** Validated configuration. */
export const Config: z<Config> = z.object({
  commandTimeoutMs: z.natural().default(30_000),
})

const BINARY_SAMPLE_BYTES = 8192
/** `stat` format: type, device, inode, size, full modification time, mode, link count; one per line. */
// A literal newline between fields: GNU stat's `%n` is the file name, not a newline.
const STAT_FORMAT = '%F\n%d\n%i\n%s\n%y\n%a\n%h'

/** One parsed `stat` record for a path inside the container. */
interface StatRecord {
  type: FsPathInfo['type']
  size: number
  mode: number
  version: FsVersion
}

function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) throw new FsError(`${operation} aborted`, 'FS_ABORTED')
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n')
}

function detectsCrlf(value: string): boolean {
  const sample = value.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return crlf > lf
}

function restoreLineEndings(value: string, crlf: boolean): string {
  return crlf ? normalizeLineEndings(value).replaceAll('\n', '\r\n') : value
}

function decodeText(bytes: Uint8Array, displayPath: string, binarySampleBytes: number): string {
  if (bytes.subarray(0, binarySampleBytes).includes(0)) {
    throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
  }
}

/** The `%F` file-type words GNU `stat` prints, mapped onto the seam's path types. */
function statType(word: string): FsPathInfo['type'] {
  switch (word) {
    case 'regular file':
    case 'regular empty file':
      return 'file'
    case 'directory':
      return 'directory'
    case 'symbolic link':
      return 'symlink'
    default:
      return 'other'
  }
}

function parseStat(stdout: string, path: string): StatRecord {
  const lines = stdout.replace(/\n$/, '').split('\n')
  if (lines.length !== 7) throw new Error(`fs-cf-sandbox: stat returned ${lines.length} fields, expected 7`)
  const [typeWord, device, inode, size, mtime, mode, links] = lines as [string, string, string, string, string, string, string]
  const facts = JSON.stringify([path, typeWord, device, inode, size, mtime, mode, links])
  return {
    type: statType(typeWord),
    size: Number(size),
    mode: Number.parseInt(mode, 8),
    version: FsVersion(`cf:${createHash('sha256').update(facts).digest('hex')}`),
  }
}

function isSdkError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === code
}

function mapError(error: unknown, operation: string, displayPath: string, signal?: AbortSignal): FsError {
  if (error instanceof FsError) return error
  if (signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError')) {
    return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
  }
  if (isSdkError(error, 'FILE_NOT_FOUND') || /no such file or directory/i.test(String(error))) {
    return new FsError(`cannot ${operation} "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
  }
  if (isSdkError(error, 'PERMISSION_DENIED') || /permission denied|operation not permitted/i.test(String(error))) {
    return new FsError(`cannot ${operation} "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  }
  return new FsError(`cannot ${operation} "${displayPath}": ${String(error)}`, 'FS_IO_ERROR', { cause: error })
}

function literalEdit(content: string, request: FsEditRequest, displayPath: string): string {
  const oldString = normalizeLineEndings(request.oldString)
  const newString = normalizeLineEndings(request.newString)
  if (oldString.length === 0) {
    throw new FsError(`cannot edit "${displayPath}": old_string must be non-empty`, 'FS_EDIT_NOT_FOUND')
  }
  let matches = 0
  let offset = 0
  while (true) {
    const found = content.indexOf(oldString, offset)
    if (found < 0) break
    matches += 1
    offset = found + oldString.length
  }
  if (matches === 0) throw new FsError(`cannot edit "${displayPath}": old_string was not found`, 'FS_EDIT_NOT_FOUND')
  if (!request.replaceAll && matches !== 1) {
    throw new FsError(`cannot edit "${displayPath}": old_string matched ${matches} times`, 'FS_AMBIGUOUS_EDIT')
  }
  return request.replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const whole = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    whole.set(chunk, offset)
    offset += chunk.byteLength
  }
  return whole
}

/** Container filesystem backend sharing the sandbox owned by `ctx.cfSandbox`. */
export class CfSandboxFileSystem extends FileSystem {
  static Config = Config
  static inject = ['cfSandbox']

  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(ctx: Context, readonly config: Config) {
    super(ctx)
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    assertNotAborted(opts?.signal, 'resolve')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = posix.resolve(opts?.cwd ?? this.ctx.cfSandbox.workspaceRoot, path)
    try {
      const targetKey = await this.canonicalPath(displayPath, opts?.signal)
      assertNotAborted(opts?.signal, 'resolve')
      return { targetKey: FsTargetKey(targetKey), displayPath }
    } catch (error: unknown) {
      throw mapError(error, 'resolve', displayPath, opts?.signal)
    }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    const path = this.processPath(target)
    if (!posix.isAbsolute(path)) throw new Error(`fs-cf-sandbox: expected an absolute process path: ${JSON.stringify(path)}`)
    return `file://${path.split('/').map(segment => encodeURIComponent(segment)).join('/')}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const relative = posix.relative(this.processPath(parent), this.processPath(child))
    return relative === '' || (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    assertNotAborted(signal, 'stat')
    const record = await this.probe(String(target.targetKey), target.displayPath, true, signal)
    if (record === undefined) return undefined
    return {
      version: record.version,
      type: record.type === 'symlink' ? 'other' : record.type,
      ...(record.type === 'file' ? { size: record.size } : {}),
    }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    assertNotAborted(signal, 'lstat')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = posix.resolve(opts?.cwd ?? this.ctx.cfSandbox.workspaceRoot, path)
    const record = await this.probe(displayPath, displayPath, false, signal)
    if (record === undefined) return undefined
    return {
      version: record.version,
      type: record.type,
      ...(record.type === 'file' ? { size: record.size } : {}),
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    await this.requireRegular(target, signal)
    try {
      const bytes = await this.readAll(target, signal, undefined)
      return decodeText(bytes, target.displayPath, BINARY_SAMPLE_BYTES)
    } catch (error: unknown) {
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const info = await this.requireRegular(target, signal)
    if (info.size !== undefined && info.size > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    try {
      return await this.readAll(target, signal, maxBytes)
    } catch (error: unknown) {
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    await this.requireRegular(target, signal)
    const stream = await this.openReadStream(target, signal)
    const displayPath = target.displayPath
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        const reader = stream.getReader()
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let sampledBytes = 0
        let completed = false
        try {
          while (true) {
            assertNotAborted(signal, 'read')
            const next = await reader.read()
            if (next.done) break
            if (sampledBytes < BINARY_SAMPLE_BYTES) {
              const sample = next.value.subarray(0, BINARY_SAMPLE_BYTES - sampledBytes)
              if (sample.includes(0)) throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
              sampledBytes += sample.length
            }
            let text: string
            try {
              text = decoder.decode(next.value, { stream: true })
            } catch (error: unknown) {
              throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
            }
            if (text.length > 0) yield text
          }
          try {
            decoder.decode()
          } catch (error: unknown) {
            throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
          }
          completed = true
        } catch (error: unknown) {
          throw mapError(error, 'read', displayPath, signal)
        } finally {
          if (!completed) {
            try {
              await reader.cancel()
            } catch (_streamCancellationFailure) {
              // The primary read outcome owns the result; cancellation is best-effort after early stop.
            }
          }
          reader.releaseLock()
        }
      },
    }
  }

  override async ensureDirectory(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    assertNotAborted(opts?.signal, 'ensureDirectory')
    const displayPath = posix.resolve(opts?.cwd ?? this.ctx.cfSandbox.workspaceRoot, path)
    try {
      // `ready` re-clones a remembered project before an empty directory could
      // shadow it (the container's disk is ephemeral).
      await this.ctx.cfSandbox.ready
      await this.ctx.cfSandbox.sandbox.mkdir(displayPath, { recursive: true })
    } catch (error: unknown) {
      throw mapError(error, 'ensureDirectory', displayPath, opts?.signal)
    }
    const target = await this.resolve(displayPath, opts)
    const info = await this.stat(target, opts?.signal)
    if (info?.type !== 'directory') throw new FsError(`${displayPath} exists and is not a directory`, 'FS_NOT_FOUND')
    return target
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'directory') throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    try {
      const listed = await this.ctx.cfSandbox.sandbox.listFiles(String(target.targetKey), { includeHidden: true })
      assertNotAborted(signal, 'list')
      const entries: FsDirEntry[] = []
      for (const entry of listed.files) {
        const displayPath = posix.join(target.displayPath, entry.name)
        if (entry.type === 'symlink') {
          const canonical = await this.canonicalPath(entry.absolutePath, signal)
          const resolved = await this.probe(canonical, displayPath, true, signal)
          const type = resolved === undefined || resolved.type === 'symlink' ? 'other' : resolved.type
          entries.push({
            name: entry.name,
            type,
            target: { targetKey: FsTargetKey(canonical), displayPath },
            ...(resolved !== undefined ? { version: resolved.version } : {}),
            ...(resolved?.type === 'file' ? { size: resolved.size } : {}),
          })
          continue
        }
        entries.push({
          name: entry.name,
          type: entry.type === 'other' ? 'other' : entry.type,
          target: { targetKey: FsTargetKey(entry.absolutePath), displayPath },
          ...(entry.type === 'file' ? { size: entry.size } : {}),
        })
      }
      return entries.sort((left, right) => left.name.localeCompare(right.name))
    } catch (error: unknown) {
      throw mapError(error, 'list', target.displayPath, signal)
    }
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), target.displayPath, true, signal)
      if (existing !== undefined && existing.type !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      this.checkWriteIntent(existing, expected, target)
      const before = existing === undefined ? null : await this.readForDiff(target, signal)
      const version = await this.writeAtomic(target, content, existing, expected?.kind === 'createIfAbsent', signal)
      return {
        operation: existing === undefined ? 'create' : 'update',
        version,
        before,
        after: normalizeLineEndings(content),
      }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), target.displayPath, true, signal)
      if (existing === undefined) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      if (existing.type !== 'file') {
        throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected !== undefined && existing.version !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const raw = await this.readForEdit(target, signal)
      const before = normalizeLineEndings(raw)
      const after = literalEdit(before, edit, target.displayPath)
      const storage = restoreLineEndings(after, detectsCrlf(raw))
      const version = await this.writeAtomic(target, storage, existing, false, signal)
      return { version, before, after }
    })
  }

  private async withLock<T>(targetKey: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(targetKey) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(targetKey, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(targetKey) === tail) this.locks.delete(targetKey)
    }
  }

  /** Run one container command; a nonzero exit throws its stderr. */
  private async command(argv: readonly [string, ...string[]], signal?: AbortSignal): Promise<string> {
    assertNotAborted(signal, argv[0])
    const result = await this.ctx.cfSandbox.run(argv, { timeoutMs: this.config.commandTimeoutMs })
    assertNotAborted(signal, argv[0])
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `${argv[0]} exited with ${String(result.exitCode)}`)
    return result.stdout
  }

  /** Canonicalize a path with `realpath -mz`; the NUL terminator frames paths containing newlines. */
  private async canonicalPath(path: string, signal?: AbortSignal): Promise<string> {
    const stdout = await this.command(['realpath', '-mz', '--', path], signal)
    if (!stdout.endsWith('\0') || stdout.slice(0, -1).includes('\0')) {
      throw new Error('fs-cf-sandbox: realpath returned invalid NUL framing')
    }
    const canonical = stdout.slice(0, -1)
    if (!posix.isAbsolute(canonical)) throw new Error('fs-cf-sandbox: canonical path is not absolute')
    return canonical
  }

  /** `stat` one path; `follow` selects `-L`. Returns undefined for an absent path. */
  private async probe(path: string, displayPath: string, follow: boolean, signal?: AbortSignal): Promise<StatRecord | undefined> {
    assertNotAborted(signal, 'stat')
    const argv: [string, ...string[]] = follow
      ? ['stat', '-L', '-c', STAT_FORMAT, '--', path]
      : ['stat', '-c', STAT_FORMAT, '--', path]
    const result = await this.ctx.cfSandbox.run(argv, { timeoutMs: this.config.commandTimeoutMs })
    assertNotAborted(signal, 'stat')
    if (result.exitCode !== 0) {
      if (/no such file or directory/i.test(result.stderr)) return undefined
      throw mapError(new Error(result.stderr.trim()), 'stat', displayPath, signal)
    }
    return parseStat(result.stdout, path)
  }

  private async requireRegular(target: FsTarget, signal?: AbortSignal): Promise<FsInfo> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    return info
  }

  /**
   * Open the file as decoded bytes. The SDK's `readFileStream` carries a
   * server-sent-event envelope (metadata, chunks, completion); `streamFile`
   * decodes it into text or binary chunks, which this stream re-encodes as bytes.
   */
  private async openReadStream(target: FsTarget, signal: AbortSignal | undefined): Promise<ReadableStream<Uint8Array>> {
    assertNotAborted(signal, 'read')
    let envelope: ReadableStream<Uint8Array>
    try {
      envelope = await this.ctx.cfSandbox.sandbox.readFileStream(String(target.targetKey))
    } catch (error: unknown) {
      throw mapError(error, 'read', target.displayPath, signal)
    }
    const chunks = streamFile(envelope)
    const encoder = new TextEncoder()
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await chunks.next()
        if (next.done) {
          controller.close()
          return
        }
        controller.enqueue(typeof next.value === 'string' ? encoder.encode(next.value) : next.value)
      },
      async cancel() {
        await chunks.return(undefined as never)
      },
    })
  }

  /**
   * Collect the whole file through the SDK stream. `maxBytes` stops a
   * post-stat grower without transferring past the first overflowing chunk.
   */
  private async readAll(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number | undefined): Promise<Uint8Array> {
    const stream = await this.openReadStream(target, signal)
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    let completed = false
    try {
      while (true) {
        assertNotAborted(signal, 'read')
        const next = await reader.read()
        if (next.done) break
        bytes += next.value.byteLength
        if (maxBytes !== undefined && bytes > maxBytes) {
          throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
        }
        chunks.push(next.value)
      }
      completed = true
    } finally {
      if (!completed) {
        try {
          await reader.cancel()
        } catch (_streamCancellationFailure) {
          // The read already failed; a cancellation failure on the abandoned
          // container stream adds nothing actionable for the caller.
        }
      }
      reader.releaseLock()
    }
    return concat(chunks, bytes)
  }

  private checkWriteIntent(existing: StatRecord | undefined, expected: FsWriteIntent | undefined, target: FsTarget): void {
    if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (existing === undefined || existing.version !== expected.version) {
        throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
    }
  }

  private async readForDiff(target: FsTarget, signal?: AbortSignal): Promise<string | null> {
    try {
      const bytes = await this.readAll(target, signal, undefined)
      return normalizeLineEndings(decodeText(bytes, target.displayPath, bytes.length))
    } catch (error: unknown) {
      if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return null
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  private async readForEdit(target: FsTarget, signal?: AbortSignal): Promise<string> {
    try {
      const bytes = await this.readAll(target, signal, undefined)
      return decodeText(bytes, target.displayPath, bytes.length)
    } catch (error: unknown) {
      throw mapError(error, 'edit', target.displayPath, signal)
    }
  }

  /**
   * Stage the content in a private sibling directory, then publish it with one
   * `rename` (or a hard `ln -T` for a guarded create, which fails when the
   * target appeared meanwhile). The committed file's `stat` yields the version.
   */
  private async writeAtomic(
    target: FsTarget,
    content: string,
    existing: StatRecord | undefined,
    createIfAbsent: boolean,
    signal?: AbortSignal,
  ): Promise<FsVersion> {
    assertNotAborted(signal, 'write')
    const { sandbox } = this.ctx.cfSandbox
    const targetPath = String(target.targetKey)
    const stagingDirectory = posix.join(posix.dirname(targetPath), `.dsh-${randomUUID()}.tmp`)
    const temporary = posix.join(stagingDirectory, 'content')
    let stagingDirectoryCreated = false
    try {
      const created = await sandbox.mkdir(stagingDirectory)
      if (!created.success) throw new Error('private staging directory could not be created')
      stagingDirectoryCreated = true
      await this.command(['chmod', '700', '--', stagingDirectory], signal)
      const written = await sandbox.writeFile(temporary, content, { encoding: 'utf-8' })
      if (!written.success) throw new Error('staged content could not be written')
      assertNotAborted(signal, 'write')
      const mode = existing === undefined ? 0o600 : existing.mode & 0o777
      await this.command(['chmod', mode.toString(8), '--', temporary], signal)
      if (createIfAbsent) {
        const publication = await this.ctx.cfSandbox.run(['ln', '-T', '--', temporary, targetPath], { timeoutMs: this.config.commandTimeoutMs })
        if (publication.exitCode !== 0) {
          const present = await sandbox.exists(targetPath)
          if (present.exists) {
            throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
          }
          throw new Error(publication.stderr.trim() || 'guarded create failed')
        }
      } else {
        await this.command(['mv', '-f', '-T', '--', temporary, targetPath], undefined)
      }
      try {
        await this.command(['rm', '-rf', '--', stagingDirectory], undefined)
      } catch (_committedStagingCleanupFailure) {
        // The target is already committed; a leftover private directory cannot turn that write into a failure.
      }
      const committed = await this.probe(targetPath, target.displayPath, true, undefined)
      if (committed === undefined) throw new Error('published file is absent after commit')
      return committed.version
    } catch (error: unknown) {
      if (stagingDirectoryCreated) {
        try {
          await this.command(['rm', '-rf', '--', stagingDirectory], undefined)
        } catch (_stagingDirectoryCleanupFailed) {
          // Only the private staging directory is swallowed; the original failure owns the operation.
        }
      }
      throw mapError(error, 'write', target.displayPath, signal)
    }
  }
}

export default CfSandboxFileSystem
