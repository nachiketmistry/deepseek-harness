/** Node-half composition diagnostics for package metadata and built client bundles. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeClientBundleSource } from '@deepseek-ai/dsh-client-bundle-source-node'
import { WebServer, renderIndexInjections, type WebRoute } from '@deepseek-ai/dsh-host-webserver'
import * as modulesClient from '../src/client/index.ts'
import {
  ClientBundleSource,
  ClientModuleRegistry,
  MissingClientBundleError,
  bootInjections,
  clientExportOf,
  orderByModuleGraph,
  parseClientDeclaration,
  type ClientBundleDescription,
} from '../src/index.ts'
import type { ClientModuleLoaderTarget, WebBootEntry, WebBootGraph } from '../src/client/index.ts'

const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const RUNTIME_ID = '@deepseek-ai/dsh-client-runtime'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** Create a resolvable package whose client export points at the returned path. */
function writePackage(
  packageName: string,
  metadata: Record<string, unknown> = { dsh: { client: { platform: 'web' } } },
): string {
  root ??= realpathSync(mkdtempSync(join(tmpdir(), 'dsh-client-modules-')))
  const pkgRoot = join(root, 'node_modules', ...packageName.split('/'))
  const clientPath = join(pkgRoot, 'lib', 'client.js')
  mkdirSync(pkgRoot, { recursive: true })
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
    name: packageName,
    exports: {
      './client': './lib/client.js',
      './package.json': './package.json',
    },
    ...metadata,
  }))
  return clientPath
}

/** Create a built package with the supplied client declaration. */
function writeBuiltPackage(packageName: string, client: Record<string, unknown>): void {
  const clientPath = writePackage(packageName, { dsh: { client: { platform: 'web', ...client } } })
  mkdirSync(dirname(clientPath), { recursive: true })
  writeFileSync(clientPath, 'module.exports = {}\n')
}

/** One in-memory package: its declaration, bundle bytes (absent bytes make `read` throw), map, and path. */
interface MemoryPackage {
  description: ClientBundleDescription
  bytes?: string
  map?: string
  path?: string
}

/** A bundle source over an in-memory table, counting `describe` calls to observe the registry's verdict cache. */
class MemoryBundleSource extends ClientBundleSource {
  describeCalls = 0

  constructor(ctx: Context, readonly packages: Map<string, MemoryPackage>) {
    super(ctx)
  }

  override describe(packageName: string): ClientBundleDescription | undefined {
    this.describeCalls += 1
    return this.packages.get(packageName)?.description
  }

  override read(packageName: string): Uint8Array {
    const bytes = this.packages.get(packageName)?.bytes
    if (bytes === undefined) throw new Error(`memory source: ${packageName} has no bundle`)
    return new TextEncoder().encode(bytes)
  }

  override readSourceMap(packageName: string): Promise<Uint8Array | undefined> {
    const map = this.packages.get(packageName)?.map
    return Promise.resolve(map === undefined ? undefined : new TextEncoder().encode(map))
  }

  override locate(packageName: string): string | undefined {
    return this.packages.get(packageName)?.path
  }
}

/** A loader row the registry scans; `fiber` and `disabled` are mutable so a test can retire and revive it. */
interface LoaderRow {
  options: { name: string }
  fiber: object | undefined
  disabled: boolean
}

/** The constructed node half with its route, context, and mutable loader rows. */
interface Bench {
  service: ClientModuleRegistry
  route: WebRoute
  ctx: Context
  rows: LoaderRow[]
}

/** Emit the cordis fiber event for one loader entry name and let the registry's microtask flush run. */
async function touch(ctx: Context, name: string): Promise<void> {
  ctx.emit('internal/plugin', { entry: { options: { name } } } as unknown as Fiber)
  await Promise.resolve()
}

/**
 * Construct the node-half service and capture its plugin-bundle route. Without
 * `packages` the Node provider resolves the on-disk fixture under `root`; with
 * it the in-memory source answers, exercising the registry alone.
 */
function constructWithRoute(packageNames: string[], packages?: Map<string, MemoryPackage>): Bench {
  const ctx = new Context()
  const rows: LoaderRow[] = packageNames.map(name => ({ options: { name }, fiber: {}, disabled: false }))
  ctx.provide('loader', {
    *entries() {
      yield* rows
    },
  })
  if (packages === undefined) {
    ctx.baseUrl = pathToFileURL(root!).href + '/'
    new NodeClientBundleSource(ctx)
  } else {
    new MemoryBundleSource(ctx, packages)
  }
  let route: WebRoute | undefined
  class TestWebServer extends WebServer {
    get address(): undefined { return undefined }
    override register(candidate: WebRoute): () => void {
      if (candidate.path === '/plugins') route = candidate
      return () => {}
    }
  }
  new TestWebServer(ctx)
  const service = new ClientModuleRegistry(ctx)
  if (route === undefined) throw new Error('client bundle route was not registered')
  return { service, route, ctx, rows }
}

/** Construct the node-half service over the enabled fixture entries. */
function construct(packageNames: string[]): ClientModuleRegistry {
  return constructWithRoute(packageNames).service
}

/** Execute the exact first inline script emitted by the Host boot rows. */
function injectedFacade(graph: WebBootGraph): { html: string; target: ClientModuleLoaderTarget } {
  const html = renderIndexInjections(
    '<html><head></head><body><script type="module" src="/index.js"></script></body></html>',
    bootInjections(graph),
  )
  const source = /<head><script>([\s\S]*?)<\/script>/.exec(html)?.[1]
  if (source === undefined) throw new Error('missing injected ModuleLoader facade script')
  const window: { __ModuleLoader__?: ClientModuleLoaderTarget } = {}
  runInNewContext(source, { window })
  if (window.__ModuleLoader__ === undefined) throw new Error('facade script did not install __ModuleLoader__')
  return { html, target: window.__ModuleLoader__ }
}

const bootGraph = (): WebBootGraph => ({
  rev: 'graph',
  entries: [
    { id: MODULES_ID, url: '/plugins/modules.js?rev=m', rev: 'm' },
    { id: RUNTIME_ID, url: '/plugins/runtime.js?rev=r', rev: 'r' },
  ],
})

describe('HTML bootstrap facade', () => {
  it('precedes blocking preloads and the boot graph, then becomes the live registration target', async () => {
    const graph = bootGraph()
    const { html, target } = injectedFacade(graph)
    const facadeAt = html.indexOf('window.__ModuleLoader__=')
    const modulesAt = html.indexOf('<script src="/plugins/modules.js?rev=m"></script>')
    const runtimeAt = html.indexOf('<script src="/plugins/runtime.js?rev=r"></script>')
    const graphAt = html.indexOf('globalThis["__DSH_BOOT__"] = ')
    const entryAt = html.indexOf('<script type="module" src="/index.js"></script>')
    expect([facadeAt, modulesAt, runtimeAt, graphAt, entryAt]).toEqual([...new Set([
      facadeAt, modulesAt, runtimeAt, graphAt, entryAt,
    ])].sort((a, b) => a - b))

    target.load({ id: MODULES_ID, factory: () => modulesClient })
    target.load({ id: RUNTIME_ID, factory: () => ({ marker: 'runtime' }) })
    const system = target.create({ boot: graph, staticModules: {} })

    expect(target.mode).toBe('live')
    expect(target.pendingQueue).toEqual([])
    expect(system.manifest.rev).toBe('graph')
    expect(await system.import(MODULES_ID)).toBe(modulesClient)
    expect(await system.import(`${RUNTIME_ID}/client`)).toEqual({ marker: 'runtime' })
    expect(() => target.create({ boot: graph, staticModules: {} }))
      .toThrow('create called after module-system boot')
  })

  it('rejects a page that did not preload the modules bundle', () => {
    const graph = bootGraph()
    const { target } = injectedFacade(graph)
    expect(() => target.create({ boot: graph, staticModules: {} }))
      .toThrow(`HTML did not preload ${MODULES_ID}/client.js`)
  })

  it('rejects a bootstrap bundle with a runtime external', () => {
    const graph = bootGraph()
    const { target } = injectedFacade(graph)
    target.load({
      id: MODULES_ID,
      factory: (require) => {
        require('react')
        return modulesClient
      },
    })
    expect(() => target.create({ boot: graph, staticModules: {} }))
      .toThrow(`${MODULES_ID}/client.js requested external "react"`)
  })

  it.each([
    null,
    { ...modulesClient, createClientModuleSystem: undefined },
    { ...modulesClient, apply: undefined },
  ])('rejects a bootstrap bundle without the complete module face', (exports) => {
    const graph = bootGraph()
    const { target } = injectedFacade(graph)
    target.load({ id: MODULES_ID, factory: () => exports as unknown as Record<string, unknown> })
    expect(() => target.create({ boot: graph, staticModules: {} }))
      .toThrow(`${MODULES_ID}/client.js did not export the bootstrap module face`)
  })
})

describe('client bundle activation', () => {
  it('allows sibling dsh roles', () => {
    const currentName = '@fixture/current-client-field'
    const clientPath = writePackage(currentName, {
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web' },
        profile: { bundles: [] },
      },
    })
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    expect(construct([currentName]).graph().entries.map(entry => entry.id)).toEqual([currentName])
  })

  it('groups missing bundles under one source-build instruction with a package/path list', () => {
    const firstName = '@fixture/missing-first'
    const secondName = '@fixture/missing-second'
    const firstPath = writePackage(firstName)
    const secondPath = writePackage(secondName)
    expect(() => construct([firstName, secondName])).toThrow([
      'client-modules: 2 client packages failed to compose:',
      '  client bundles not found; run `pnpm run build` before launch:',
      `    - package: ${firstName}`,
      `      path: ${firstPath}`,
      `    - package: ${secondName}`,
      `      path: ${secondPath}`,
    ].join('\n'))
  })

  it('does not report other bundle read failures as missing builds', () => {
    const packageName = '@fixture/unreadable-client'
    const clientPath = writePackage(packageName)
    mkdirSync(clientPath, { recursive: true })
    let thrown: unknown
    try {
      construct([packageName])
    } catch (error) {
      thrown = error
    }
    expect(String(thrown)).toContain('client-modules: 1 client package failed to compose:')
    expect(String(thrown)).toContain('  other failures:')
    expect(String(thrown)).toContain('EISDIR')
    expect(String(thrown)).not.toContain('pnpm run build')
  })

  it('serves the source map beside a registered client bundle', async () => {
    const packageName = '@fixture/source-map'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    const map = '{"version":3,"sources":["src/client/index.tsx"]}\n'
    writeFileSync(`${clientPath}.map`, map)
    const { route } = constructWithRoute([packageName])

    const response = await route.handler(new Request(`http://127.0.0.1/plugins/${packageName}/client.js.map`))

    expect(response.status).toBe(200)
    expect(Object.fromEntries(response.headers)).toEqual({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
    })
    expect(await response.text()).toBe(map)
  })

  it('serves a registered client bundle as JavaScript with no-cache', async () => {
    const packageName = '@fixture/served-bundle'
    writeBuiltPackage(packageName, {})
    const { route } = constructWithRoute([packageName])

    const response = await route.handler(new Request(`http://127.0.0.1/plugins/${packageName}/client.js?rev=1`))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(await response.text()).toBe('module.exports = {}\n')
  })

  it('answers 405 to a non-GET bundle request', async () => {
    const packageName = '@fixture/method-refused'
    writeBuiltPackage(packageName, {})
    const { route } = constructWithRoute([packageName])

    const response = await route.handler(new Request(`http://127.0.0.1/plugins/${packageName}/client.js`, { method: 'POST' }))

    expect(response.status).toBe(405)
  })

  it('answers 404 to an unknown plugin id and to a path outside the bundle pattern', async () => {
    const packageName = '@fixture/known-bundle'
    writeBuiltPackage(packageName, {})
    const { route } = constructWithRoute([packageName])

    expect((await route.handler(new Request('http://127.0.0.1/plugins/@fixture/unknown/client.js'))).status).toBe(404)
    expect((await route.handler(new Request('http://127.0.0.1/plugins/events'))).status).toBe(404)
  })

  it('answers 404 when a registered bundle file is unreadable', async () => {
    const packageName = '@fixture/unbuilt-bundle'
    writeBuiltPackage(packageName, {})
    const { route } = constructWithRoute([packageName])
    rmSync(join(root!, 'node_modules', packageName, 'lib', 'client.js'))

    const response = await route.handler(new Request(`http://127.0.0.1/plugins/${packageName}/client.js`))

    expect(response.status).toBe(404)
  })
})

describe('shared module declarations', () => {
  it('accepts external requests and carries them onto the graph row', () => {
    const packageName = '@fixture/shared-declared'
    writeBuiltPackage(packageName, { external: ['react'] })
    expect(construct([packageName]).graph().entries).toEqual([{
      id: packageName,
      url: expect.stringContaining(`/plugins/${packageName}/client.js?rev=`) as unknown as string,
      rev: expect.any(String) as unknown as string,
      external: ['react'],
    }])
  })

  it('omits external when the package declares no requests', () => {
    const packageName = '@fixture/shared-absent'
    writeBuiltPackage(packageName, {})
    const [row] = construct([packageName]).graph().entries
    expect(row).not.toHaveProperty('external')
  })

  it('rejects a non-array external', () => {
    const packageName = '@fixture/external-not-array'
    writeBuiltPackage(packageName, { external: 'react' })
    expect(() => construct([packageName]))
      .toThrow(`client-modules: ${packageName} dsh.client.external must be a string array`)
  })
})

describe('module graph order', () => {
  const entry = (id: string, fields: Partial<WebBootEntry> = {}): WebBootEntry =>
    ({ id, url: `/plugins/${id}/client.js?rev=0`, rev: '0', ...fields })
  const ids = (entries: readonly WebBootEntry[]): string[] => entries.map(row => row.id)

  it('places every requested package row before its consumers along a chain', () => {
    expect(ids(orderByModuleGraph([
      entry('ui', { external: ['slots'] }),
      entry('slots', { external: ['render'] }),
      entry('render'),
    ]))).toEqual(['render', 'slots', 'ui'])
  })

  it('places a shared package row before both arms of a diamond', () => {
    expect(ids(orderByModuleGraph([
      entry('app', { external: ['left', 'right'] }),
      entry('left', { external: ['vendor'] }),
      entry('right', { external: ['vendor'] }),
      entry('vendor'),
    ]))).toEqual(['vendor', 'left', 'right', 'app'])
  })

  it('resolves a /client request onto the requested package row', () => {
    expect(ids(orderByModuleGraph([
      entry('ui', { external: ['runtime/client'] }),
      entry('runtime'),
    ]))).toEqual(['runtime', 'ui'])
  })

  it('leaves a request no row answers to the static assembly channel', () => {
    expect(ids(orderByModuleGraph([
      entry('consumer', { external: ['@deepseek-ai/cordis'] }),
      entry('other'),
    ]))).toEqual(['consumer', 'other'])
  })

  it('rejects a cycle and names the packages on it', () => {
    expect(() => orderByModuleGraph([
      entry('a', { external: ['b'] }),
      entry('b', { external: ['a'] }),
    ])).toThrow('client-modules: module graph cycle a -> b -> a')
  })

  it('rejects a row requesting its own package name', () => {
    expect(() => orderByModuleGraph([entry('solo', { external: ['solo'] })]))
      .toThrow('client-modules: "solo" requests module "solo" that it answers itself')
  })

  it('composes the served graph in module-graph order', () => {
    const consumerName = '@fixture/order-consumer'
    const dependencyName = '@fixture/order-dependency'
    writeBuiltPackage(consumerName, { external: [dependencyName] })
    writeBuiltPackage(dependencyName, {})
    expect(ids(construct([consumerName, dependencyName]).graph().entries))
      .toEqual([dependencyName, consumerName])
  })

  it('fails activation loud when scanned packages form a module cycle', () => {
    writeBuiltPackage('@fixture/cycle-a', { external: ['@fixture/cycle-b'] })
    writeBuiltPackage('@fixture/cycle-b', { external: ['@fixture/cycle-a'] })
    expect(() => construct(['@fixture/cycle-a', '@fixture/cycle-b']))
      .toThrow('module graph cycle @fixture/cycle-a -> @fixture/cycle-b -> @fixture/cycle-a')
  })
})

const memoryPackage = (bytes: string, fields: Partial<MemoryPackage> = {}): MemoryPackage =>
  ({ description: { external: [], immediately: false }, bytes, ...fields })

describe('registry over the bundle source', () => {
  it('caches every describe verdict per name across flushes, including the negative one', async () => {
    const clientName = '@memory/client'
    const plainName = '@memory/plain'
    const packages = new Map([[clientName, memoryPackage('module.exports = 1\n')]])
    const { ctx, rows, service } = constructWithRoute([clientName, plainName], packages)
    const source = ctx.clientBundleSource as MemoryBundleSource
    expect(source.describeCalls).toBe(2)
    expect(service.graph().entries.map(entry => entry.id)).toEqual([clientName])

    await touch(ctx, plainName)
    expect(source.describeCalls).toBe(2)

    // Retiring the row drops it from the table; reviving it reuses the cached verdict.
    rows[0]!.disabled = true
    await touch(ctx, clientName)
    expect(service.graph().entries).toEqual([])
    rows[0]!.disabled = false
    await touch(ctx, clientName)
    expect(service.graph().entries.map(entry => entry.id)).toEqual([clientName])
    expect(source.describeCalls).toBe(2)
  })

  it('re-reads the bundle on rebuilt and notifies only when the content hash changed', () => {
    const name = '@memory/rebuilt'
    const packages = new Map([[name, memoryPackage('module.exports = 1\n')]])
    const { service } = constructWithRoute([name], packages)
    const [row] = service.graph().entries
    const graphRev = service.graph().rev
    const rebuilt = vi.fn()
    const graphChanged = vi.fn()
    service.onRebuilt(rebuilt)
    service.onGraphChanged(graphChanged)

    expect(service.rebuilt('@memory/unknown')).toBeUndefined()
    expect(service.rebuilt(name)).toBe(row!.rev)
    expect(rebuilt).not.toHaveBeenCalled()
    expect(graphChanged).not.toHaveBeenCalled()
    expect(service.graph().rev).toBe(graphRev)

    packages.get(name)!.bytes = 'module.exports = 2\n'
    const rev = service.rebuilt(name)
    expect(rev).toMatch(/^[0-9a-f]{12}$/)
    expect(rev).not.toBe(row!.rev)
    expect(rebuilt).toHaveBeenCalledWith(name, rev)
    expect(graphChanged).toHaveBeenCalledOnce()
    expect(service.graph().rev).not.toBe(graphRev)
    expect(service.graph().entries[0]!.url).toBe(`/plugins/${name}/client.js?rev=${rev!}`)
  })

  it('contains a throwing rebuild subscriber so later subscribers still run', () => {
    const name = '@memory/contained'
    const packages = new Map([[name, memoryPackage('a')]])
    const { ctx, service } = constructWithRoute([name], packages)
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const later = vi.fn()
    service.onRebuilt(() => { throw new Error('subscriber failed') })
    service.onRebuilt(later)
    packages.get(name)!.bytes = 'b'
    service.rebuilt(name)
    expect(later).toHaveBeenCalledOnce()
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: 'subscriber failed' }))
  })

  it('delegates clientPath to locate and answers undefined for a fileless source or an unknown id', () => {
    const located = '@memory/located'
    const fileless = '@memory/fileless'
    const packages = new Map([
      [located, memoryPackage('a', { path: '/bundles/located/client.js' })],
      [fileless, memoryPackage('b')],
    ])
    const { service } = constructWithRoute([located, fileless], packages)
    expect(service.clientPath(located)).toBe('/bundles/located/client.js')
    expect(service.clientPath(fileless)).toBeUndefined()
    expect(service.clientPath('@memory/unknown')).toBeUndefined()
  })

  it('answers 404 for a registered bundle whose source has no map', async () => {
    const name = '@memory/mapless'
    const { route } = constructWithRoute([name], new Map([[name, memoryPackage('a')]]))
    const response = await route.handler(new Request(`http://127.0.0.1/plugins/${name}/client.js.map`))
    expect(response.status).toBe(404)
  })

  it('answers 404 for a registered bundle whose read throws', async () => {
    const name = '@memory/unreadable'
    const packages = new Map([[name, memoryPackage('a')]])
    const { route } = constructWithRoute([name], packages)
    delete packages.get(name)!.bytes
    const response = await route.handler(new Request(`http://127.0.0.1/plugins/${name}/client.js`))
    expect(response.status).toBe(404)
  })
})

describe('client declarations', () => {
  it('returns undefined for an absent declaration', () => {
    expect(parseClientDeclaration('pkg', undefined)).toBeUndefined()
  })

  it('normalizes a complete declaration and an empty one', () => {
    expect(parseClientDeclaration('pkg', {
      platform: 'web', inject: ['a'], external: ['react'], immediately: true,
    })).toEqual({ platform: 'web', inject: ['a'], external: ['react'], immediately: true })
    expect(parseClientDeclaration('pkg', { platform: 'web' }))
      .toEqual({ platform: 'web', external: [], immediately: false })
  })

  it.each([
    ['a non-object declaration', 'web', 'pkg has a non-object dsh.client declaration'],
    ['a missing platform', {}, 'pkg dsh.client.platform must be a string'],
    ['a non-array inject', { platform: 'web', inject: 'a' }, 'pkg dsh.client.inject must be a string array'],
    ['a non-array external', { platform: 'web', external: [1] }, 'pkg dsh.client.external must be a string array'],
    ['a non-boolean immediately', { platform: 'web', immediately: 'yes' }, 'pkg dsh.client.immediately must be a boolean'],
  ])('rejects %s', (_label, value, message) => {
    expect(() => parseClientDeclaration('pkg', value)).toThrow(`client-modules: ${message}`)
  })

  it('resolves the string and conditional client export forms', () => {
    expect(clientExportOf('pkg', undefined)).toBeUndefined()
    expect(clientExportOf('pkg', { '.': './lib/index.js' })).toBeUndefined()
    expect(clientExportOf('pkg', { './client': './lib/client.js' })).toBe('./lib/client.js')
    expect(clientExportOf('pkg', { './client': { types: './lib/types/client.d.ts', default: './lib/client.js' } }))
      .toBe('./lib/client.js')
  })

  it.each([
    ['a conditional export without a string default', { './client': { types: './lib/types/client.d.ts' } }],
    ['a non-string, non-object export', { './client': 1 }],
  ])('rejects %s', (_label, exportsField) => {
    expect(() => clientExportOf('pkg', exportsField))
      .toThrow('client-modules: pkg exports["./client"] must be a string or an object with a string default')
  })

  it('retains the package and location on a missing-bundle error', () => {
    const cause = new Error('ENOENT')
    const error = new MissingClientBundleError('pkg', '/bundles/pkg/client.js', cause)
    expect(error.packageName).toBe('pkg')
    expect(error.location).toBe('/bundles/pkg/client.js')
    expect(error.cause).toBe(cause)
    expect(error.message).toBe([
      'client-modules: client bundle not found; run `pnpm run build` before launch:',
      '  package: pkg',
      '  path: /bundles/pkg/client.js',
    ].join('\n'))
  })
})
