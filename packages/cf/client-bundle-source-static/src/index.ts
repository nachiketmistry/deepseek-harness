/**
 * @deepseek-ai/dsh-client-bundle-source-static — the client bundle source
 * over a build-time table. A host whose artifact already carries every
 * browser bundle (a platform Worker) constructs this source with the table
 * its build emitted, so the modules node half never resolves packages at
 * runtime. Mount through the host's `prepare` step; it is never a row.
 * @module @deepseek-ai/dsh-client-bundle-source-static
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  ClientBundleSource,
  type ClientBundleDeclaration,
  type ClientBundleSnapshot,
  type ClientSourceMapSnapshot,
  type ResolvedClientBundle,
} from '@deepseek-ai/dsh-client-modules'

/** One embedded client bundle. */
export interface StaticClientBundle {
  /** The package's `dsh.client` declaration, minus `platform`. */
  declaration: ClientBundleDeclaration
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

  // Every row in a packed composition names a package, so the row specifier IS
  // the table key and the locator; there is nothing to resolve at runtime.
  override resolve(loaderName: string): ResolvedClientBundle | undefined {
    const entry = this.table.get(loaderName)
    if (entry === undefined) return undefined
    return { packageName: loaderName, declaration: entry.declaration, location: loaderName }
  }

  override snapshot(_packageName: string, location: string): ClientBundleSnapshot {
    const bundle = Buffer.from(this.encoder.encode(this.entry(location).code))
    return {
      bundle,
      // The table is immutable for the life of the artifact, so the baseline
      // is a constant: nothing polls it and no write can race a read.
      baseline: { path: this.locator(location), mtimeMs: 0, size: bundle.byteLength },
    }
  }

  override readSourceMap(location: string): ClientSourceMapSnapshot | undefined {
    const map = this.entry(location).map
    if (map === undefined) return undefined
    return { body: Buffer.from(this.encoder.encode(map)), parsed: JSON.parse(map) as Record<string, unknown> }
  }

  /** No file backs an embedded bundle, so no watcher can poll one. */
  override watchPath(): string | undefined {
    return undefined
  }

  private locator(packageName: string): string {
    return `static:${packageName}/client.js`
  }

  private entry(packageName: string): StaticClientBundle {
    const entry = this.table.get(packageName)
    if (entry === undefined) throw new Error(`client-bundle-source-static: ${packageName} is not in the embedded bundle table`)
    return entry
  }
}

export default StaticClientBundleSource
