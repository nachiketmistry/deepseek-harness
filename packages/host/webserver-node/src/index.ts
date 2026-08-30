/**
 * @deepseek-ai/dsh-host-webserver-node — the Node Service Provider for the
 * web carrier: a `node:http` server that listens on activation, bridges each
 * request into the `webServer` fetch dispatch as a Fetch `Request`, streams
 * the `Response` back with backpressure, and accepts WebSocket routes through
 * `ws`. Web shape only — Electron loads dist over file:// and carries fetch
 * over an IPC bridge. This package never prints: the URL line belongs to the shell.
 * @module @deepseek-ai/dsh-host-webserver-node
 */

import { createServer } from 'node:http'
import { pipeline, Readable } from 'node:stream'
import { createGzip } from 'node:zlib'
import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { WebServer, type WebServerAddress } from '@deepseek-ai/dsh-host-webserver'
import { WebSocketServer, type WebSocket } from 'ws'

/** Provider config: the listen address. */
export interface Config {
  /** Listen host; the two supported values are loopback and all-interfaces. */
  host: '127.0.0.1' | '0.0.0.0'
  /** Listen port; zero requests an OS-assigned port. */
  port: number
  /** Response compression for socket-backed HTTP requests. @default 'none' */
  compression?: 'none' | 'gzip'
  /** Gzip DEFLATE level from 0 through 9. @default 1 */
  compressionLevel?: number
  /** Minimum known response length eligible for gzip; unknown-length streams are eligible. @default 1024 */
  compressionThresholdBytes?: number
}

/** {@link Config} after the schema has filled every default. */
interface ResolvedConfig extends Config {
  compression: 'none' | 'gzip'
  compressionLevel: number
  compressionThresholdBytes: number
}

const DEFAULT_COMPRESSION = 'none' as const
const DEFAULT_COMPRESSION_LEVEL = 1
const DEFAULT_COMPRESSION_THRESHOLD_BYTES = 1024

/**
 * Media types worth compressing: text, and the structured formats whose
 * subtype ends in a text-shaped suffix. Everything else (images, video, fonts,
 * archives) is already compressed, where a second pass costs CPU and adds bytes.
 */
const COMPRESSIBLE = /^text\/|^application\/(?:json|javascript|xml|wasm$|[^;]*\+(?:json|xml|text))/i

/**
 * Whether one response should be gzipped for one request.
 * @param request - the request, read for `accept-encoding`.
 * @param response - the response, read for its type, length, and any existing encoding.
 * @param thresholdBytes - smallest declared body worth compressing.
 * @returns whether to wrap the body in gzip.
 */
function shouldCompress(request: Request, response: Response, thresholdBytes: number): boolean {
  if (response.body === null) return false
  if (response.headers.has('content-encoding')) return false
  // A `q=0` parameter refuses gzip; anything else naming gzip accepts it.
  const accepted = request.headers.get('accept-encoding') ?? ''
  const gzip = /(?:^|,)\s*(?:gzip|\*)\s*(;\s*q=(?<q>[\d.]+))?/i.exec(accepted)
  if (gzip === null || gzip.groups?.q === '0') return false
  if (!COMPRESSIBLE.test(response.headers.get('content-type') ?? '')) return false
  // An undeclared length is a stream: compress it, since the threshold cannot
  // be judged without buffering the whole body first.
  const declared = response.headers.get('content-length')
  return declared === null || Number(declared) >= thresholdBytes
}

/**
 * The same response with a gzip body and the headers that describe it.
 * @param response - the response to wrap.
 * @param level - zlib compression level.
 * @returns the gzipped response.
 */
function gzipResponse(response: Response, level: number): Response {
  /* v8 ignore next -- shouldCompress rejects a null body before this is called */
  if (response.body === null) return response
  const headers = new Headers(response.headers)
  headers.set('content-encoding', 'gzip')
  // The compressed length is unknown until the stream ends, and a stale
  // declared length would truncate the body at the client.
  headers.delete('content-length')
  headers.append('vary', 'accept-encoding')
  const gzip = createGzip({ level })
  const body = Readable.toWeb(pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    gzip,
    () => {
      // pipeline's callback is required; a failure destroys the streams and
      // surfaces as the response body erroring, which the writer already owns.
    },
  )) as ReadableStream<Uint8Array>
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * Build the Fetch request for one node:http request. The URL authority is the
 * request's `Host` header so trust fences see what the client addressed; the
 * signal aborts when the client goes away before the response ends.
 * @param req - the incoming request, its body consumed by the returned request.
 * @param res - the response whose close event signals client departure.
 * @returns the Fetch request.
 */
export function toFetchRequest(req: IncomingMessage, res: ServerResponse): Request {
  const abort = new AbortController()
  // Client-disconnect detection MUST hang off the response, not the request:
  // since Node 16, IncomingMessage 'close' fires as soon as the request body is
  // fully consumed (immediately for a bodyless GET), which would abort every SSE
  // stream right after open. ServerResponse 'close' fires on connection teardown;
  // writableEnded distinguishes a normal end() from the client going away.
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value)
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item)
  }
  // The `??` arms: node:http always sets url/method on server requests; the
  // fields are only optional on the client-side IncomingMessage type.
  const method = req.method ?? 'GET'
  const authority = req.headers.host ?? 'localhost'
  const url = new URL(req.url ?? '/', `http://${authority}`)
  const hasBody = method !== 'GET' && method !== 'HEAD'
  return new Request(url, {
    method,
    headers,
    ...hasBody ? { body: toReadableStream(req), duplex: 'half' } : {},
    signal: abort.signal,
  })
}

/** Wrap the request body as a Web stream without buffering it. */
function toReadableStream(req: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      req.on('data', (chunk: Buffer) => { controller.enqueue(new Uint8Array(chunk)) })
      req.on('end', () => { controller.close() })
      req.on('error', (error) => { controller.error(error) })
    },
    cancel() {
      req.destroy()
    },
  })
}

/**
 * Write one Fetch response to a node:http response, streaming the body with
 * socket backpressure.
 * @param response - the response to deliver.
 * @param res - the node:http response the bridge owns to completion.
 */
export async function writeFetchResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of response.headers) {
    if (name === 'set-cookie') {
      headers[name] = response.headers.getSetCookie()
    } else {
      headers[name] = value
    }
  }
  res.writeHead(response.status, headers)
  if (response.body === null) {
    res.end()
    return
  }
  for await (const chunk of response.body) {
    // Backpressure: a false return means the socket buffer is full — wait for drain
    // instead of buffering unboundedly (slow/suspended SSE consumers). 'close' also
    // resolves so a mid-wait disconnect can't park this loop forever; the request
    // signal aborts the handler stream, which then ends the iteration.
    if (!res.write(chunk)) {
      // A destroyed response never drains; 'close' has already fired, so
      // waiting would park this request forever. Leaving the loop cancels the
      // body stream through the iterator's return.
      if (res.destroyed) return
      await new Promise<void>((resolve) => {
        const done = (): void => {
          res.off('drain', done)
          res.off('close', done)
          resolve()
        }
        res.once('drain', done)
        res.once('close', done)
      })
    }
  }
  res.end()
}

/**
 * Answer a refused upgrade on the raw socket before any handshake.
 * @param socket - the raw HTTP socket, closed after the answer.
 * @param response - the refusal the route produced.
 */
async function writeRawResponse(socket: Duplex, response: Response): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer())
  const lines = [`HTTP/1.1 ${String(response.status)} ${response.statusText || 'Refused'}`, 'Connection: close']
  for (const [name, value] of response.headers) lines.push(`${name}: ${value}`)
  lines.push(`Content-Length: ${String(body.byteLength)}`, '', '')
  socket.end(Buffer.concat([Buffer.from(lines.join('\r\n')), body]))
}

/**
 * The Node web carrier. Activation listens immediately; a listen failure
 * rejects initialization, and the boot process reports the failed fiber.
 */
export class NodeWebServer extends WebServer {
  static Config: z<Config> = z.object({
    host: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).required(),
    port: z.natural().max(65535).required(),
    compression: z.union([z.const('none'), z.const('gzip')]).default(DEFAULT_COMPRESSION),
    compressionLevel: z.number().step(1).min(0).max(9).default(DEFAULT_COMPRESSION_LEVEL),
    compressionThresholdBytes: z.natural().default(DEFAULT_COMPRESSION_THRESHOLD_BYTES),
  })

  private readonly upgradedSockets = new Set<Duplex>()
  private readonly acceptor = new WebSocketServer({ noServer: true })
  private server!: Server
  private listened!: WebServerAddress

  constructor(ctx: Context, private config: Config) {
    super(ctx)
  }

  /** The bound address: the configured host and the listening port (OS-assigned when config.port is 0). */
  override get address(): WebServerAddress {
    return this.listened
  }

  /** Listen; resolves once the socket is bound (rejection = FAILED fiber). */
  async [Service.init](): Promise<void> {
    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const request = toFetchRequest(req, res)
      const response = await this.fetch(request)
      const resolved = this.config as ResolvedConfig
      const delivered = resolved.compression === 'gzip'
        && shouldCompress(request, response, resolved.compressionThresholdBytes)
        ? gzipResponse(response, resolved.compressionLevel)
        : response
      await writeFetchResponse(delivered, res)
    }
    // Last-resort guard: handle() rejecting would otherwise be an unhandled
    // rejection killing the process on one malformed request (bad %-escape,
    // client dropping mid-body). Per-request failures log and answer 400 —
    // never a process exit.
    this.server = createServer((req, res) => {
      handle(req, res).catch((err: unknown) => {
        this.ctx.logger.warn(err instanceof Error ? err : new Error(String(err)))
        if (res.headersSent) {
          res.destroy()
          return
        }
        res.writeHead(400)
        res.end()
      })
    })
    this.server.on('upgrade', (req, socket, head) => {
      const onError = (error: Error): void => {
        this.ctx.logger.warn(error)
        socket.destroy()
      }
      socket.on('error', onError)
      socket.once('close', () => {
        socket.off('error', onError)
        this.upgradedSockets.delete(socket)
      })
      this.upgrade(req, socket, head).catch((error: unknown) => {
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        socket.destroy()
      })
    })

    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off('error', reject)
        this.server.on('error', (err) => { this.ctx.logger.error(err) })
        this.listened = { host: this.config.host, port: (this.server.address() as AddressInfo).port }
        resolve()
      })
    })

    // Node does not include upgraded sockets in closeAllConnections(). The service
    // owns them with the other connections, so it tracks and destroys them explicitly.
    this.ctx.effect(() => async () => {
      for (const client of this.acceptor.clients) client.terminate()
      const serverClosed = new Promise<void>((resolve) => {
        this.server.close(() => { resolve() })
      })
      this.server.closeAllConnections()
      const upgradedClosed = [...this.upgradedSockets].map(socket => new Promise<void>((resolve) => {
        socket.once('close', () => { resolve() })
        socket.destroy()
      }))
      await Promise.all([serverClosed, ...upgradedClosed])
    }, 'webServer.listen')
  }

  /** Route one upgrade: refuse on the raw socket, or complete the ws handshake and hand the socket to its route. */
  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    /* v8 ignore next -- node:http always sets url on server requests. */
    const path = req.url ?? '/'
    const route = this.upgradeRoute(new URL(path, 'http://x').pathname)
    if (route === undefined) {
      socket.destroy()
      return
    }
    const request = new Request(new URL(path, `http://${req.headers.host ?? 'localhost'}`), {
      headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string') as [string, string][]),
    })
    const refusal = route.authorize?.(request)
    if (refusal !== undefined) {
      await writeRawResponse(socket, refusal)
      return
    }
    this.upgradedSockets.add(socket)
    const websocket = await new Promise<WebSocket>((resolve) => {
      this.acceptor.handleUpgrade(req, socket, head, resolve)
    })
    await route.open(request, websocket)
  }
}

export default NodeWebServer
