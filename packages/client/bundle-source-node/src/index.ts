/**
 * @deepseek-ai/dsh-client-bundle-source-node — the Node Service Provider for
 * the client-bundle source: resolves the package a Loader row mounts through
 * the same Loader resolution that imported the row's host half, reads its
 * `dsh.client` declaration and `exports["./client"]`, and serves the built
 * bundle and source map from disk.
 * @module @deepseek-ai/dsh-client-bundle-source-node
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
// Type-only: resolves the Loader whose module resolution this source reuses.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import {
  ClientBundleSource,
  MissingClientBundleError,
  optionalStringArray,
  type ClientBundleDeclaration,
  type ClientBundleSnapshot,
  type ClientSourceMapSnapshot,
  type ResolvedClientBundle,
} from '@deepseek-ai/dsh-client-modules'

/** package.json `dsh.client` declaration fields, validated one by one after reading the file. */
interface DshClientDeclaration extends ClientBundleDeclaration {
  platform: string
}

/** The bare package specifier a row names, or undefined when the row names a subpath or a relative module. */
function exactPackageSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/')
    return parts.length === 2 && parts.every(Boolean) ? specifier : undefined
  }
  return specifier.length > 0 && !specifier.includes('/') ? specifier : undefined
}

/**
 * Narrow an unknown parsed `dsh.client` value, throwing on a malformed field.
 * @param pkgName - the declaring package, for the diagnostic.
 * @param value - the parsed `dsh.client` value, or undefined when absent.
 * @returns the normalized declaration, or undefined when the package declares none.
 */
function parseDshClient(pkgName: string, value: unknown): DshClientDeclaration | undefined {
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

/**
 * Resolve `exports["./client"]` to a relative path.
 * @param pkgName - the declaring package, for the diagnostic.
 * @param exportsField - the manifest's `exports` value.
 * @returns the relative bundle path, or undefined when the package exports no client entry.
 */
function clientExportOf(pkgName: string, exportsField: unknown): string | undefined {
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

/** The `node_modules`-backed bundle source. */
export class NodeClientBundleSource extends ClientBundleSource {
  static inject = ['loader']

  constructor(ctx: Context) {
    super(ctx)
  }

  override resolve(loaderName: string, baseUrl: string): ResolvedClientBundle | undefined {
    const located = this.locatePkgJson(loaderName, baseUrl)
    // Not a resolvable package root: loader builtins (cordis:include) and
    // subpath entries (…/gateway) land here — permanently not a client row.
    if (located === undefined) return undefined
    const { packageName, path: pkgPath } = located
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
    const dsh = pkg.dsh
    const decl = parseDshClient(
      packageName,
      dsh !== null && typeof dsh === 'object' ? (dsh as Record<string, unknown>).client : undefined,
    )
    if (decl === undefined || decl.platform !== 'web') return undefined
    const clientRel = clientExportOf(packageName, pkg.exports)
    if (clientRel === undefined) {
      throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`)
    }
    const { platform: _platform, ...declaration } = decl
    return { packageName, declaration, location: join(dirname(pkgPath), clientRel) }
  }

  override snapshot(packageName: string, location: string): ClientBundleSnapshot {
    try {
      // Stat first: a write landing between the stat and the read leaves the
      // baseline older than the bytes, so the watcher rebuilds rather than
      // trusting a baseline newer than what it hashed.
      const stats = statSync(location)
      const baseline = { path: location, mtimeMs: stats.mtimeMs, size: stats.size }
      return { bundle: readFileSync(location), baseline }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      throw new MissingClientBundleError(packageName, location, error)
    }
  }

  override readSourceMap(location: string): ClientSourceMapSnapshot | undefined {
    let body: Buffer
    try {
      body = readFileSync(`${location}.map`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const value = JSON.parse(body.toString('utf8')) as unknown
    const parsed = typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
    if (
      parsed === undefined
      || parsed.version !== 3
      || !Array.isArray(parsed.sources)
      || parsed.sources.some(source => typeof source !== 'string')
      || !Array.isArray(parsed.names)
      || parsed.names.some(name => typeof name !== 'string')
      || typeof parsed.mappings !== 'string'
    ) {
      throw new Error(`client-modules: ${location}.map is not a regular Source Map v3 object`)
    }
    return { body, parsed }
  }

  override watchPath(location: string): string {
    return location
  }

  /**
   * Locate the manifest of the package the Loader mounts for a row. The row's
   * module location is authoritative: the specifier resolves through the same
   * Loader resolution that imported the row's host half — including any
   * active ESM hooks — and the nearest ancestor manifest declaring the name
   * owns the module. Tree-anchored `require` resolution remains only for
   * runtimes without Node internals.
   * @param loaderName - module specifier of the loader row.
   * @param baseUrl - resolution base of the tree that owns the row.
   * @returns the manifest path, or `undefined` when the name resolves to no package root.
   */
  private locatePkgJson(loaderName: string, baseUrl: string): { path: string; packageName: string } | undefined {
    if (loaderName.startsWith('cordis:')) return undefined
    const pathLike = loaderName.startsWith('.') || loaderName.startsWith('file:') || isAbsolute(loaderName)
    const expectedPackageName = pathLike ? undefined : exactPackageSpecifier(loaderName)
    if (!pathLike && expectedPackageName === undefined) return undefined
    const internal = this.ctx.loader.internal
    if (internal === undefined || typeof Reflect.get(internal, 'resolveSync') !== 'function') {
      if (expectedPackageName === undefined) {
        const moduleUrl = loaderName.startsWith('file:')
          ? loaderName
          : isAbsolute(loaderName) ? pathToFileURL(loaderName).href : new URL(loaderName, baseUrl).href
        return this.nearestPackage(moduleUrl)
      }
      try {
        return {
          path: createRequire(baseUrl).resolve(`${expectedPackageName}/package.json`),
          packageName: expectedPackageName,
        }
      } catch {
        // Without Node internals the owning tree is the only resolver; an
        // unresolvable name is classified exactly as below.
        return undefined
      }
    }
    let moduleUrl: string
    try {
      moduleUrl = internal.version === 'v2'
        ? internal.resolveSync(baseUrl, { specifier: loaderName, attributes: {} }).url
        : internal.resolveSync(loaderName, baseUrl, {}).url
    } catch {
      // The Loader cannot resolve the name: its row cannot have imported, so
      // the name is permanently not a client row.
      return undefined
    }
    return this.nearestPackage(moduleUrl, expectedPackageName)
  }

  /**
   * Walk from a module URL to the nearest ancestor manifest that declares it.
   * @param moduleUrl - the resolved module's URL.
   * @param expectedPackageName - the name the manifest must carry, when the row named a package.
   * @returns the manifest path and name, or undefined when no ancestor owns the module.
   */
  private nearestPackage(
    moduleUrl: string,
    expectedPackageName?: string,
  ): { path: string; packageName: string } | undefined {
    if (!moduleUrl.startsWith('file:')) return undefined
    let dir = dirname(fileURLToPath(moduleUrl))
    for (;;) {
      const candidate = join(dir, 'package.json')
      if (existsSync(candidate)) {
        try {
          const name = (JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown }).name
          if (typeof name === 'string' && (expectedPackageName === undefined || name === expectedPackageName)) {
            return { path: candidate, packageName: name }
          }
        } catch {
          // An unreadable or malformed intermediate manifest cannot own the
          // module; keep walking toward the declaring package root.
        }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return undefined
  }
}

export default NodeClientBundleSource
