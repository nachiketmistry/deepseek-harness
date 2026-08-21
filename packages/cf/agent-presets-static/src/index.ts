/**
 * @deepseek-ai/dsh-agent-presets-static — the agent preset source over a
 * build-time table: the shipped presets, already composed into literal rows
 * (no `!!js`), embedded in the host artifact. Not authorable: there is no
 * preset directory to copy into. Mount through the host's `prepare` step.
 * @module @deepseek-ai/dsh-agent-presets-static
 */

import type { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  AgentPresetSource,
  PresetNotWritableError,
  UnknownPresetError,
  type AgentPreset,
  type PresetComposition,
} from '@deepseek-ai/dsh-agent-presets'

/** One embedded preset: its metadata and literal composition. */
export interface StaticAgentPreset {
  /** Display name. */
  name?: string
  /** One sentence on what the preset is for. */
  description?: string
  /** Position within the roster. */
  order?: number
  /** The agent-plane rows. */
  rows: EntryOptions[]
  /** The composition's source text, shown by the preset viewer. */
  source: string
}

/** Presets by id. */
export type StaticAgentPresetTable = ReadonlyMap<string, StaticAgentPreset>

/** The table-backed source. Every preset carries `system` trust. */
export class StaticAgentPresetSource extends AgentPresetSource {
  private readonly presets: AgentPreset[]

  /**
   * @param ctx - the tree's root context.
   * @param table - presets by id.
   */
  constructor(ctx: Context, private readonly table: StaticAgentPresetTable) {
    super(ctx)
    this.presets = [...table].map(([id, preset]) => ({
      id,
      trust: 'system',
      path: `static:${id}`,
      ...(preset.name === undefined ? {} : { name: preset.name }),
      ...(preset.description === undefined ? {} : { description: preset.description }),
      ...(preset.order === undefined ? {} : { order: preset.order }),
    }))
  }

  override list(): Promise<AgentPreset[]> {
    return Promise.resolve(this.presets.map(preset => ({ ...preset })))
  }

  override stamp(preset: AgentPreset): Promise<string | undefined> {
    return Promise.resolve(this.table.has(preset.id) ? `static:${preset.id}` : undefined)
  }

  override composition(preset: AgentPreset): Promise<PresetComposition> {
    const entry = this.entry(preset)
    return Promise.resolve({ rows: structuredClone(entry.rows), stamp: `static:${preset.id}` })
  }

  override read(preset: AgentPreset): Promise<string> {
    return Promise.resolve(this.entry(preset).source)
  }

  override get authorable(): boolean {
    return false
  }

  override copy(source: AgentPreset): Promise<void> {
    return Promise.reject(new PresetNotWritableError(source.id, 'the embedded preset table is read-only'))
  }

  override remove(preset: AgentPreset): Promise<void> {
    return Promise.reject(new PresetNotWritableError(preset.id, 'the embedded preset table is read-only'))
  }

  private entry(preset: AgentPreset): StaticAgentPreset {
    const entry = this.table.get(preset.id)
    if (entry === undefined) throw new UnknownPresetError(preset.id, [...this.table.keys()])
    return entry
  }
}

export default StaticAgentPresetSource
