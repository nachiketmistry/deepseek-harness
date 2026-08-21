/**
 * The client-bundle-source Service Definition: where the node half finds a
 * package's `dsh.client` declaration and its built browser bundle. The Node
 * provider (`@deepseek-ai/dsh-client-bundle-source-node`) resolves packages
 * through `node_modules`; a platform provider answers from a build-time
 * manifest and its asset store. The registry consumes only this contract, so
 * scanning, graph composition, and bundle serving never touch a filesystem.
 * @module @deepseek-ai/dsh-client-modules/bundle-source
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { optionalStringArray } from './client/manifest.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Where client bundles and their declarations come from (provided by a bundle-source Service Provider). */
    clientBundleSource: ClientBundleSource
  }
}

/** The declared fields a graph row carries, normalized (absent array declarations become empty). */
export interface ClientBundleDescription {
  /** Client plugin names injected before this one (`dsh.client.inject`). */
  inject?: string[]
  /** Module specifiers the package requests from the module table (`dsh.client.external`). */
  external: string[]
  /** Boot phase-one prefetch mark (`dsh.client.immediately`). */
  immediately: boolean
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
 * Declarations and bytes of web client bundles, by package name. Verdicts are
 * permanent for a process: a package that is not a web client package stays
 * one, so the registry caches `describe` results and re-reads only bytes.
 */
export abstract class ClientBundleSource extends Service {
  constructor(ctx: Context) {
    super(ctx, 'clientBundleSource')
  }

  /**
   * The package's web client declaration.
   * @param packageName - a Loader entry name.
   * @returns the normalized declaration, or undefined when the name is not a
   * resolvable package or declares no web client bundle.
   * @throws when the declaration is malformed or names no bundle.
   */
  abstract describe(packageName: string): ClientBundleDescription | undefined

  /**
   * The bundle's current bytes. Synchronous because the activation scan that
   * hashes every bundle runs inside plugin construction.
   * @param packageName - a package `describe` accepted.
   * @returns the built bundle.
   * @throws {MissingClientBundleError} when the bundle is absent.
   */
  abstract read(packageName: string): Uint8Array

  /**
   * The bundle's source map bytes.
   * @param packageName - a package `describe` accepted.
   * @returns the map, or undefined when the source has none.
   */
  abstract readSourceMap(packageName: string): Promise<Uint8Array | undefined>

  /**
   * A file-backed source's bundle path, for a watcher that polls it.
   * @param packageName - a package `describe` accepted.
   * @returns the absolute path, or undefined when the source has no file behind the bundle.
   */
  abstract locate(packageName: string): string | undefined
}

/** Narrow an unknown parsed JSON value to the `dsh.client` declaration, throwing on malformed fields. */
export function parseClientDeclaration(pkgName: string, value: unknown): ClientBundleDescription & { platform: string } | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) {
    throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`)
  }
  const decl = value as Record<string, unknown>
  if (typeof decl.platform !== 'string') {
    throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`)
  }
  const inject = optionalStringArray(pkgName, 'dsh.client.inject', decl.inject)
  const external = optionalStringArray(pkgName, 'dsh.client.external', decl.external)
  if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') {
    throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`)
  }
  return {
    platform: decl.platform,
    ...(inject !== undefined ? { inject } : {}),
    external: external ?? [],
    immediately: decl.immediately === true,
  }
}

/** Resolve `exports["./client"]` to a relative path, accepting the string and one-level conditional forms. */
export function clientExportOf(pkgName: string, exportsField: unknown): string | undefined {
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const client = (exportsField as Record<string, unknown>)['./client']
  if (client === undefined) return undefined
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null) {
    const fallback = (client as Record<string, unknown>).default
    if (typeof fallback === 'string') return fallback
  }
  throw new Error(`client-modules: ${pkgName} exports["./client"] must be a string or an object with a string default`)
}
