/** Node bundle source: `node_modules` resolution from `ctx.baseUrl`, declaration parsing, and disk reads. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { MissingClientBundleError } from '@deepseek-ai/dsh-client-modules'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeClientBundleSource } from '../src/index.ts'
import * as BundleSourceInvariant from '../src/invariant.ts'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** Create a resolvable package under the fixture's `node_modules` and return its client bundle path. */
function writePackage(packageName: string, manifest: Record<string, unknown>): string {
  root ??= realpathSync(mkdtempSync(join(tmpdir(), 'dsh-bundle-source-node-')))
  const pkgRoot = join(root, 'node_modules', ...packageName.split('/'))
  mkdirSync(pkgRoot, { recursive: true })
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: packageName, ...manifest }))
  return join(pkgRoot, 'lib', 'client.js')
}

/** A web client package manifest with the `./client` export in the supplied form. */
const webManifest = (
  client: Record<string, unknown> = {},
  clientExport: unknown = './lib/client.js',
): Record<string, unknown> => ({
  dsh: { client: { platform: 'web', ...client } },
  exports: { './client': clientExport, './package.json': './package.json' },
})

/** Create a built web client package and return its bundle path. */
function writeBuiltPackage(packageName: string, client: Record<string, unknown> = {}, bundle = 'module.exports = {}\n'): string {
  const clientPath = writePackage(packageName, webManifest(client))
  mkdirSync(dirname(clientPath), { recursive: true })
  writeFileSync(clientPath, bundle)
  return clientPath
}

/** Construct the source anchored at the fixture root. */
function construct(): NodeClientBundleSource {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root!).href + '/'
  return new NodeClientBundleSource(ctx)
}

describe('NodeClientBundleSource', () => {
  it('requires the config-tree anchor', () => {
    expect(() => new NodeClientBundleSource(new Context()))
      .toThrow('client-bundle-source-node: ctx.baseUrl is unset')
  })

  it('describes a web client package with its normalized declaration', () => {
    const name = '@scope/declared'
    writeBuiltPackage(name, { inject: ['@scope/base'], external: ['react'], immediately: true })
    expect(construct().describe(name)).toEqual({ inject: ['@scope/base'], external: ['react'], immediately: true })
  })

  it('answers undefined for an unresolvable name and keeps that verdict', () => {
    writeBuiltPackage('@scope/anchor')
    const source = construct()
    expect(source.describe('cordis:include')).toBeUndefined()
    expect(source.describe('@scope/late')).toBeUndefined()
    // A package appearing after the first verdict does not change it.
    writeBuiltPackage('@scope/late')
    expect(source.describe('@scope/late')).toBeUndefined()
    expect(source.locate('cordis:include')).toBeUndefined()
  })

  it('answers undefined for a package without a web client declaration', () => {
    const absent = '@scope/no-dsh'
    const other = '@scope/other-platform'
    writePackage(absent, { exports: { './package.json': './package.json' } })
    writePackage(other, { dsh: { client: { platform: 'terminal' } }, exports: { './package.json': './package.json' } })
    const source = construct()
    expect(source.describe(absent)).toBeUndefined()
    expect(source.describe(other)).toBeUndefined()
  })

  it('rejects a web client declaration without a ./client export', () => {
    const name = '@scope/exportless'
    writePackage(name, { dsh: { client: { platform: 'web' } }, exports: { './package.json': './package.json' } })
    expect(() => construct().describe(name))
      .toThrow(`client-modules: ${name} declares dsh.client but exports no "./client" bundle`)
  })

  it('rejects a malformed declaration through the shared parser', () => {
    const name = '@scope/malformed'
    writePackage(name, webManifest({ external: 'react' }))
    expect(() => construct().describe(name))
      .toThrow(`client-modules: ${name} dsh.client.external must be a string array`)
  })

  it('locates and reads the built bundle, resolving the conditional export form', async () => {
    const name = '@scope/built'
    const clientPath = writePackage(name, webManifest({}, { types: './lib/types/client.d.ts', default: './lib/client.js' }))
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = { built: true }\n')
    writeFileSync(`${clientPath}.map`, '{"version":3}\n')
    const source = construct()
    expect(source.locate(name)).toBe(clientPath)
    expect(new TextDecoder().decode(source.read(name))).toBe('module.exports = { built: true }\n')
    expect(new TextDecoder().decode(await source.readSourceMap(name))).toBe('{"version":3}\n')
  })

  it('reports an absent bundle as a missing build with its location', () => {
    const name = '@scope/unbuilt'
    const clientPath = writePackage(name, webManifest())
    const source = construct()
    let thrown: unknown
    try {
      source.read(name)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(MissingClientBundleError)
    const missing = thrown as MissingClientBundleError
    expect(missing.packageName).toBe(name)
    expect(missing.location).toBe(clientPath)
    expect((missing.cause as NodeJS.ErrnoException).code).toBe('ENOENT')
  })

  it('rethrows a bundle read failure other than absence', () => {
    const name = '@scope/directory-bundle'
    const clientPath = writePackage(name, webManifest())
    mkdirSync(clientPath, { recursive: true })
    expect(() => construct().read(name)).toThrow(/EISDIR/)
  })

  it('answers undefined for an absent source map and rethrows other map read failures', async () => {
    const mapless = '@scope/mapless'
    const directoryMap = '@scope/directory-map'
    writeBuiltPackage(mapless)
    const clientPath = writeBuiltPackage(directoryMap)
    mkdirSync(`${clientPath}.map`, { recursive: true })
    const source = construct()
    await expect(source.readSourceMap(mapless)).resolves.toBeUndefined()
    await expect(source.readSourceMap(directoryMap)).rejects.toThrow(/EISDIR/)
  })

  it('refuses bytes for a package that is not a web client package', async () => {
    writeBuiltPackage('@scope/anchor')
    const source = construct()
    const message = 'client-bundle-source-node: @scope/absent is not a web client package'
    expect(() => source.read('@scope/absent')).toThrow(message)
    await expect(source.readSourceMap('@scope/absent')).rejects.toThrow(message)
  })
})

describe('bundle-source-node invariant companion', () => {
  it('reserves the package name and installs no runtime probe', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(BundleSourceInvariant)
    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-client-bundle-source-node', () => {})
    }).toThrow(/already registered/)
  })
})
