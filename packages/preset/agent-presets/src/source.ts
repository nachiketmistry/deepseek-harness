/**
 * Service Definition for where one deployment's presets come from.
 *
 * The registry ({@link AgentPresets}) owns the preset vocabulary, the standing
 * mount, and the joins; it never reads a composition itself. A source supplies
 * the roster, the rows each preset mounts, an identity for each preset's
 * current composition, and the authoring writes. The filesystem provider
 * (`@deepseek-ai/dsh-agent-presets-filesystem`) discovers preset directories
 * under configured roots; a host without a disk supplies presets from a
 * bundled table instead.
 * @module @deepseek-ai/dsh-agent-presets/source
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { AgentPreset } from './preset.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentPresetSource: AgentPresetSource
  }
}

/** The rows one preset mounts, read under one composition stamp. */
export interface PresetComposition {
  /**
   * Raw Loader entry options in composition order, `!!js` expression nodes
   * preserved for the Loader to evaluate in each row's own context.
   */
  rows: EntryOptions[]
  /** The {@link AgentPresetSource.stamp} value the rows were read under. */
  stamp: string
  /**
   * Base URL a relative row specifier (`./plugin.js`) resolves against,
   * normally the directory the preset's files sit in. Undefined when the
   * source has no files, in which case a relative specifier cannot resolve.
   */
  baseUrl?: string
}

/**
 * Where one deployment's presets come from and how they are authored.
 *
 * Every method takes a preset the source itself listed: `preset.path` is the
 * source-owned locator (the composition file path for the filesystem source;
 * another source may use a non-file locator) and the registry never
 * interprets it.
 */
export abstract class AgentPresetSource extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agentPresetSource')
  }

  /**
   * Every preset this source supplies, broken ones included (`broken` set).
   * Unmemoized: each call reflects the source's current state.
   * @returns the presets in display order.
   */
  abstract list(): Promise<AgentPreset[]>

  /**
   * Opaque identity of a preset's current composition.
   *
   * A changed value starts a new standing generation for sessions created
   * afterwards; an unreadable composition yields `undefined`, which serves the
   * generation already mounted rather than failing the session.
   * @param preset - a preset this source listed.
   * @returns the stamp, or `undefined` when the composition cannot be read.
   */
  abstract stamp(preset: AgentPreset): Promise<string | undefined>

  /**
   * The rows to mount, the stamp they were read under, and the base URL
   * relative row specifiers resolve against.
   * @param preset - a preset this source listed.
   * @returns the composition.
   * @throws when the composition cannot be read or is not a list of rows.
   */
  abstract composition(preset: AgentPreset): Promise<PresetComposition>

  /**
   * The composition's source text, for the authoring read.
   * @param preset - a preset this source listed.
   * @returns the text exactly as stored.
   */
  abstract read(preset: AgentPreset): Promise<string>

  /** Whether `copy` and `remove` can succeed for some preset (a writable user location exists). */
  abstract get authorable(): boolean

  /**
   * Create a locally authored preset by copying an existing one whole.
   * @param source - the preset the copy starts from; any trust is accepted.
   * @param id - the new preset's id.
   * @param name - display name for the copy; absent falls back to the id.
   * @throws when the id is unusable or already occupied, or the source is not authorable.
   */
  abstract copy(source: AgentPreset, id: string, name?: string): Promise<void>

  /**
   * Delete a locally authored preset.
   * @param preset - a preset this source listed.
   * @throws when the preset ships with the deployment or is not this source's to delete.
   */
  abstract remove(preset: AgentPreset): Promise<void>
}
