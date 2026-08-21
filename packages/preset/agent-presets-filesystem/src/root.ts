/** The root vocabulary of the filesystem preset source. */

import type { PresetTrust } from '@deepseek-ai/dsh-agent-presets'

/** One directory scanned for preset subdirectories. */
export interface PresetRoot {
  /** Directory holding one subdirectory per preset; a leading `~` expands. */
  path: string
  /** Trust recorded on every preset discovered under this root. */
  trust: PresetTrust
}

/** Plugin config: where presets live on disk. */
export interface Config {
  /** Scanned roots in precedence order; an earlier root wins a duplicate id. */
  roots: PresetRoot[]
  /**
   * Append the harness home's `USER_PRESET_DIR` as a `user` root, after every
   * configured root. False supplies presets from `roots` alone.
   */
  includeUserRoot: boolean
}
