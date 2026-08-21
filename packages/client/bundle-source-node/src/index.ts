/**
 * @deepseek-ai/dsh-client-bundle-source-node — the Node Service Provider for
 * the client-bundle source: resolves a package's `package.json` through
 * `node_modules` from the config-tree anchor (`ctx.baseUrl`, the `cordis.yml`
 * directory whose package declares every composed plugin as a dependency),
 * reads its `dsh.client` declaration and `exports["./client"]`, and serves the
 * built bundle and source map from disk.
 * @module @deepseek-ai/dsh-client-bundle-source-node
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  ClientBundleSource,
  clientExportOf,
  MissingClientBundleError,
  parseClientDeclaration,
  type ClientBundleDescription,
} from '@deepseek-ai/dsh-client-modules'

/** One resolved web client package: its declaration and bundle path. */
interface ResolvedPackage {
  description: ClientBundleDescription
  clientPath: string
}

/** The `node_modules`-backed bundle source. */
export class NodeClientBundleSource extends ClientBundleSource {
  private readonly resolvePkgJson: (spec: string) => string
  // Verdicts are permanent for the process: plugin-set changes take effect on restart.
  private readonly resolved = new Map<string, ResolvedPackage | null>()

  constructor(ctx: Context) {
    super(ctx)
    // Resolution anchor: the config tree's baseUrl. This package's own URL
    // would miss sibling packages under pnpm's isolated node_modules.
    if (ctx.baseUrl === undefined) {
      throw new Error('client-bundle-source-node: ctx.baseUrl is unset — the config-tree anchor is what resolves plugin packages')
    }
    const require = createRequire(ctx.baseUrl)
    this.resolvePkgJson = spec => require.resolve(`${spec}/package.json`)
  }

  /** @inheritdoc */
  override describe(packageName: string): ClientBundleDescription | undefined {
    return this.resolve(packageName)?.description
  }

  /** @inheritdoc */
  override read(packageName: string): Uint8Array {
    const clientPath = this.require(packageName).clientPath
    try {
      return new Uint8Array(readFileSync(clientPath))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      throw new MissingClientBundleError(packageName, clientPath, error)
    }
  }

  /** @inheritdoc */
  override async readSourceMap(packageName: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(`${this.require(packageName).clientPath}.map`))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return undefined
    }
  }

  /** @inheritdoc */
  override locate(packageName: string): string | undefined {
    return this.resolve(packageName)?.clientPath
  }

  private require(packageName: string): ResolvedPackage {
    const resolved = this.resolve(packageName)
    if (resolved === undefined) {
      throw new Error(`client-bundle-source-node: ${packageName} is not a web client package`)
    }
    return resolved
  }

  private resolve(packageName: string): ResolvedPackage | undefined {
    const cached = this.resolved.get(packageName)
    if (cached !== undefined) return cached ?? undefined
    let pkgPath: string
    try {
      pkgPath = this.resolvePkgJson(packageName)
    } catch {
      // Not a resolvable package root: loader builtins (cordis:include) and
      // subpath entries (…/gateway) land here — permanently not a client row.
      this.resolved.set(packageName, null)
      return undefined
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
    const dsh = pkg.dsh
    const decl = parseClientDeclaration(
      packageName,
      dsh !== null && typeof dsh === 'object' ? (dsh as Record<string, unknown>).client : undefined,
    )
    if (decl === undefined || decl.platform !== 'web') {
      this.resolved.set(packageName, null)
      return undefined
    }
    const clientRel = clientExportOf(packageName, pkg.exports)
    if (clientRel === undefined) {
      throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`)
    }
    const { platform: _platform, ...description } = decl
    const resolved: ResolvedPackage = { description, clientPath: join(dirname(pkgPath), clientRel) }
    this.resolved.set(packageName, resolved)
    return resolved
  }
}

export default NodeClientBundleSource
