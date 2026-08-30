/**
 * Filesystem Service Provider of the agent-preset source seam: presets are
 * directories under configured roots, each holding one `agent.cordis.yml`
 * (and optionally a `preset.yml` with display text), and the harness home's
 * `.agent-presets` is where locally authored presets go.
 *
 * Discovery is unmemoized — every `list()` re-reads the roots — and a
 * composition's identity is its file's stat stamp, so an edit to
 * `agent.cordis.yml` starts the next standing generation in the registry
 * without any authoring call.
 * @module @deepseek-ai/dsh-agent-presets-filesystem
 */

import { readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load } from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { AgentPresetSource, type AgentPreset, type PresetComposition } from '@deepseek-ai/dsh-agent-presets'
import { copyComposition, deleteComposition, readComposition } from './authoring.ts'
import { discoverPresets, SHIPPED_PRESET_ROOT, USER_PRESET_DIR } from './discovery.ts'
import type { Config, PresetRoot } from './root.ts'

export { COMPOSITION_FILE, discoverPresets, scanRoot, SHIPPED_PRESET_ROOT, USER_PRESET_DIR } from './discovery.ts'
export { METADATA_FILE, readPresetMetadata, renderPresetMetadata, type PresetMetadata } from './metadata.ts'
export { copyComposition, deleteComposition, readComposition, writableRoot } from './authoring.ts'
export type { Config, PresetRoot } from './root.ts'

/**
 * Preset source over directories on the local filesystem.
 *
 * `AgentPreset.path` is the absolute path of the preset's composition file;
 * the preset's directory is its parent.
 */
export class FilesystemAgentPresetSource extends AgentPresetSource {
  /** Runtime schema for the roots. */
  static Config = z.object({
    roots: z.array(z.object({
      path: z.string().required(),
      trust: z.union(['system', 'user'] as const).default('user'),
    })).default([]),
    includeShippedRoot: z.boolean().default(true),
    includeUserRoot: z.boolean().default(true),
  }) as z<Config>

  /**
   * The roots discovery and authoring actually scan: this package's shipped
   * root unless `includeShippedRoot` is false, every configured root in order,
   * then the harness-home user root unless `includeUserRoot` is false.
   *
   * Derived once, because a root set that changed between `list()` and the
   * `copy()` acting on its answer would author into a directory the caller
   * never saw. The shipped root comes FIRST and the user root LAST because an
   * earlier root wins a duplicate id: a shipped preset shadows any directory
   * that claimed its name, and a configured root still shadows a locally
   * authored one.
   */
  readonly roots: readonly PresetRoot[]

  /**
   * Where a row's package name resolves from: the base URL of the composition
   * this source was loaded by, which is inside the installed harness.
   *
   * Health needs it because a preset's own directory is the wrong base for a
   * package name — a locally authored preset lives under the user's home,
   * where Node's upward `node_modules` walk never reaches the harness's
   * dependencies. The mount resolves rows the same way; holding the same base
   * here is what lets health answer the question before a session does.
   */
  private readonly harnessBase: string

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    if (ctx.baseUrl === undefined) {
      // Self-contained misconfiguration, so it fails at load: without a base
      // this source cannot tell a healthy preset from one naming a package
      // that is gone, and the silent alternative is the exact failure the
      // health check exists to report.
      throw new Error(
        'agent-presets-filesystem: the source needs `ctx.baseUrl` to resolve the plugins a composition names; '
        + 'compose it under a Loader, or set the base on the context this plugin is applied to',
      )
    }
    this.harnessBase = ctx.baseUrl
    this.roots = [
      ...config.includeShippedRoot ? [{ path: SHIPPED_PRESET_ROOT, trust: 'system' } satisfies PresetRoot] : [],
      ...config.roots,
      ...config.includeUserRoot ? [{ path: dshHomePath(USER_PRESET_DIR), trust: 'user' } satisfies PresetRoot] : [],
    ]
  }

  override async list(): Promise<AgentPreset[]> {
    return await discoverPresets(this.roots, this.harnessBase)
  }

  override async stamp(preset: AgentPreset): Promise<string | undefined> {
    try {
      return await fileStamp(preset.path)
    } catch {
      // Deleted, replaced by an unreadable entry, or otherwise unstattable all
      // mean the same to the registry: the file offers no identity to compare.
      return undefined
    }
  }

  // Stamped BEFORE the file is read, so an edit racing the read leaves the
  // stamp stale rather than silently current.
  override async composition(preset: AgentPreset): Promise<PresetComposition> {
    const stamp = await fileStamp(preset.path)
    const rows: unknown = load(await readFile(preset.path, 'utf8'), { schema: entryListSchema })
    if (!Array.isArray(rows)) {
      throw new Error(`the composition ${preset.path} must be a top-level list of plugin rows`)
    }
    return {
      rows: rows as EntryOptions[],
      stamp,
      baseUrl: pathToFileURL(dirname(preset.path)).href + '/',
    }
  }

  override async read(preset: AgentPreset): Promise<string> {
    return await readComposition(preset)
  }

  override get authorable(): boolean {
    return this.roots.some(root => root.trust === 'user')
  }

  override async copy(source: AgentPreset, id: string, name?: string): Promise<void> {
    await copyComposition(this.roots, source, id, name)
  }

  override async remove(preset: AgentPreset): Promise<void> {
    await deleteComposition(this.roots, preset)
  }
}

/**
 * One file's identity: modification time and size, the size being the
 * tiebreak for edits within one mtime tick.
 * @param path - the file to stat.
 * @returns the stamp string.
 * @throws when the file cannot be statted.
 */
async function fileStamp(path: string): Promise<string> {
  const { mtimeMs, size } = await stat(path)
  return `${String(mtimeMs)}:${String(size)}`
}

export default FilesystemAgentPresetSource
