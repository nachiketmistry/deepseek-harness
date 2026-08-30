/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the Node web carrier row, and every assertion
 * observes the user-visible surface of the listening server — the bound
 * address, the Fetch bridge in both directions (Host-derived URL, streamed
 * bodies, client-departure abort, backpressure), per-request failure
 * containment, WebSocket routes through a real `ws` client, and teardown.
 */

import { EventEmitter, once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { WEBSOCKET_OPEN, WebServer, type WebServerSocket } from '@deepseek-ai/dsh-host-webserver'
import WebSocket from 'ws'
import NodeWebServer, { toFetchRequest, writeFetchResponse } from '../src/index.ts'
import * as NodeWebServerInvariant from '../src/invariant.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write a cordis.yml with one webserver-node row, then boot it through the real Loader. */
async function loadComposition(port = 0): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-webserver-node-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver-node'",
    '  config:',
    "    host: '127.0.0.1'",
    `    port: ${String(port)}`,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver-node', NodeWebServer],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** Boot the composition and return its carrier with the bound port. */
async function boot(): Promise<{ loaded: Context; server: WebServer; port: number }> {
  const loaded = await loadComposition()
  const unloaded = [...loaded.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  expect(unloaded).toEqual([])
  const server = loaded.webServer
  expect(server).toBeInstanceOf(NodeWebServer)
  expect(server.address).toMatchObject({ host: '127.0.0.1' })
  const port = server.address!.port
  expect(port).toBeGreaterThan(0)
  return { loaded, server, port }
}

const text = (body: string, status = 200): Response => new Response(body, { status })

/** GET (by default) one path against the running server; returns status plus a body prefix. */
async function request(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
  return { status: response.status, body: (await response.text()).slice(0, 80) }
}

/** Open one ws client and settle on its first terminal event. */
function wsClient(port: number, path: string, headers?: Record<string, string | string[]>): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${String(port)}${path}`, { headers })
}

/** Read an `unexpected-response` handshake answer: status, headers, and body. */
function unexpectedResponse(client: WebSocket): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
  return new Promise((resolve, reject) => {
    client.once('error', reject)
    client.once('unexpected-response', (_req, res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.once('end', () => {
        resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() })
      })
    })
  })
}

describe('real Loader composition', () => {
  // Real-Loader composition resolves workspace packages through tsx at test
  // time; first resolution after the host/client program split is slow enough
  // to trip the default 5s budget on cold caches.
  it('serves registered routes and the fallback seat, contains per-request failures, and closes every connection on teardown', { timeout: 60_000 }, async () => {
    const { loaded, server, port } = await boot()
    const warn = vi.spyOn(loaded.logger, 'warn').mockImplementation(() => {})

    // Routing precedence is the Service Definition's; the listener delivers it.
    server.register({ kind: 'exact', path: '/probe', handler: () => text('EXACT') })
    server.register({ kind: 'prefix', path: '/api', handler: () => text('API') })
    expect(await request(port, '/probe')).toEqual({ status: 200, body: 'EXACT' })
    expect(await request(port, '/api/anything', { method: 'POST' })).toEqual({ status: 200, body: 'API' })
    expect((await request(port, '/no/such/route')).status).toBe(404)

    // The fallback owner decodes like a real static server would — a malformed
    // %-escape throws there, probing the per-request error containment: 400,
    // one warning, and the server keeps serving afterwards.
    server.registerFallback((req) => {
      decodeURIComponent(new URL(req.url).pathname)
      return new Response(server.applyIndexTaps('<head></head><body>shell</body>'), { headers: { 'content-type': 'text/html' } })
    })
    expect((await request(port, '/no/such/route')).body).toContain('shell')
    expect((await request(port, '/%zz')).status).toBe(400)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toBeInstanceOf(URIError)
    expect(await request(port, '/probe')).toEqual({ status: 200, body: 'EXACT' })

    // A non-Error rejection is wrapped before it reaches the log.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the scenario under test.
    server.register({ kind: 'exact', path: '/reject-string', handler: () => Promise.reject('plain failure') })
    expect((await request(port, '/reject-string')).status).toBe(400)
    expect(warn.mock.calls[1]![0]).toEqual(new Error('plain failure'))

    // A body stream failing after the headers went out cannot become a 400:
    // the connection is destroyed so the client sees a truncated response.
    server.register({
      kind: 'exact',
      path: '/mid-stream',
      handler: () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('partial')) },
        pull() { throw new Error('mid-stream failure') },
      })),
    })
    // Whether the first chunk was flushed before the destroy decides whether
    // the headers or the body read fails; neither can complete.
    await expect(fetch(`http://127.0.0.1:${String(port)}/mid-stream`).then(response => response.text())).rejects.toThrow()
    expect(warn.mock.calls[2]![0]).toEqual(new Error('mid-stream failure'))
    expect(await request(port, '/probe')).toEqual({ status: 200, body: 'EXACT' })

    // A keep-alive connection held by the client and an accepted WebSocket
    // both close before teardown resolves.
    let serverSocketClosed = false
    server.registerUpgrade({
      path: '/events',
      open: (_request, socket) => {
        socket.addEventListener('close', () => { serverSocketClosed = true })
      },
    })
    const client = wsClient(port, '/events?stream=mux')
    await once(client, 'open')
    // A terminated socket is a reset on the client side: an error precedes
    // the abnormal close, so both are collected explicitly.
    client.on('error', () => {})
    const clientClosed = new Promise<number>((resolve) => { client.once('close', resolve) })
    const idle = connect(port, '127.0.0.1')
    idle.on('error', () => {})
    await once(idle, 'connect')
    const idleClosed = new Promise<void>((resolve) => { idle.once('close', () => { resolve() }) })

    await loaded.fiber.dispose()
    expect(serverSocketClosed).toBe(true)
    expect(await clientClosed).toBe(1006)
    await idleClosed
    await expect(request(port, '/probe')).rejects.toThrow()
  })

  it('bridges requests into Fetch requests: Host authority, multi-value headers, streamed body, and departure abort', { timeout: 60_000 }, async () => {
    const { server, port } = await boot()
    const seen: { url: string; method: string; cookies: string[]; json: unknown }[] = []
    server.register({
      kind: 'prefix',
      path: '/echo',
      handler: async (req) => {
        seen.push({
          url: req.url,
          method: req.method,
          cookies: req.headers.getSetCookie(),
          json: req.method === 'GET' ? null : await req.json(),
        })
        return Response.json({ ok: true })
      },
    })

    // The request URL carries the authority the client addressed, not the
    // bound interface; repeated headers survive as repeated entries.
    const answered = new Promise<IncomingMessage>((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        path: '/echo/path?q=1',
        method: 'POST',
        setHost: false,
        headers: { host: 'app.example.test:8443', 'set-cookie': ['a=1', 'b=2'], 'content-type': 'application/json' },
      }, resolve)
      // Two chunks on separate ticks: the body reaches the handler as a stream.
      req.write('{"first":')
      setTimeout(() => { req.end('true}') }, 20)
    })
    const answer = await answered
    answer.resume()
    await once(answer, 'end')
    expect(seen).toEqual([{
      url: 'http://app.example.test:8443/echo/path?q=1',
      method: 'POST',
      cookies: ['a=1', 'b=2'],
      json: { first: true },
    }])

    // A GET carries no body stream.
    expect(await request(port, '/echo')).toEqual({ status: 200, body: '{"ok":true}' })
    expect(seen[1]).toMatchObject({ method: 'GET', json: null })

    // The request signal aborts when the client goes away before the
    // response ends — how a pending picker or SSE handler learns to stop.
    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => { resolveStarted = resolve })
    let outcome: Promise<boolean> | undefined
    server.register({
      kind: 'exact',
      path: '/pending',
      handler: (req) => {
        outcome = new Promise<boolean>((resolve) => {
          req.signal.addEventListener('abort', () => { resolve(req.signal.aborted) }, { once: true })
        })
        resolveStarted()
        return outcome.then(aborted => Response.json({ aborted }))
      },
    })
    const departing = new AbortController()
    const pending = fetch(`http://127.0.0.1:${String(port)}/pending`, { signal: departing.signal })
    await started
    departing.abort()
    await expect(pending).rejects.toThrow()
    await expect(outcome).resolves.toBe(true)
    expect(await request(port, '/echo')).toMatchObject({ status: 200 })
  })

  it('writes Fetch responses: set-cookie fan-out, null bodies, and streamed bodies under backpressure', { timeout: 60_000 }, async () => {
    const { server, port } = await boot()
    server.register({
      kind: 'exact',
      path: '/cookies',
      handler: () => {
        const response = new Response(null, { status: 204 })
        response.headers.append('set-cookie', 'a=1; Path=/')
        response.headers.append('set-cookie', 'b=2; Path=/')
        response.headers.set('x-one', 'one')
        return response
      },
    })
    const cookies = await fetch(`http://127.0.0.1:${String(port)}/cookies`)
    expect(cookies.status).toBe(204)
    expect(cookies.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/'])
    expect(cookies.headers.get('x-one')).toBe('one')
    expect(await cookies.text()).toBe('')

    // A large streamed body reaches a slow consumer intact: the bridge waits
    // for drain instead of buffering the whole stream.
    const CHUNK = 1 << 20
    const CHUNKS = 32
    let pulled = 0
    server.register({
      kind: 'exact',
      path: '/stream',
      handler: () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled === CHUNKS) {
            controller.close()
            return
          }
          pulled += 1
          controller.enqueue(new Uint8Array(CHUNK).fill(pulled))
        },
      })),
    })
    const streamed = await fetch(`http://127.0.0.1:${String(port)}/stream`)
    const reader = streamed.body!.getReader()
    let received = 0
    let first = await reader.read()
    received += first.value!.byteLength
    // The producer has not been drained into memory while the consumer idles.
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    expect(pulled).toBeLessThan(CHUNKS)
    while (!first.done) {
      first = await reader.read()
      if (first.value !== undefined) received += first.value.byteLength
    }
    expect(received).toBe(CHUNK * CHUNKS)
    expect(pulled).toBe(CHUNKS)

    // A consumer that leaves while the bridge waits for drain releases the
    // bridge: the pending write resolves on close and the body stream is
    // cancelled instead of parking the request forever.
    let cancelProducer: () => void
    const producerCancelled = new Promise<void>((resolve) => { cancelProducer = resolve })
    server.register({
      kind: 'exact',
      path: '/stream-leave',
      handler: () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(CHUNK)) },
        cancel() { cancelProducer() },
      })),
    })
    const leaving = new AbortController()
    const left = await fetch(`http://127.0.0.1:${String(port)}/stream-leave`, { signal: leaving.signal })
    await left.body!.getReader().read()
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    leaving.abort()
    await producerCancelled
    expect(await request(port, '/cookies')).toMatchObject({ status: 204 })
  })

  it('routes WebSocket upgrades: unknown paths, authorize refusals, accepted sockets, and error containment', { timeout: 60_000 }, async () => {
    const { loaded, server, port } = await boot()
    const warn = vi.spyOn(loaded.logger, 'warn').mockImplementation(() => {})

    // Unknown path: the socket is destroyed before any handshake.
    const unknown = wsClient(port, '/nowhere')
    const [unknownError] = await once(unknown, 'error') as [Error]
    expect(unknownError.message).toMatch(/socket hang up|ECONNRESET/)

    // Authorize refusal: the client reads the refusal as the plain HTTP
    // answer — status, headers, and body — and the connection closes.
    const authorized: string[] = []
    server.registerUpgrade({
      path: '/guarded',
      authorize: (req) => {
        authorized.push(req.url)
        if (req.headers.get('x-token') === 'ok') return undefined
        if (req.headers.get('x-token') === 'named') return new Response('named refusal', { status: 401, statusText: 'Unauthorized' })
        return new Response('forbidden', { status: 403, headers: { 'x-reason': 'fence' } })
      },
      open: (_req, socket) => { socket.send('welcome') },
    })
    const refused = await unexpectedResponse(wsClient(port, '/guarded?x=1', { 'set-cookie': ['a=1', 'b=2'] }))
    expect(refused).toMatchObject({ status: 403, body: 'forbidden' })
    expect(refused.headers).toMatchObject({ 'x-reason': 'fence', connection: 'close', 'content-length': '9' })
    expect(authorized).toEqual([`http://127.0.0.1:${String(port)}/guarded?x=1`])
    const named = await unexpectedResponse(wsClient(port, '/guarded', { 'x-token': 'named' }))
    expect(named).toMatchObject({ status: 401, body: 'named refusal' })

    // Accepted: the route's socket reaches the client in both directions, and
    // a close from either side completes on the other.
    const opened: { request: Request; socket: WebServerSocket }[] = []
    const serverMessages: unknown[] = []
    server.registerUpgrade({
      path: '/chat',
      open: (req, socket) => {
        opened.push({ request: req, socket })
        socket.addEventListener('message', (event) => {
          serverMessages.push(event.data)
          socket.send(`echo:${String(event.data)}`)
        })
        socket.addEventListener('error', () => {})
      },
    })
    const admitted = wsClient(port, '/guarded', { 'x-token': 'ok' })
    const [welcome] = await once(admitted, 'message') as [Buffer]
    expect(String(welcome)).toBe('welcome')
    admitted.close(1000, 'done')
    await once(admitted, 'close')

    const chat = wsClient(port, '/chat')
    await once(chat, 'open')
    expect(opened).toHaveLength(1)
    expect(opened[0]!.request.url).toBe(`http://127.0.0.1:${String(port)}/chat`)
    expect(opened[0]!.socket.readyState).toBe(WEBSOCKET_OPEN)
    chat.send('hello')
    const [echo] = await once(chat, 'message') as [Buffer]
    expect(String(echo)).toBe('echo:hello')
    expect(serverMessages.map(String)).toEqual(['hello'])
    // Server-initiated close reaches the client with its code and reason.
    const serverClosed = once(chat, 'close')
    opened[0]!.socket.close(4000, 'server says bye')
    const [closeCode, closeReason] = await serverClosed as [number, Buffer]
    expect(closeCode).toBe(4000)
    expect(String(closeReason)).toBe('server says bye')

    // Client-initiated close reaches the route's close listener.
    const closedOnServer = new Promise<void>((resolve) => {
      server.registerUpgrade({
        path: '/closer',
        open: (_req, socket) => { socket.addEventListener('close', () => { resolve() }) },
      })
    })
    const closer = wsClient(port, '/closer')
    await once(closer, 'open')
    closer.close()
    await closedOnServer

    // A route whose open() rejects is contained: one warning and the socket
    // is destroyed; an error on the raw socket after acceptance is contained
    // the same way. Plain HTTP keeps serving afterwards.
    server.registerUpgrade({
      path: '/open-fails',
      open: async () => {
        await Promise.resolve()
        throw new Error('open failure')
      },
    })
    const failing = wsClient(port, '/open-fails')
    await once(failing, 'open')
    await once(failing, 'close')
    expect(warn).toHaveBeenCalledWith(new Error('open failure'))
    server.registerUpgrade({
      path: '/open-rejects-string',
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the scenario under test.
      open: () => Promise.reject('plain open failure'),
    })
    const failingPlain = wsClient(port, '/open-rejects-string')
    await once(failingPlain, 'open')
    await once(failingPlain, 'close')
    expect(warn).toHaveBeenCalledWith(new Error('plain open failure'))
    server.registerUpgrade({
      path: '/raw-error',
      open: (_req, socket) => {
        // Only the accepted ws socket exposes its raw transport.
        (socket as unknown as { _socket: { destroy(error: Error): void } })._socket.destroy(new Error('raw transport failure'))
      },
    })
    const rawError = wsClient(port, '/raw-error')
    await once(rawError, 'open')
    await once(rawError, 'close')
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(new Error('raw transport failure')) })
    server.register({ kind: 'exact', path: '/probe', handler: () => text('EXACT') })
    expect(await request(port, '/probe')).toEqual({ status: 200, body: 'EXACT' })

    // An upgrade without a Host header (HTTP/1.0) still reaches the route's
    // authorize decision with the default authority.
    const hostless = connect(port, '127.0.0.1')
    hostless.on('error', () => {})
    await once(hostless, 'connect')
    const hostlessAnswer = new Promise<string>((resolve) => {
      const chunks: Buffer[] = []
      hostless.on('data', (chunk: Buffer) => chunks.push(chunk))
      hostless.once('close', () => { resolve(Buffer.concat(chunks).toString()) })
    })
    hostless.write('GET /guarded HTTP/1.0\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    expect(await hostlessAnswer).toContain('403')
    expect(authorized.at(-1)).toBe('http://localhost/guarded')

    // A listener error after binding is logged rather than thrown.
    const error = vi.spyOn(loaded.logger, 'error').mockImplementation(() => {})
    ;(server as unknown as { server: EventEmitter }).server.emit('error', new Error('listener failure'))
    expect(error).toHaveBeenCalledWith(new Error('listener failure'))
  })

  it('fails the fiber when the port is already taken (fail-loud at activation)', { timeout: 60_000 }, async () => {
    const first = await loadComposition()
    const takenPort = first.webServer.address!.port
    const firstRoot = root
    root = undefined // keep the first composition's files until the end

    let second: Context | undefined
    try {
      let failure: unknown
      try {
        await loadComposition(takenPort)
      } catch (error) {
        failure = error
      }
      second = context
      expect(String(failure)).toMatch(/failed to apply loader entry.*EADDRINUSE/)
    } finally {
      await second?.fiber.dispose()
      context = first
      if (root !== undefined) await rm(root, { recursive: true, force: true })
      root = firstRoot
    }
  })
})

describe('Fetch bridge helpers', () => {
  it('toFetchRequest skips absent header values and aborts when the response closes unfinished', async () => {
    const req = Readable.from([]) as unknown as IncomingMessage
    Object.assign(req, { url: '/x', method: 'GET', headers: { host: 'h', 'x-absent': undefined } })
    const res = Object.assign(new EventEmitter(), { writableEnded: false }) as unknown as ServerResponse
    const request = toFetchRequest(req, res)
    expect(request.url).toBe('http://h/x')
    expect(request.headers.has('x-absent')).toBe(false)
    expect(request.signal.aborted).toBe(false)
    res.emit('close')
    expect(request.signal.aborted).toBe(true)

    // Fields the server-side IncomingMessage type leaves optional take the
    // Fetch defaults.
    const bare = toFetchRequest(Object.assign(Readable.from([]), { headers: {} }) as unknown as IncomingMessage, res)
    expect(bare.method).toBe('GET')
    expect(bare.url).toBe('http://localhost/')

    // A normal end() also closes the response, without aborting the request.
    const ended = Object.assign(new EventEmitter(), { writableEnded: true }) as unknown as ServerResponse
    const finished = toFetchRequest(req, ended)
    ended.emit('close')
    expect(finished.signal.aborted).toBe(false)
  })

  it('toFetchRequest surfaces body stream failures and cancels by draining the request', async () => {
    const failing = Object.assign(new Readable({ read() {} }), {
      url: '/x', method: 'POST', headers: {},
    }) as unknown as IncomingMessage
    const res = Object.assign(new EventEmitter(), { writableEnded: false }) as unknown as ServerResponse
    const request = toFetchRequest(failing, res)
    const reading = request.text()
    failing.destroy(new Error('body failure'))
    await expect(reading).rejects.toThrow('body failure')

    // Drained, not destroyed: a handler that stops reading (an over-cap body
    // refused with 413) still has a response to write, and destroying the
    // request would reset the connection before it went out.
    let resumed = 0
    let destroys = 0
    const cancelled = Object.assign(new Readable({ read() {} }), {
      url: '/x', method: 'POST', headers: {},
      resume: () => { resumed += 1 },
      destroy: () => { destroys += 1 },
    }) as unknown as IncomingMessage
    await toFetchRequest(cancelled, res).body!.cancel()
    expect(resumed).toBeGreaterThanOrEqual(1)
    expect(destroys).toBe(0)
  })

  it('writeFetchResponse returns once the socket closes while waiting for drain', async () => {
    const writes: Uint8Array[] = []
    const res = Object.assign(new EventEmitter(), {
      headersSent: false,
      destroyed: false,
      writeHead() { return this },
      write(chunk: Uint8Array) { writes.push(chunk); return false },
      end() { return this },
    }) as unknown as ServerResponse
    const pending = writeFetchResponse(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]))
        controller.enqueue(new Uint8Array([2]))
        controller.close()
      },
    })), res)
    await vi.waitFor(() => { expect(writes).toHaveLength(1) })
    res.emit('drain')
    await vi.waitFor(() => { expect(writes).toHaveLength(2) })
    Object.assign(res, { destroyed: true })
    res.emit('close')
    await expect(pending).resolves.toBeUndefined()
  })
})

describe('webserver-node invariant companion', () => {
  it('registers the package name and reserves it against duplicate registration', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(NodeWebServerInvariant)
    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-host-webserver-node', () => {})
    }).toThrow(/already registered/)
  })
})
