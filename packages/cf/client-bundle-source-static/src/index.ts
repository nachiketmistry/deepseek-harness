/**
 * @deepseek-ai/dsh-client-bundle-source-static — the client bundle source
 * over a build-time table. A host whose artifact already carries every
 * browser bundle (a platform Worker) constructs this source with the table
 * its build emitted, so the modules node half never resolves packages at
 * runtime. Mount through the host's `prepare` step; it is never a row.
 * @module @deepseek-ai/dsh-client-bundle-source-static
 */

import type { Context } from '@deepseek-ai/cordis'
import { ClientBundleSource, type ClientBundleDescription } from '@deepseek-ai/dsh-client-modules'

/** One embedded client bundle. */
export interface StaticClientBundle {
  /** The package's `dsh.client` declaration, minus `platform`. */
  description: ClientBundleDescription
  /** The bundle source text. */
  code: string
  /** The source map text, when the build carried it. */
  map?: string
}

/** Client bundles by package name. */
export type StaticClientBundleTable = ReadonlyMap<string, StaticClientBundle>

/** The table-backed source. */
export class StaticClientBundleSource extends ClientBundleSource {
  private readonly encoder = new TextEncoder()

  /**
   * @param ctx - the tree's root context.
   * @param table - client bundles by package name.
   */
  constructor(ctx: Context, private readonly table: StaticClientBundleTable) {
    super(ctx)
  }

  override describe(packageName: string): ClientBundleDescription | undefined {
    return this.table.get(packageName)?.description
  }

  override read(packageName: string): Uint8Array {
    return this.encoder.encode(this.entry(packageName).code)
  }

  override readSourceMap(packageName: string): Promise<Uint8Array | undefined> {
    const map = this.entry(packageName).map
    return Promise.resolve(map === undefined ? undefined : this.encoder.encode(map))
  }

  override locate(packageName: string): string | undefined {
    return this.table.has(packageName) ? `static:${packageName}/client.js` : undefined
  }

  private entry(packageName: string): StaticClientBundle {
    const entry = this.table.get(packageName)
    if (entry === undefined) throw new Error(`client-bundle-source-static: ${packageName} is not in the embedded bundle table`)
    return entry
  }
}

export default StaticClientBundleSource
