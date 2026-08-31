/**
 * An in-memory `AgentPresetSource` for the registry's own tests: presets are
 * rows in a table, a composition's stamp is a counter the test bumps to
 * simulate an edit, and authoring copies or deletes table entries. It is what
 * a disk-free host's source looks like, which is why the registry tests run
 * over it rather than over the filesystem provider.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load } from 'js-yaml'
import type { Context } from '@deepseek-ai/cordis'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  AgentPresetSource, InvalidPresetIdError, PRESET_ID, PresetExistsError, PresetNotWritableError,
  type AgentPreset, type PresetComposition, type PresetTrust,
} from '@deepseek-ai/dsh-agent-presets'

/** One table entry: a preset plus the rows it mounts. */
export interface MemoryPreset {
  id: string
  trust: PresetTrust
  rows: EntryOptions[]
  /** Base URL the rows' relative specifiers resolve against. */
  baseUrl?: string
  name?: string
  description?: string
  broken?: string
  /** Bumped by {@link MemoryPresetSource.edit}; undefined makes `stamp()` answer undefined. */
  stamp: number | undefined
  /** When true, `composition()` rejects as an unreadable source would. */
  unreadable?: boolean
}

/** The composition text a table entry renders for `read()`. */
const COMPOSITION_TEXT = (entry: MemoryPreset): string => JSON.stringify(entry.rows, null, 2) + '\n'

/** Plugin config of {@link MemoryPresetSource}. */
export interface MemorySourceConfig {
  entries: readonly Omit<MemoryPreset, 'stamp'>[]
  /** False makes `authorable` false and every `copy` refuse. */
  writable?: boolean
}

/** Preset source over a mutable in-memory table. */
export class MemoryPresetSource extends AgentPresetSource {
  readonly table = new Map<string, MemoryPreset>()
  private readonly writable: boolean

  constructor(ctx: Context, config: MemorySourceConfig) {
    super(ctx)
    this.writable = config.writable ?? true
    for (const entry of config.entries) this.table.set(entry.id, { ...entry, stamp: 1 })
  }

  /** Replace one preset's rows and bump its stamp, as an edit on disk would. */
  edit(id: string, rows: EntryOptions[]): void {
    const entry = this.table.get(id)
    if (entry === undefined) throw new Error(`no such memory preset: ${id}`)
    entry.rows = rows
    entry.stamp = (entry.stamp ?? 0) + 1
  }

  private presetOf(entry: MemoryPreset): AgentPreset {
    return {
      id: entry.id,
      trust: entry.trust,
      path: `memory:${entry.id}`,
      ...entry.name === undefined ? {} : { name: entry.name },
      ...entry.description === undefined ? {} : { description: entry.description },
      ...entry.broken === undefined ? {} : { broken: entry.broken },
    }
  }

  override list(): Promise<AgentPreset[]> {
    return Promise.resolve([...this.table.values()].map(entry => this.presetOf(entry)))
  }

  override stamp(preset: AgentPreset): Promise<string | undefined> {
    const stamp = this.table.get(preset.id)?.stamp
    return Promise.resolve(stamp === undefined ? undefined : String(stamp))
  }

  override composition(preset: AgentPreset): Promise<PresetComposition> {
    const entry = this.table.get(preset.id)
    if (entry === undefined || entry.stamp === undefined || entry.unreadable === true) {
      return Promise.reject(new Error(`memory preset ${preset.id} cannot be read`))
    }
    return Promise.resolve({
      rows: entry.rows,
      stamp: String(entry.stamp),
      ...entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl },
    })
  }

  override read(preset: AgentPreset): Promise<string> {
    const entry = this.table.get(preset.id)
    if (entry === undefined) return Promise.reject(new Error(`memory preset ${preset.id} cannot be read`))
    return Promise.resolve(COMPOSITION_TEXT(entry))
  }

  override get authorable(): boolean {
    return this.writable
  }

  override copy(source: AgentPreset, id: string, name?: string): Promise<void> {
    if (!this.writable) return Promise.reject(new PresetNotWritableError(id, 'this source is read-only'))
    if (!PRESET_ID.test(id)) return Promise.reject(new InvalidPresetIdError(id))
    if (this.table.has(id)) return Promise.reject(new PresetExistsError(id))
    const from = this.table.get(source.id)
    if (from === undefined) return Promise.reject(new Error(`memory preset ${source.id} vanished`))
    this.table.set(id, {
      ...from, id, trust: 'user', stamp: 1,
      ...name === undefined ? {} : { name },
    })
    return Promise.resolve()
  }

  override remove(preset: AgentPreset): Promise<void> {
    if (preset.trust !== 'user') return Promise.reject(new PresetNotWritableError(preset.id, 'it ships with the deployment'))
    this.table.delete(preset.id)
    return Promise.resolve()
  }
}

/**
 * Load one fixture preset directory's composition into a table entry, so the
 * committed `agent.cordis.yml` fixtures stay the single statement of each
 * preset's rows.
 * @param root - the fixture root (`system` or `user`).
 * @param id - the preset directory.
 * @param trust - the trust the entry carries.
 * @returns the table entry, rows parsed in the loader dialect.
 */
export function fixturePreset(root: string, id: string, trust: PresetTrust): Omit<MemoryPreset, 'stamp'> {
  const directory = join(root, id)
  const rows = load(readFileSync(join(directory, 'agent.cordis.yml'), 'utf8'), { schema: entryListSchema }) as EntryOptions[]
  return { id, trust, rows, baseUrl: pathToFileURL(directory).href + '/' }
}

/** One-row entry whose single `contribute.js` tool is named `tool`. */
export function toolPreset(
  id: string, plugin: string, tool: string, trust: PresetTrust = 'user',
): Omit<MemoryPreset, 'stamp'> {
  return { id, trust, rows: [{ id: 'only', name: plugin, config: { tool } }], baseUrl: pathToFileURL(dirname(plugin)).href + '/' }
}
