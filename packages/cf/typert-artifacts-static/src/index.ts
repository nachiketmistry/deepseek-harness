/**
 * @deepseek-ai/dsh-typert-artifacts-static — the typert artifact source over
 * a build-time table: each composed package's `./typert` module, imported by
 * the host build and keyed by package name. Mount through the host's
 * `prepare` step; it is never a row.
 * @module @deepseek-ai/dsh-typert-artifacts-static
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertArtifactSource } from '@deepseek-ai/dsh-typert-loader'

/** Artifact module namespaces by package name. */
export type StaticTypertArtifactTable = ReadonlyMap<string, Record<string, unknown>>

/** The table-backed source. */
export class StaticTypertArtifactSource extends TypertArtifactSource {
  /**
   * @param ctx - the tree's root context.
   * @param table - artifact modules by package name.
   */
  constructor(ctx: Context, private readonly table: StaticTypertArtifactTable) {
    super(ctx)
  }

  override load(packageName: string): Promise<Record<string, unknown> | undefined> {
    return Promise.resolve(this.table.get(packageName))
  }
}

export default StaticTypertArtifactSource
