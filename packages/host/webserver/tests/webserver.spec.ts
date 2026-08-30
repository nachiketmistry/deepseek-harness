/**
 * Service Definition coverage: the abstract `WebServer` registry and its Fetch
 * dispatch, driven through a minimal concrete subclass with no listener. The
 * listening surface (real sockets, streaming, upgrades) belongs to the Node
 * provider's suite in `@deepseek-ai/dsh-host-webserver-node`.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { WEBSOCKET_OPEN, WebServer, renderIndexInjections, type WebSocketRoute } from '../src/index.ts'
import * as WebServerInvariant from '../src/invariant.ts'

/** A carrier with no listener of its own: the platform-driven provider shape. */
class TestWebServer extends WebServer {
  override get address(): undefined {
    return undefined
  }
}

const text = (body: string, status = 200): Response => new Response(body, { status })

/** Boot one context carrying the test carrier. */
async function boot(): Promise<{ ctx: Context; server: WebServer }> {
  const ctx = new Context()
  await ctx.plugin(TestWebServer)
  return { ctx, server: ctx.webServer }
}

/** Dispatch one request and read status plus body text. */
async function dispatch(server: WebServer, path: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  const response = await server.fetch(new Request(`http://127.0.0.1${path}`, init))
  return { status: response.status, body: await response.text() }
}

describe('WebServer route registry', () => {
  it('dispatches exact over longest prefix over the fallback seat over 404', async () => {
    const { server } = await boot()
    expect(server.address).toBeUndefined()
    expect(server).toBeInstanceOf(WebServer)

    // Routing precedence: exact beats prefix, longest prefix wins, a prefix
    // route answers its own path, and routes own their method handling
    // (POST reaches a registered prefix; 405 is fallback-only semantics).
    server.register({ kind: 'exact', path: '/probe', handler: () => text('EXACT') })
    // Longest prefix wins regardless of registration order.
    server.register({ kind: 'prefix', path: '/api/deep', handler: () => text('DEEP') })
    server.register({ kind: 'prefix', path: '/api', handler: () => text('API') })
    server.register({ kind: 'prefix', path: '/api/deeper', handler: () => text('DEEPER') })
    server.register({ kind: 'exact', path: '/api/deep/leaf', handler: async () => text('LEAF') })
    expect(await dispatch(server, '/probe')).toEqual({ status: 200, body: 'EXACT' })
    expect(await dispatch(server, '/api/anything')).toEqual({ status: 200, body: 'API' })
    expect(await dispatch(server, '/api/deep/leaf')).toEqual({ status: 200, body: 'LEAF' })
    expect(await dispatch(server, '/api/deep/other')).toEqual({ status: 200, body: 'DEEP' })
    expect(await dispatch(server, '/api/deeper/x')).toEqual({ status: 200, body: 'DEEPER' })
    expect(await dispatch(server, '/api')).toEqual({ status: 200, body: 'API' })
    expect(await dispatch(server, '/apix')).toEqual({ status: 404, body: '' })
    expect(await dispatch(server, '/api/anything', { method: 'POST' })).toEqual({ status: 200, body: 'API' })
    // Query strings never take part in matching.
    expect(await dispatch(server, '/probe?x=1')).toEqual({ status: 200, body: 'EXACT' })

    // Fallback seat: 404 while unclaimed; the owner answers everything no
    // named route matches; the seat admits exactly one owner and the
    // disposer releases it.
    expect(await dispatch(server, '/no/such/route')).toEqual({ status: 404, body: '' })
    const releaseFallback = server.registerFallback(request => text(`shell ${new URL(request.url).pathname}`))
    expect(() => server.registerFallback(() => text(''))).toThrow(/fallback already registered/)
    expect(await dispatch(server, '/no/such/route')).toEqual({ status: 200, body: 'shell /no/such/route' })
    expect(await dispatch(server, '/probe')).toEqual({ status: 200, body: 'EXACT' })
    releaseFallback()
    expect(await dispatch(server, '/no/such/route')).toEqual({ status: 404, body: '' })
    expect(() => server.registerFallback(() => text(''))).not.toThrow()

    // A handler's rejection propagates to the provider.
    server.register({ kind: 'exact', path: '/boom', handler: () => { throw new Error('handler failure') } })
    await expect(server.fetch(new Request('http://127.0.0.1/boom'))).rejects.toThrow('handler failure')
  })

  it('rejects duplicate (kind, path) and restores registrability on dispose', async () => {
    const { server } = await boot()
    server.register({ kind: 'exact', path: '/probe', handler: () => text('EXACT') })
    expect(() => server.register({ kind: 'exact', path: '/probe', handler: () => text('') }))
      .toThrow(/duplicate exact route "\/probe"/)
    // The same path is free in the other table.
    server.register({ kind: 'prefix', path: '/probe', handler: () => text('PREFIX') })
    expect(() => server.register({ kind: 'prefix', path: '/probe', handler: () => text('') }))
      .toThrow(/duplicate prefix route "\/probe"/)
    expect(await dispatch(server, '/probe')).toEqual({ status: 200, body: 'EXACT' })
    expect(await dispatch(server, '/probe/child')).toEqual({ status: 200, body: 'PREFIX' })

    const disposeOnce = server.register({ kind: 'exact', path: '/once', handler: () => text('ONCE') })
    expect(await dispatch(server, '/once')).toEqual({ status: 200, body: 'ONCE' })
    disposeOnce()
    expect(await dispatch(server, '/once')).toEqual({ status: 404, body: '' })
    expect(() => server.register({ kind: 'exact', path: '/once', handler: () => text('') })).not.toThrow()
  })

  it('owns exact-path upgrade routes with duplicate rejection and disposer symmetry', async () => {
    const { server } = await boot()
    const route: WebSocketRoute = { path: '/events', open: () => {} }
    const dispose = server.registerUpgrade(route)
    expect(() => server.registerUpgrade({ path: '/events', open: () => {} })).toThrow(/duplicate upgrade route "\/events"/)
    expect(server.upgradeRoute('/events')).toBe(route)
    expect(server.upgradeRoute('/events/child')).toBeUndefined()
    expect(server.upgradeRoute('/other')).toBeUndefined()
    dispose()
    expect(server.upgradeRoute('/events')).toBeUndefined()
    expect(() => server.registerUpgrade({ path: '/events', open: () => {} })).not.toThrow()
    expect(WEBSOCKET_OPEN).toBe(WebSocket.OPEN)
  })
})

describe('WebServer index rendering', () => {
  it('applies taps in registration order and releases them once', async () => {
    const { server } = await boot()
    const untapA = server.tapIndex(html => `${html}A`)
    const untapB = server.tapIndex(html => `${html}B`)
    expect(server.applyIndexTaps('x')).toBe('xAB')
    untapA()
    expect(server.applyIndexTaps('x')).toBe('xB')
    // A second release is a no-op; the remaining tap stays registered.
    untapA()
    expect(server.applyIndexTaps('x')).toBe('xB')
    untapB()
    expect(server.applyIndexTaps('x')).toBe('x')
  })

  it('collects injection rows fresh per render and layers taps over the rendered rows', async () => {
    const { ctx, server } = await boot()
    let flag = 'dark'
    ctx.on('webserver/index-inject', (table) => {
      table.push(
        { kind: 'script', placement: 'head', text: 'window.__Q__=1' },
        { kind: 'script-src', placement: 'head', src: '/plugins/a.js?rev="1"&x=<y>' },
        { kind: 'global', name: '__DSH_BOOT__', value: { rev: '</script><b>' } },
        { kind: 'style', text: 'body{margin:0}' },
        { kind: 'html', placement: 'head', html: '<meta name="probe">' },
        { kind: 'script', placement: 'body', text: `window.__P__=${JSON.stringify(flag)}` },
      )
    })

    const html = server.renderIndex('<html><head></head><body>shell</body></html>')
    // Head rows land right after the opening head tag in table order; the body
    // row lands right after the opening body tag.
    const order = [
      '<head>',
      '<script>window.__Q__=1</script>',
      '<script src="/plugins/a.js?rev=&quot;1&quot;&amp;x=&lt;y&gt;"></script>',
      'globalThis["__DSH_BOOT__"] = {"rev":"\\u003c/script>\\u003cb>"}',
      '<style>body{margin:0}</style>',
      '<meta name="probe">',
      '<body>',
      '<script>window.__P__="dark"</script>',
      'shell',
    ].map(part => html.indexOf(part))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order.every(at => at !== -1)).toBe(true)

    // Fresh collection per render: the listener reads live state at emit time.
    flag = 'light'
    expect(server.renderIndex('<head></head><body></body>')).toContain('window.__P__="light"')

    // Raw taps still run, over the already-rendered rows.
    const untap = server.tapIndex(h => h.replace('window.__Q__=1', 'window.__Q__=2'))
    expect(server.renderIndex('<head></head><body></body>')).toContain('window.__Q__=2')
    untap()

    // Tag-less fragments: head rows prepend, body rows append, and the
    // boot-readiness tail follows the last body row.
    expect(renderIndexInjections('<main>x</main>', [
      { kind: 'script', placement: 'head', text: 'H' },
      { kind: 'script', placement: 'body', text: 'B' },
    ])).toBe(
      '<script>H</script><main>x</main><script>B</script>'
      + '<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>',
    )

    // A global without a value assigns `undefined`; attributed tags still match.
    expect(renderIndexInjections('<HEAD lang="en"><body class="x">', [
      { kind: 'global', name: 'flag', value: undefined },
      { kind: 'html', placement: 'body', html: '<b/>' },
    ])).toBe(
      '<HEAD lang="en"><script>globalThis["flag"] = undefined</script><body class="x"><b/>'
      + '<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>',
    )

    // An empty table still carries the boot-readiness tail: the client entry
    // awaits it before reading injected state, so a page with no rows must
    // settle it rather than hang.
    expect(renderIndexInjections('<main/>', []))
      .toBe('<main/><script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>')

    // A row of unknown kind is a programming error at the renderer.
    expect(() => renderIndexInjections('', [{ kind: 'bogus' } as unknown as Parameters<typeof renderIndexInjections>[1][number]]))
      .toThrow(/unknown index injection row/)
  })
})

describe('webserver invariant companion', () => {
  it('passes fiber teardown while route disposers stay symmetric, and tolerates a composition without a carrier', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(WebServerInvariant)
    // No webserver row yet: the teardown probe has nothing to check.
    const probeFiber = await ctx.plugin(() => {})
    await probeFiber.dispose()

    await ctx.plugin(TestWebServer)
    const server = ctx.webServer
    const dispose = server.register({ kind: 'exact', path: '/live', handler: () => text('') })
    const fiber = await ctx.plugin(() => {})
    await expect(fiber.dispose()).resolves.toBeUndefined()
    // The probe leaves no residue behind on its reserved paths.
    expect(() => server.register({ kind: 'exact', path: '/__dsh_invariant_probe__', handler: () => text('') })).not.toThrow()
    expect(() => server.registerUpgrade({ path: '/__dsh_invariant_upgrade_probe__', open: () => {} })).not.toThrow()
    dispose()
  })

  it('fails a fiber lifecycle once a route disposer leaves its route registered', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(WebServerInvariant)
    await ctx.plugin(TestWebServer)
    const server = ctx.webServer
    const register = server.register.bind(server)
    // A disposer that forgets its route: the second probe cycle hits the duplicate.
    server.register = (route) => {
      register(route)
      return () => {}
    }
    // The teardown-stream observer also fires at plugin publication, where the
    // failure escapes synchronously from the registering call.
    expect(() => ctx.plugin(() => {}))
      .toThrow(/invariant violated by "@deepseek-ai\/dsh-host-webserver": webServer route disposer left a route registered/)
  })

  it('reserves the package name against duplicate registration', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(WebServerInvariant)
    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-host-webserver', () => {})
    }).toThrow(/already registered/)
  })
})
