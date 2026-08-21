/** Agent-preset vocabulary shared by sources, mounting, and consumers. */

/**
 * Where a preset's composition came from. A `system` preset ships with the
 * deployment; a `user` preset was authored locally, by a person or by an
 * agent, and therefore carries the same trust as shell access.
 */
export type PresetTrust = 'system' | 'user'

/**
 * Ids a preset may use.
 *
 * A source may turn the id into a path segment, so this is a containment
 * boundary rather than a style rule: `..`, a separator, or an absolute-looking
 * name would place a composition outside the location the deployment
 * authorised. Discovery shares it: a directory whose name no copy could ever
 * claim is not a preset slot.
 */
export const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

/** One preset that carries a mountable agent composition. */
export interface AgentPreset {
  /** Stable identifier; for a filesystem source, the preset directory's name. */
  readonly id: string
  /** Trust recorded from the location this preset was supplied from. */
  readonly trust: PresetTrust
  /**
   * Source-owned locator of the preset's composition. The filesystem source
   * stores the absolute path of the composition file; another source may use
   * a non-file locator, and a host that opens preset documents then reports
   * `opened: false` with it rather than treating it as a directory.
   */
  readonly path: string
  /** Display name from the preset's own metadata; absent falls back to {@link id}. */
  readonly name?: string
  /** One sentence on what this preset is for, when it published one. */
  readonly description?: string
  /** Declared position within its group; absent sorts after those that declare one. */
  readonly order?: number
  /**
   * Why this preset cannot compose a session, absent when it can. A broken
   * preset stays on the roster — hiding it would leave its directory blocking
   * the id with nothing to see or delete — but every mounting path refuses it
   * up front with this reason instead of failing deep inside the loader.
   */
  readonly broken?: string
}

/** Plugin config: which preset is the default. Where presets live is the source's config. */
export interface Config {
  /** Preset id mounted when a caller names none. Missing at mount time fails loud. */
  default: string
}

/**
 * The source supplies no preset under the requested id.
 *
 * Separate from a mount failure because the two mean different things to a
 * caller: an unknown id is a bad request, while an unusable composition is a
 * broken preset the deployment must fix.
 */
export class UnknownPresetError extends Error {
  constructor(
    /** The id that was requested. */
    readonly presetId: string,
    /** Ids the roster does supply, for the caller to offer instead. */
    readonly available: readonly string[],
  ) {
    super(`agent-presets: preset "${presetId}" not found (available: ${available.join(', ') || 'none'})`)
  }
}

/** A preset exists but its composition cannot be installed. */
export class PresetMountError extends Error {
  constructor(
    /** The preset whose composition failed. */
    readonly presetId: string,
    /** Why it failed, without this package's own message prefix. */
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`agent-presets: preset "${presetId}" failed to mount: ${reason}`, options)
  }
}

/** A preset id that cannot be used as a location name under a source. */
export class InvalidPresetIdError extends Error {
  constructor(
    /** The rejected id. */
    readonly presetId: string,
  ) {
    super(
      `agent-presets: preset id ${JSON.stringify(presetId)} must match ${String(PRESET_ID)} — `
      + 'the id is a directory name, so anything else could escape the preset root',
    )
  }
}

/** A copy target that is already occupied — a copy never overwrites. */
export class PresetExistsError extends Error {
  constructor(
    /** The id that is already taken. */
    readonly presetId: string,
  ) {
    super(
      `agent-presets: preset "${presetId}" already exists — `
      + 'a copy never overwrites; delete the existing preset first or choose another id',
    )
  }
}

/** Authoring was attempted where the deployment allows none. */
export class PresetNotWritableError extends Error {
  constructor(
    /** What the caller tried to change, for the diagnostic. */
    readonly presetId: string,
    reason: string,
  ) {
    super(`agent-presets: preset "${presetId}" cannot be written: ${reason}`)
  }
}
