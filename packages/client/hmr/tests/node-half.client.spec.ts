/**
 * Node half of the HMR plugin: bundle watches follow the graph, stat changes
 * report through clientModuleHost.rebuilt, the `/plugins/events` SSE channel
 * streams graph and rebuilt frames, and everything dies with the fiber.
 */
import { mkdtempSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebBootGraph, ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import { WebServer, type WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { apply, Config, EVENTS_ENDPOINT, inject } from '../src/index.ts'

const POLL_MS = 20

let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/**
 * Controllable clientModuleHost fake over a mutable id → bundle-path table.
 * Structural (Pick+cast): the plugin only touches the read/notify surface;
 * the service class carries private scan state a literal need not reproduce.
 */
type FakeHost = ClientModuleRegistry & {
  rebuiltCalls: string[]
  fireGraphChanged(): void
  fireRebuilt(id: string, rev: string): void
}
interface FakeHostOptions {
  beforeGraphRead?: () => void
  rebuilt?: (id: string) => string | undefined
}

function fakeClientModuleHost(rows: Map<string, string>, options: FakeHostOptions = {}): FakeHost {
  const graphListeners = new Set<() => void>()
  const rebuiltListeners = new Set<(id: string, rev: string) => void>()
  const rebuiltCalls: string[] = []
  const fake: Pick<FakeHost, 'graph' | 'clientPath' | 'rebuilt' | 'onRebuilt' | 'onGraphChanged' | 'rebuiltCalls' | 'fireGraphChanged' | 'fireRebuilt'> = {
    rebuiltCalls,
    fireGraphChanged: () => { for (const l of graphListeners) l() },
    fireRebuilt: (id, rev) => { for (const l of rebuiltListeners) l(id, rev) },
    graph: (): WebBootGraph => {
      options.beforeGraphRead?.()
      return {
        rev: 'r',
        entries: [...rows.keys()].map(id => ({ id, url: `/plugins/${id}/client.js?rev=r`, rev: 'r' })),
      }
    },
    clientPath: id => rows.get(id),
    rebuilt: (id) => {
      rebuiltCalls.push(id)
      return options.rebuilt?.(id) ?? 'r2'
    },
    onRebuilt: (listener) => {
      rebuiltListeners.add(listener)
      return () => { rebuiltListeners.delete(listener) }
    },
    onGraphChanged: (listener) => {
      graphListeners.add(listener)
      return () => { graphListeners.delete(listener) }
    },
  }
  return fake as FakeHost
}

/** Carrier fake: the abstract Service Definition with no listener; `routes` mirrors its exact table. */
function fakeHttpServer(routes: WebRoute[]): WebServer {
  class TestWebServer extends WebServer {
    get address(): undefined { return undefined }
    override register(route: WebRoute): () => void {
      routes.push(route)
      const dispose = super.register(route)
      return () => {
        dispose()
        routes.splice(routes.indexOf(route), 1)
      }
    }
  }
  return new TestWebServer(new Context())
}

/** Open the SSE channel and return a UTF-8 line reader over its body. */
async function openEvents(webServer: WebServer, signal?: AbortSignal): Promise<{
  response: Response
  read(): Promise<{ done: boolean; text: string }>
}> {
  const response = await webServer.fetch(new Request(`http://127.0.0.1${EVENTS_ENDPOINT}`, signal === undefined ? {} : { signal }))
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  return {
    response,
    read: async () => {
      const { done, value } = await reader.read()
      return { done, text: done ? '' : decoder.decode(value) }
    },
  }
}

async function mount(clientModuleHost: FakeHost, webServer: WebServer) {
  const ctx = new Context()
  ctx.provide('clientModules', clientModuleHost)
  ctx.provide('webServer', webServer)
  const fiber = ctx.plugin(
    { inject: [...inject], Config, apply },
    { pollIntervalMs: POLL_MS },
  )
  await fiber.await()
  return fiber
}

describe('hmr node half', () => {
  it('watches graph bundles, reports stat changes, and unwatches on dispose', async () => {
    const bundle = join(dir, 'a.js')
    writeFileSync(bundle, 'v1')
    const clientModuleHost = fakeClientModuleHost(new Map([['pkg-a', bundle]]))
    const routes: WebRoute[] = []
    const fiber = await mount(clientModuleHost, fakeHttpServer(routes))

    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'exact', path: EVENTS_ENDPOINT })
    expect(clientModuleHost.rebuiltCalls).toEqual(['pkg-a'])
    clientModuleHost.rebuiltCalls.length = 0

    // Nudge mtime past stat granularity so the poller sees a content signal.
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 2))
    writeFileSync(bundle, 'v2-longer')
    await vi.waitFor(() => { expect(clientModuleHost.rebuiltCalls).toContain('pkg-a') }, { timeout: 3_000 })

    await fiber.dispose()
    expect(routes).toHaveLength(0)
    // Watcher gone: further file changes report nothing.
    clientModuleHost.rebuiltCalls.length = 0
    writeFileSync(bundle, 'v3-even-longer')
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 4))
    expect(clientModuleHost.rebuiltCalls).toHaveLength(0)
  })

  it('follows graph changes: rows added after activation get watched', async () => {
    const early = join(dir, 'early.js')
    const late = join(dir, 'late.js')
    writeFileSync(early, 'v1')
    const rows = new Map([['pkg-early', early]])
    const clientModuleHost = fakeClientModuleHost(rows)
    const fiber = await mount(clientModuleHost, fakeHttpServer([]))
    clientModuleHost.rebuiltCalls.length = 0

    writeFileSync(late, 'v1')
    rows.set('pkg-late', late)
    clientModuleHost.fireGraphChanged()
    expect(clientModuleHost.rebuiltCalls).toEqual(['pkg-late'])
    clientModuleHost.rebuiltCalls.length = 0

    await new Promise(resolve => setTimeout(resolve, POLL_MS * 2))
    writeFileSync(late, 'v2-longer')
    await vi.waitFor(() => { expect(clientModuleHost.rebuiltCalls).toContain('pkg-late') }, { timeout: 3_000 })

    rows.delete('pkg-late')
    clientModuleHost.fireGraphChanged()
    clientModuleHost.rebuiltCalls.length = 0
    writeFileSync(late, 'v3-even-longer')
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 3))
    expect(clientModuleHost.rebuiltCalls).toHaveLength(0)
    await fiber.dispose()
  })

  it('rehashes after baseline capture so a construction-window write cannot become the baseline', async () => {
    const bundle = join(dir, 'construction.js')
    writeFileSync(bundle, 'v1')
    let rewrite = true
    const clientModuleHost = fakeClientModuleHost(new Map([['pkg-a', bundle]]), {
      beforeGraphRead: () => {
        if (!rewrite) return
        rewrite = false
        // The graph carries the hash from before this write. The old
        // fs.watchFile registration asynchronously captured the new file as
        // its first baseline and never requested a re-hash.
        writeFileSync(bundle, 'v2-written-during-watch-construction')
      },
    })

    const fiber = await mount(clientModuleHost, fakeHttpServer([]))

    expect(clientModuleHost.rebuiltCalls).toEqual(['pkg-a'])
    clientModuleHost.rebuiltCalls.length = 0
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 3))
    expect(clientModuleHost.rebuiltCalls).toHaveLength(0)
    await fiber.dispose()
  })

  it('marks a vanished bundle dirty so identical metadata still re-hashes after it reappears', async () => {
    const bundle = join(dir, 'replace.js')
    writeFileSync(bundle, 'seed')
    const fixedTime = new Date(1_600_000_000_000)
    utimesSync(bundle, fixedTime, fixedTime)
    const baseline = statSync(bundle)
    const clientModuleHost = fakeClientModuleHost(new Map([['pkg-a', bundle]]))
    const fiber = await mount(clientModuleHost, fakeHttpServer([]))
    clientModuleHost.rebuiltCalls.length = 0

    unlinkSync(bundle)
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 2))
    writeFileSync(bundle, 'x'.repeat(baseline.size))
    utimesSync(bundle, fixedTime, fixedTime)
    const restored = statSync(bundle)
    expect({ mtimeMs: restored.mtimeMs, size: restored.size }).toEqual({
      mtimeMs: baseline.mtimeMs,
      size: baseline.size,
    })
    await vi.waitFor(() => { expect(clientModuleHost.rebuiltCalls).toEqual(['pkg-a']) }, { timeout: 3_000 })
    await fiber.dispose()
  })

  it('retains a dirty baseline when the immediate re-hash races a rename', async () => {
    const bundle = join(dir, 'rename.js')
    writeFileSync(bundle, 'v1')
    let first = true
    const clientModuleHost = fakeClientModuleHost(new Map([['pkg-a', bundle]]), {
      rebuilt: () => {
        if (!first) return 'r2'
        first = false
        throw Object.assign(new Error('bundle renamed'), { code: 'ENOENT' })
      },
    })

    const fiber = await mount(clientModuleHost, fakeHttpServer([]))

    await vi.waitFor(() => { expect(clientModuleHost.rebuiltCalls).toEqual(['pkg-a', 'pkg-a']) }, { timeout: 3_000 })
    await fiber.dispose()
  })

  it('warns on non-ENOENT stat and rehash failures and skips rows without a bundle path', async () => {
    const file = join(dir, 'file.js')
    writeFileSync(file, 'v1')
    const notDir = join(file, 'child.js')
    const missing = join(dir, 'missing.js')
    const rows = new Map([['pkg-notdir', notDir], ['pkg-missing', missing], ['pkg-file', file]])
    const clientModuleHost = fakeClientModuleHost(rows, {
      rebuilt: (id) => {
        if (id === 'pkg-file') throw new Error('hash failed')
        return 'r2'
      },
    })
    rows.set('pkg-pathless', undefined as unknown as string)
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    ctx.provide('clientModules', clientModuleHost)
    ctx.provide('webServer', fakeHttpServer([]))
    const fiber = ctx.plugin({ inject: [...inject], Config, apply }, { pollIntervalMs: POLL_MS })
    await fiber.await()

    // ENOTDIR baseline and a non-ENOENT rehash failure warn once each; the missing bundle stays silent.
    expect(clientModuleHost.rebuiltCalls).toEqual(['pkg-file'])
    expect(warn).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[0]?.[0])).toContain('ENOTDIR')
    expect(String(warn.mock.calls[1]?.[0])).toContain('hash failed')
    // The poll repeats the ENOTDIR warning for the watched-but-unstatable row.
    await vi.waitFor(() => { expect(warn.mock.calls.length).toBeGreaterThan(2) }, { timeout: 3_000 })
    await fiber.dispose()
  })

  describe('/plugins/events channel', () => {
    it('answers 405 to a non-GET request', async () => {
      const webServer = fakeHttpServer([])
      const fiber = await mount(fakeClientModuleHost(new Map()), webServer)
      const response = await webServer.fetch(new Request(`http://127.0.0.1${EVENTS_ENDPOINT}`, { method: 'POST' }))
      expect(response.status).toBe(405)
      await fiber.dispose()
    })

    it('opens with the connected comment and the current graph frame', async () => {
      const bundle = join(dir, 'a.js')
      writeFileSync(bundle, 'v1')
      const clientModuleHost = fakeClientModuleHost(new Map([['pkg-a', bundle]]))
      const webServer = fakeHttpServer([])
      const fiber = await mount(clientModuleHost, webServer)

      const events = await openEvents(webServer)
      expect(events.response.status).toBe(200)
      expect(events.response.headers.get('content-type')).toBe('text/event-stream')
      expect(events.response.headers.get('cache-control')).toBe('no-cache')
      expect(await events.read()).toEqual({ done: false, text: ': connected\n\n' })
      expect(await events.read()).toEqual({
        done: false,
        text: `data: ${JSON.stringify({ type: 'graph', graph: clientModuleHost.graph() })}\n\n`,
      })
      await fiber.dispose()
    })

    it('broadcasts a rebuilt frame to every open stream', async () => {
      const clientModuleHost = fakeClientModuleHost(new Map())
      const webServer = fakeHttpServer([])
      const fiber = await mount(clientModuleHost, webServer)
      const first = await openEvents(webServer)
      const second = await openEvents(webServer)
      for (const events of [first, second]) {
        await events.read()
        await events.read()
      }

      clientModuleHost.fireRebuilt('pkg-a', 'r2')

      const frame = `data: ${JSON.stringify({ type: 'rebuilt', id: 'pkg-a', rev: 'r2' })}\n\n`
      expect(await first.read()).toEqual({ done: false, text: frame })
      expect(await second.read()).toEqual({ done: false, text: frame })
      await fiber.dispose()
    })

    it('releases the row when the request aborts: the stream ends and later rebuilds skip it', async () => {
      const clientModuleHost = fakeClientModuleHost(new Map())
      const webServer = fakeHttpServer([])
      const fiber = await mount(clientModuleHost, webServer)
      const abort = new AbortController()
      const gone = await openEvents(webServer, abort.signal)
      const open = await openEvents(webServer)
      for (const events of [gone, open]) {
        await events.read()
        await events.read()
      }

      abort.abort()
      expect(await gone.read()).toEqual({ done: true, text: '' })
      expect(() => { clientModuleHost.fireRebuilt('pkg-a', 'r2') }).not.toThrow()
      expect((await open.read()).text).toContain('"type":"rebuilt"')
      await fiber.dispose()
    })

    it('releases the row when the carrier cancels the body', async () => {
      const clientModuleHost = fakeClientModuleHost(new Map())
      const webServer = fakeHttpServer([])
      const fiber = await mount(clientModuleHost, webServer)
      const response = await webServer.fetch(new Request(`http://127.0.0.1${EVENTS_ENDPOINT}`))

      await response.body!.cancel()
      expect(() => { clientModuleHost.fireRebuilt('pkg-a', 'r2') }).not.toThrow()
      await fiber.dispose()
    })

    it('closes every open stream on disposal, and a later abort of a closed stream stays silent', async () => {
      const clientModuleHost = fakeClientModuleHost(new Map())
      const webServer = fakeHttpServer([])
      const fiber = await mount(clientModuleHost, webServer)
      const abort = new AbortController()
      const events = await openEvents(webServer, abort.signal)
      await events.read()
      await events.read()

      await fiber.dispose()
      expect(await events.read()).toEqual({ done: true, text: '' })
      expect(() => { abort.abort() }).not.toThrow()
      expect((await webServer.fetch(new Request(`http://127.0.0.1${EVENTS_ENDPOINT}`))).status).toBe(404)
    })
  })
})
