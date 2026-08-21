/** Node half: registers the /api prefix route bridging to the api gateway. */
import { request as httpRequest } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { ApiProxy, MuxFrame, RpcRequest, ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { RpcId, type ClientRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { WEBSOCKET_OPEN, WebServer, type WebServerSocket } from '@deepseek-ai/dsh-host-webserver'
import { NodeWebServer } from '@deepseek-ai/dsh-host-webserver-node'
import { API_PATH, apply, HOST_EVENTS_PATH, inject, MUX_EVENTS_PATH, type HostConnectionHandle } from '../src/index.ts'

/** A carrier with no listener of its own: the platform-driven provider shape. */
class TestWebServer extends WebServer {
  override get address(): undefined { return undefined }
}

/** An accepted socket as a provider hands it over: records frames and close calls. */
class FakeSocket implements WebServerSocket {
  readyState = WEBSOCKET_OPEN
  readonly frames: ServerRequest[] = []
  readonly closes: { code: number | undefined; reason: string | undefined }[] = []
  private readonly closeListeners: (() => void)[] = []

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof data !== 'string') throw new TypeError('the downlink sends text frames only')
    this.frames.push(JSON.parse(data) as ServerRequest)
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
    this.readyState = 3
    for (const listener of this.closeListeners) listener()
  }

  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close' | 'error', listener: () => void): void
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    if (type === 'close') this.closeListeners.push(() => { listener({ data: undefined }) })
  }
}

const ORIGIN = 'http://127.0.0.1'

/** Bodyless GET carrying the given headers (enough for the trust fence + bridge). */
function get(headers: Record<string, string>, path = `${API_PATH}/session.list`): Request {
  return new Request(`${ORIGIN}${path}`, { method: 'GET', headers })
}

/** JSON POST carrying a complete client-request envelope. */
function post(headers: Record<string, string>, path: string, body: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** Raw POST for malformed-body and media-type boundary cases. */
function rawPost(headers: Record<string, string>, path: string, body: string): Request {
  return new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body })
}

async function status(response: Promise<Response> | Response): Promise<number> {
  return (await response).status
}

/** A source that stays open until aborted, reporting the signal it was given; both downlinks share it. */
function muxSource(): { api: ApiProxy; state: { signal?: AbortSignal; finished: boolean } } {
  const state: { signal?: AbortSignal; finished: boolean } = { finished: false }
  const frames = async function * (signal: AbortSignal): AsyncGenerator<RpcRequest<MuxFrame>> {
    state.signal = signal
    try {
      yield { rpcId: RpcId('mux-1'), payload: { type: 'session/subscribed', sessionId: 'session-1' as never, lastSeq: 4 } }
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    } finally {
      state.finished = true
    }
  }
  return {
    state,
    api: {
      events: {
        mux: (_request: unknown, signal: AbortSignal) => frames(signal),
        // The host downlink is pumped the same way; the frame type does not
        // matter to the carrier, only that a frame reaches the socket.
        host: (_request: unknown, signal: AbortSignal) => frames(signal),
      },
    } as unknown as ApiProxy,
  }
}

/** Mount the plugin on a fresh carrier; `apiProxy: null` mounts without an API Proxy. */
async function mounted(
  config?: { trustedHosts?: string[]; maxRequestBodyBytes?: number },
  apiProxy: ApiProxy | null = {} as ApiProxy,
): Promise<{
  ctx: Context
  server: WebServer
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const server = new TestWebServer(ctx)
  if (apiProxy !== null) ctx.provide('apiProxy', apiProxy)
  const fiber = ctx.plugin({ inject: [...inject], apply }, config)
  await fiber.await()
  return { ctx, server, dispose: () => fiber.dispose() }
}

describe('connection node half', () => {
  it('fails loud when the carrier cap cannot hold the configured image batch', async () => {
    const ctx = new Context()
    const server = new TestWebServer(ctx)
    ctx.provide('attachments', {
      imageLimits: { maxMessageImageBytes: 20 * 1024 * 1024 },
    } as AttachmentStore)
    ctx.provide('apiProxy', {} as ApiProxy)
    expect(() => { apply(ctx, { maxRequestBodyBytes: 1024 }) })
      .toThrow(/must be at least .* aggregate image limit/)
    expect(await status(server.fetch(get({ host: '127.0.0.1' })))).toBe(404)
  })

  it('fails the load on a trustedHosts entry that is not a bare authority', async () => {
    const ctx = new Context()
    const server = new TestWebServer(ctx)
    ctx.provide('apiProxy', {} as ApiProxy)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.internal/path'] })
    await expect(fiber).rejects.toThrow(/not a bare host\[:port\] authority/)
    expect(await status(server.fetch(get({ host: '127.0.0.1' })))).toBe(404)
    expect(server.upgradeRoute(MUX_EVENTS_PATH)).toBeUndefined()
  })

  it('registers one HTTP route plus one upgrade route per downlink and removes all three with the fiber', async () => {
    const { server, dispose } = await mounted()
    // The /api prefix answers (426 is the route's own answer, so it is mounted).
    expect(await status(server.fetch(get({ host: '127.0.0.1' }, MUX_EVENTS_PATH)))).toBe(426)
    expect(server.upgradeRoute(MUX_EVENTS_PATH)?.path).toBe(MUX_EVENTS_PATH)
    expect(server.upgradeRoute(HOST_EVENTS_PATH)?.path).toBe(HOST_EVENTS_PATH)
    await dispose()
    expect(await status(server.fetch(get({ host: '127.0.0.1' }, MUX_EVENTS_PATH)))).toBe(404)
    expect(server.upgradeRoute(MUX_EVENTS_PATH)).toBeUndefined()
    expect(server.upgradeRoute(HOST_EVENTS_PATH)).toBeUndefined()
  })

  it('requires WebSocket upgrade for network GETs to either event path', async () => {
    const { server, dispose } = await mounted()
    for (const path of [MUX_EVENTS_PATH, HOST_EVENTS_PATH]) {
      const response = await server.fetch(get({ host: '127.0.0.1:3080' }, path))
      expect(response.status).toBe(426)
      expect(response.headers.get('upgrade')).toBe('websocket')
      await expect(response.text()).resolves.toBe('upgrade required')
    }
    await dispose()
  })

  it('decides an upgrade before the handshake: untrusted refused with 403, trusted accepted', async () => {
    const { server, dispose } = await mounted()
    const route = server.upgradeRoute(MUX_EVENTS_PATH)!
    const refusal = route.authorize!(get({
      host: 'harness.example', origin: 'http://harness.example', 'sec-fetch-site': 'same-origin',
    }, MUX_EVENTS_PATH))
    expect(refusal?.status).toBe(403)
    await expect(refusal!.text()).resolves.toBe('forbidden')
    expect(route.authorize!(get({ host: '127.0.0.1:3080' }, MUX_EVENTS_PATH))).toBeUndefined()
    await dispose()
  })

  it('pumps each accepted socket from its own downlink and closes them all on disposal', async () => {
    const mux = muxSource()
    const { server, dispose } = await mounted(undefined, mux.api)
    const socket = new FakeSocket()
    const request = get({ host: '127.0.0.1:3080' }, MUX_EVENTS_PATH)
    const pump = server.upgradeRoute(MUX_EVENTS_PATH)!.open(request, socket)
    await vi.waitFor(() => { expect(socket.frames).toHaveLength(1) })
    expect(socket.frames[0]).toMatchObject({ type: 'server-request', rpcId: 'mux-1', method: 'session/subscribed' })
    const hostSocket = new FakeSocket()
    const hostPump = server.upgradeRoute(HOST_EVENTS_PATH)!.open(request, hostSocket)
    await vi.waitFor(() => { expect(hostSocket.frames).toHaveLength(1) })

    await dispose()
    await Promise.all([pump, hostPump])
    expect(socket.closes).toEqual([{ code: 1001, reason: 'server shutting down' }])
    expect(hostSocket.closes).toEqual([{ code: 1001, reason: 'server shutting down' }])
    expect(mux.state.signal?.aborted).toBe(true)
    expect(mux.state.finished).toBe(true)
  })

  it('refuses an untrusted Host on any /api path before the bridge runs', async () => {
    const { server, dispose } = await mounted()
    const response = await server.fetch(get({
      host: 'harness.example', origin: 'http://harness.example', 'sec-fetch-site': 'same-origin',
    }))
    expect(response.status).toBe(403)
    await expect(response.text()).resolves.toBe('forbidden')
    await dispose()
  })

  it('pins privileged methods to loopback even for a declared trusted authority', async () => {
    const { server, dispose } = await mounted({ trustedHosts: ['harness.example'] })
    // The privileged set: native dialogs plus the whole settings/credential
    // configuration plane, reads included, plus the one method that makes the
    // host fetch a caller-chosen URL. The same declared authority reaches
    // ordinary reads (carrier-level 404 from the empty proxy proves the fence
    // passed), but each privileged method stays loopback-only and 403s.
    for (const method of [
      'host.pickDirectory', 'host.openPath',
      'settings.describe', 'settings.openDocument', 'settings.update', 'settings.replace', 'settings.mutate',
      'credentials.describe', 'credentials.set', 'credentials.unset',
      'llm.discoverModels',
      // A composition names the plugins a session runs: reading one is
      // reconnaissance, and copy/remove/openDocument manage the roster and
      // drive the host desktop.
      'agentPreset.read', 'agentPreset.copy', 'agentPreset.openDocument', 'agentPreset.remove',
    ]) {
      const denied = await server.fetch(get({ host: 'harness.example' }, `${API_PATH}/${method}`))
      expect([method, denied.status]).toEqual([method, 403])
      await expect(denied.text()).resolves.toBe('forbidden')
    }
    expect(await status(server.fetch(get({ host: 'harness.example' })))).not.toBe(403)
    await dispose()
  })

  it('passes loopback and declared-authority requests through to the bridge', async () => {
    const { server, dispose } = await mounted({ trustedHosts: ['harness.example:3080', '192.168.1.5'] })
    // Loopback, no browser markers (curl shape): the fence passes; the carrier
    // answers 404 for a GET unary path — proof the bridge ran.
    expect(await status(server.fetch(get({ host: '127.0.0.1:3080' })))).toBe(404)
    // An all-interfaces composition derives port-less LAN IP literals, which
    // pass markerless curl on any port.
    expect(await status(server.fetch(get({ host: '192.168.1.5:3080' })))).toBe(404)
    // Declared public authority, same-origin browser shape.
    expect(await status(server.fetch(get({
      host: 'harness.example:3080', origin: 'http://harness.example:3080', 'sec-fetch-site': 'same-origin',
    })))).toBe(404)
    await dispose()
  })

  it('hands an unclaimed /api request to the API Proxy fetch carrier when one is present', async () => {
    const respond = vi.fn(async () => ({ accepted: true }))
    const { server, dispose } = await mounted(undefined, { respond } as unknown as ApiProxy)
    const response = await server.fetch(post({ host: '127.0.0.1' }, `${API_PATH}/respond`, {
      type: 'client-response', rpcId: 'rpc-1', result: { ok: true, value: null },
    }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ accepted: true })
    expect(respond).toHaveBeenCalledOnce()
    await dispose()
  })

  it('answers 404 on the shared channel when no API Proxy is present', async () => {
    const { server, dispose } = await mounted(undefined, null)
    expect(await status(server.fetch(get({ host: '127.0.0.1' })))).toBe(404)
    expect(await status(server.fetch(post({ host: '127.0.0.1' }, `${API_PATH}/respond`, {})))).toBe(404)
    expect(server.upgradeRoute(MUX_EVENTS_PATH)).toBeUndefined()
    await dispose()
  })

  it('caps every /api body at the configured size before any handler reads it', async () => {
    const { ctx, server, dispose } = await mounted({ maxRequestBodyBytes: 128 })
    const connection = ctx.get('connection') as HostConnectionHandle
    const payloads: unknown[] = []
    const remove = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'goals/create',
      async (_endpoint, payload) => {
        payloads.push(payload)
        return { ok: true, value: null }
      },
      { authority: 'trusted-host' },
    )
    const envelope = (title: string): ClientRequest => ({
      type: 'client-request', rpcId: RpcId('rpc-cap'), method: 'goals/create', payload: { title },
    })

    const declared = await server.fetch(new Request(`${ORIGIN}${API_PATH}/goals/create`, {
      method: 'POST',
      headers: { host: '127.0.0.1', 'content-type': 'application/json', 'content-length': '129' },
      body: new ReadableStream<Uint8Array>({
        pull() { throw new Error('a declared oversize body must never be read') },
      }),
      duplex: 'half',
    } as RequestInit))
    expect(declared.status).toBe(413)
    expect(declared.headers.get('connection')).toBe('close')

    const chunked = await server.fetch(new Request(`${ORIGIN}${API_PATH}/goals/create`, {
      method: 'POST',
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(100))
          controller.enqueue(new Uint8Array(100))
          controller.close()
        },
      }),
      duplex: 'half',
    } as RequestInit))
    expect(chunked.status).toBe(413)
    expect(payloads).toHaveLength(0)

    const accepted = await server.fetch(post({ host: '127.0.0.1' }, `${API_PATH}/goals/create`, envelope('x')))
    expect(accepted.status).toBe(200)
    expect(payloads).toEqual([{ title: 'x' }])
    await remove()
    await dispose()
  })

  it('provides a disposable dedicated RPC channel without requiring apiProxy', async () => {
    const ctx = new Context()
    const server = new TestWebServer(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const connection = ctx.get('connection') as HostConnectionHandle
    const calls: unknown[] = []
    const remove = connection.rpc.handle('/rpc', async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: { accepted: true } }
    }, { authority: 'trusted-host' })

    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('rpc-dedicated'),
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }
    const result = await server.fetch(post({ host: '127.0.0.1:3080' }, '/rpc/goals/create', request))
    expect(result.status).toBe(200)
    await expect(result.json()).resolves.toEqual({
      type: 'server-response',
      rpcId: 'rpc-dedicated',
      result: { ok: true, value: { accepted: true } },
    })
    expect(calls).toEqual([{
      endpoint: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }])

    expect(() => connection.rpc.handle('/rpc', async () => ({ ok: true, value: null }), {
      authority: 'trusted-host',
    })).toThrow(/duplicate prefix route/)
    await remove()
    expect(await status(server.fetch(post({ host: '127.0.0.1:3080' }, '/rpc/goals/create', request)))).toBe(404)
    expect(await status(server.fetch(get({ host: '127.0.0.1:3080' })))).toBe(404)
    await fiber.dispose()
    expect(await status(server.fetch(get({ host: '127.0.0.1:3080' }, MUX_EVENTS_PATH)))).toBe(404)
  })

  it('dispatches claimed /api endpoints before the API Proxy fallback and withdraws the claim', async () => {
    const { ctx, server, dispose } = await mounted({ trustedHosts: ['harness.example'] })
    const connection = ctx.get('connection') as HostConnectionHandle
    const calls: unknown[] = []
    const remove = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'goals/create',
      async (endpoint, payload) => {
        calls.push({ endpoint, payload })
        return { ok: true, value: { accepted: true } }
      },
      { authority: 'trusted-host' },
    )
    expect(() => connection.rpc.intercept(
      '/api',
      () => true,
      async () => ({ ok: true, value: null }),
      { authority: 'trusted-host' },
    )).toThrow('already has an interceptor')
    expect(() => connection.rpc.intercept(
      '/rpc' as '/api',
      () => true,
      async () => ({ ok: true, value: null }),
      { authority: 'trusted-host' },
    )).toThrow('invalid shared RPC channel')
    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('rpc-shared'),
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }

    const claimed = await server.fetch(post({ host: '127.0.0.1:3080' }, '/api/goals/create', request))
    await expect(claimed.json()).resolves.toEqual({
      type: 'server-response',
      rpcId: 'rpc-shared',
      result: { ok: true, value: { accepted: true } },
    })
    expect(calls).toEqual([{
      endpoint: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }])

    const denied = await server.fetch(post({ host: 'other.example' }, '/api/goals/create', request))
    expect(denied.status).toBe(403)
    await expect(denied.text()).resolves.toBe('forbidden')
    expect(calls).toHaveLength(1)

    expect(await status(server.fetch(get({ host: '127.0.0.1:3080' }, '/api/session.list')))).toBe(404)

    await remove()
    expect(await status(server.fetch(post({ host: '127.0.0.1:3080' }, '/api/goals/create', request)))).toBe(404)
    expect(calls).toHaveLength(1)

    const removeLoopback = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'goals/create',
      async () => ({ ok: true, value: null }),
      { authority: 'loopback' },
    )
    expect(await status(server.fetch(post({ host: 'harness.example' }, '/api/goals/create', request)))).toBe(403)
    await removeLoopback()
    await dispose()
  })

  it('applies the configured trust fence and JSON envelope checks to generic channels', async () => {
    const ctx = new Context()
    const server = new TestWebServer(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
    await fiber.await()
    const connection = ctx.get('connection') as HostConnectionHandle
    const remove = connection.rpc.handle('/rpc', async (endpoint) => {
      if (endpoint === 'fail') throw new Error('handler broke')
      return { ok: true, value: null }
    }, {
      authority: 'trusted-host',
    })

    const denied = await server.fetch(post({ host: 'other.example' }, '/rpc/goals/create', {}))
    expect(denied.status).toBe(403)
    await expect(denied.text()).resolves.toBe('forbidden')

    const methodMismatch = await server.fetch(post({ host: 'harness.example' }, '/rpc/goals/create', {
      type: 'client-request', rpcId: 'rpc-bad', method: 'other', payload: {},
    }))
    await expect(methodMismatch.json()).resolves.toMatchObject({
      rpcId: 'rpc-bad',
      result: { ok: false, error: { code: 'bad-request' } },
    })

    for (const [request, expected] of [
      [get({ host: 'harness.example' }, '/rpc/goals/create'), 404],
      [post({ host: 'harness.example' }, '/rpc', {}), 404],
      [post({ host: 'harness.example' }, '/rpc/goals//create', {}), 404],
      [rawPost({ host: 'harness.example' }, '/rpc/goals/create', '{}'), 415],
      [rawPost({ host: 'harness.example', 'content-type': 'text/plain' }, '/rpc/goals/create', '{}'), 415],
      [rawPost({ host: 'harness.example', 'content-type': 'application/json; charset=utf-8' }, '/rpc/goals/create', '{'), 400],
    ] as const) {
      expect(await status(server.fetch(request))).toBe(expected)
    }

    for (const [body, rpcId] of [
      [{ rpcId: 'retained-id' }, 'retained-id'],
      [{ rpcId: 42 }, 'invalid-request'],
      [null, 'invalid-request'],
    ] as const) {
      const response = await server.fetch(post({ host: 'harness.example' }, '/rpc/goals/create', body))
      await expect(response.json()).resolves.toMatchObject({
        rpcId,
        result: { ok: false, error: { code: 'bad-request' } },
      })
    }

    const failed = await server.fetch(post({ host: 'harness.example' }, '/rpc/fail', {
      type: 'client-request', rpcId: 'rpc-fail', method: 'fail', payload: {},
    }))
    expect(failed.status).toBe(500)
    await expect(failed.text()).resolves.toBe('handler failure: Error: handler broke')

    expect(() => connection.rpc.handle('/api', async () => ({ ok: true, value: null }), {
      authority: 'loopback',
    })).toThrow('invalid or reserved RPC channel')
    expect(() => connection.rpc.handle('api3', async () => ({ ok: true, value: null }), {
      authority: 'loopback',
    })).toThrow('invalid or reserved RPC channel')

    const removeLoopback = connection.rpc.handle('/loopback', async () => ({ ok: true, value: null }), {
      authority: 'loopback',
    })
    expect(await status(server.fetch(post({ host: 'harness.example' }, '/loopback/read', {
      type: 'client-request', rpcId: 'rpc-public', method: 'read', payload: {},
    })))).toBe(403)
    await removeLoopback()
    await remove()
    await fiber.dispose()
  })
})

describe('connection node half over a real HTTP server', () => {
  /** One real request; `host` spoofs the authority the way a LAN client's browser would send it. */
  function call(port: number, method: string, host: string): Promise<number> {
    // node:http, not fetch: `host` is a forbidden request header for fetch.
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        { host: '127.0.0.1', port, path: `${API_PATH}/${method}`, method: 'GET', headers: { host } },
        (response) => {
          response.resume()
          response.on('end', () => { resolve(response.statusCode ?? 0) })
        },
      )
      request.on('error', reject)
      request.end()
    })
  }

  it('answers a declared LAN authority with 403 on every configuration method, over real HTTP', async () => {
    // The fence's input is the Request the Node carrier builds from the wire,
    // not a hand-assembled object: the Host header a LAN browser sends is
    // exactly what decides loopback-only here, so the boundary is asserted
    // against the parse the server actually performs.
    const ctx = new Context()
    ctx.provide('apiProxy', {} as ApiProxy)
    const webServerFiber = ctx.plugin(NodeWebServer, { host: '127.0.0.1', port: 0 })
    await webServerFiber.await()
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
    await fiber.await()
    const { port } = ctx.webServer.address!
    try {
      // Reads are as privileged as writes: describe returns the exposed
      // configuration, and credentials.describe probes arbitrary env-var names.
      for (const method of [
        'settings.describe', 'settings.openDocument', 'settings.update', 'settings.replace', 'settings.mutate',
        'credentials.describe', 'credentials.set', 'credentials.unset',
        'host.pickDirectory', 'host.openPath',
        // Carries a draft credential and turns the host into a fetcher for a
        // URL the caller picked: an anonymous LAN caller must not reach it.
        'llm.discoverModels',
        'agentPreset.read', 'agentPreset.copy', 'agentPreset.openDocument', 'agentPreset.remove',
      ]) {
        expect([method, await call(port, method, 'harness.example')]).toEqual([method, 403])
      }
      // The model catalog stays reachable for the same authority: a LAN
      // client's model picker needs it, and it carries no key or endpoint
      // state (404 is the empty proxy's carrier answer — the fence passed).
      // `agentPreset.list` joins the model catalog for the same reason: ids and
      // trust only, and a LAN client's preset picker needs it. `select` is
      // reachable too: `session.create` already takes an `agentPreset`, and the
      // deployment's own default already carries bash, so pinning the switch
      // would be a fence beside an open gate.
      for (const method of ['llm.providers', 'llm.models', 'agentPreset.list', 'agentPreset.select']) {
        expect([method, await call(port, method, 'harness.example')]).toEqual([method, 404])
      }
      // Loopback reaches everything, configuration included.
      expect(await call(port, 'settings.describe', `127.0.0.1:${String(port)}`)).toBe(404)
    } finally {
      await fiber.dispose()
      await webServerFiber.dispose()
    }
  })
})
