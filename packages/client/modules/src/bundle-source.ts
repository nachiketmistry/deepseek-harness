/**
 * The client-bundle-source Service Definition: where the node half finds a
 * package's `dsh.client` declaration and its built browser bundle. The Node
 * provider (`@deepseek-ai/dsh-client-bundle-source-node`) resolves packages
 * through the Loader and `node_modules`; a platform provider answers from a
 * build-time manifest and its asset store. The registry consumes only this
 * contract, so scanning, graph composition, and bundle serving never touch a
 * filesystem.
 * @module @deepseek-ai/dsh-client-modules/bundle-source
 */

import { Context, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Where client bundles and their declarations come from (provided by a bundle-source Service Provider). */
    clientBundleSource: ClientBundleSource
  }
}

/** The declared fields a graph row carries, normalized (absent array declarations become empty). */
export interface ClientBundleDeclaration {
  /** Client plugin names injected before this one (`dsh.client.inject`). */
  inject?: string[]
  /** Module specifiers the package requests from the module table (`dsh.client.external`). */
  external: string[]
  /** Boot phase-one registration barrier (`dsh.client.immediately`). */
  immediately: boolean
}

/** One resolved browser package: its identity, its declaration, and where its bundle lives. */
export interface ResolvedClientBundle {
  /** Manifest name of the package that owns the browser module. */
  packageName: string
  /** The package's normalized `dsh.client` declaration. */
  declaration: ClientBundleDeclaration
  /**
   * Source-owned locator for this package's bundle, passed back to
   * {@link ClientBundleSource.snapshot} and friends. The registry never
   * interprets it; the Node provider uses the bundle's absolute path.
   */
  location: string
}

/** Filesystem baseline captured before a client artifact snapshot is read. */
export interface ClientArtifactBaseline {
  /** Absolute path of the client bundle, or the source's locator when it has no file. */
  readonly path: string
  /** Bundle modification time in milliseconds; zero when the source has no mutable artifact. */
  readonly mtimeMs: number
  /** Bundle size in bytes. */
  readonly size: number
}

/** One authored source map, retained as bytes plus its parsed object. */
export interface ClientSourceMapSnapshot {
  /** The map bytes exactly as stored. */
  body: Buffer
  /** The parsed Source Map v3 object. */
  parsed: Record<string, unknown>
}

/** One bundle read, with the baseline captured before its bytes. */
export interface ClientBundleSnapshot {
  /** The built bundle. */
  bundle: Buffer
  /** The baseline captured before the bytes were read. */
  baseline: ClientArtifactBaseline
}

/** Recovery instruction shared by grouped startup and steady-state bundle diagnostics. */
export const CLIENT_BUNDLE_BUILD_INSTRUCTION = 'run `pnpm run build` before launch'

/** A declared client bundle whose bytes are absent, retained as structured data for activation-error grouping. */
export class MissingClientBundleError extends Error {
  /**
   * @param packageName - the package that declares the bundle.
   * @param location - where the source looked for it.
   * @param cause - the underlying read failure.
   */
  constructor(
    readonly packageName: string,
    readonly location: string,
    cause: unknown,
  ) {
    super(
      [
        `client-modules: client bundle not found; ${CLIENT_BUNDLE_BUILD_INSTRUCTION}:`,
        `  package: ${packageName}`,
        `  path: ${location}`,
      ].join('\n'),
      { cause },
    )
  }
}

/**
 * Declarations and bytes of web client bundles.
 *
 * Verdicts are permanent for a process: a Loader row that is not a web client
 * package stays one, so the registry caches `resolve` results per row and
 * re-reads only bytes.
 */
export abstract class ClientBundleSource extends Service {
  constructor(ctx: Context) {
    super(ctx, 'clientBundleSource')
  }

  /**
   * The browser package one Loader row contributes, if any.
   * @param loaderName - module specifier of the loader row.
   * @param baseUrl - resolution base of the tree that owns the row.
   * @returns the resolved package, or `undefined` when the row resolves to no
   * package root or declares no web client bundle.
   * @throws when the declaration is malformed or names no `./client` export.
   */
  abstract resolve(loaderName: string, baseUrl: string): ResolvedClientBundle | undefined

  /**
   * The bundle's current bytes and the baseline captured before reading them.
   * Synchronous because the activation scan that hashes every bundle runs
   * inside plugin construction.
   * @param packageName - the owning package, for the absent-bundle diagnostic.
   * @param location - a locator {@link resolve} returned.
   * @returns the bundle and its baseline.
   * @throws {MissingClientBundleError} when the bundle is absent.
   */
  abstract snapshot(packageName: string, location: string): ClientBundleSnapshot

  /**
   * The bundle's authored source map.
   * @param location - a locator {@link resolve} returned.
   * @returns the map, or `undefined` when the source has none.
   * @throws when a present map is not a regular Source Map v3 object.
   */
  abstract readSourceMap(location: string): ClientSourceMapSnapshot | undefined

  /**
   * The path a rebuild watcher polls for this bundle.
   * @param location - a locator {@link resolve} returned.
   * @returns the absolute path, or `undefined` when no file backs the bundle.
   */
  abstract watchPath(location: string): string | undefined
}
