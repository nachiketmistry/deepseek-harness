/**
 * @deepseek-ai/dsh-host-webserver — the web carrier Service Definition: the
 * `webServer` service with the HTTP route registry dispatched as one Fetch
 * handler (`Request` in, `Response` out), the WebSocket route registry, the
 * structured index injection table with raw transform taps behind it, and the
 * single fallback seat for everything no route claims. A Service Provider
 * subclasses {@link WebServer} and owns the listener: the Node provider
 * (`@deepseek-ai/dsh-host-webserver-node`) binds `node:http`; a platform
 * provider forwards its fetch entry. Knows no harness concepts and serves no
 * files; the composing application's frontend plugin owns dist serving through
 * the fallback hook. This package never prints: the URL line belongs to the shell.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { renderIndexInjections, type IndexInjection } from './injections.ts'

export { renderIndexInjections } from './injections.ts'
export type { IndexInjection, IndexInjectionPlacement } from './injections.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServer
  }
  interface Events {
    /**
     * Collect the structured index injection table. Emitted on every index
     * render and every worker boot-payload request; listeners push their
     * current rows, so a row's data is read fresh at emit time.
     * @param table - Mutable row table; listeners append in activation order.
     * @mode emit
     */
    'webserver/index-inject'(table: IndexInjection[]): void
  }
}

/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
export type WebRouteKind = 'exact' | 'prefix'

/**
 * A Fetch-standard request handler. The request URL carries the authority the
 * client addressed (its `Host`), so trust fences read it from either the URL or
 * the headers; `request.signal` aborts when the client goes away, which is
 * how a streaming response (SSE) learns to stop.
 */
export type WebRequestHandler = (request: Request) => Response | Promise<Response>

/** One named route registration. */
export interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Produces the complete or streaming response. */
  handler: WebRequestHandler
}

/**
 * The server side of one accepted WebSocket, the subset of the WHATWG
 * `WebSocket` interface every provider can offer: Node's `ws` socket and a
 * platform server socket both satisfy it structurally. `readyState` uses the
 * standard numeric states (`1` is open).
 */
export interface WebServerSocket {
  /** Standard numeric ready state; {@link WEBSOCKET_OPEN} while frames can be sent. */
  readonly readyState: number
  /**
   * Queue one frame.
   * @param data - text or binary payload.
   */
  send(data: string | ArrayBuffer | ArrayBufferView): void
  /**
   * Start the closing handshake.
   * @param code - close code.
   * @param reason - close reason.
   */
  close(code?: number, reason?: string): void
  /**
   * Subscribe to a socket event.
   * @param type - `message` (a client frame), `close`, or `error`.
   * @param listener - receives the platform event; `message` events carry `data`.
   */
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close' | 'error', listener: () => void): void
}

/** `WebSocket.OPEN`. */
export const WEBSOCKET_OPEN = 1

/** One exact-path WebSocket route registration. */
export interface WebSocketRoute {
  /** Absolute pathname, no trailing slash. */
  path: string
  /**
   * Decide before the handshake. A returned response refuses the upgrade and
   * is delivered as the plain HTTP answer; `undefined` accepts it.
   * @param request - the upgrade request.
   */
  authorize?: (request: Request) => Response | undefined
  /**
   * Drive one accepted socket until it closes. A provider that recovers
   * sockets after its own restart (hibernation) calls this again with the
   * recovered socket and the request it was accepted for.
   * @param request - the upgrade request.
   * @param socket - the accepted server-side socket.
   */
  open: (request: Request, socket: WebServerSocket) => void | Promise<void>
}

/** The listening address of a provider that owns its own listener. */
export interface WebServerAddress {
  /** Bound host literal. */
  host: string
  /** Bound port (the OS-assigned value when the provider was configured with 0). */
  port: number
}

/**
 * The web carrier: route registries plus their dispatch. Route registration
 * order does not affect requests because configured named routes must be
 * distinct, and the fallback handler answers anything not yet claimed during
 * startup with 404 until its owner registers. A provider activates the
 * carrier (binds, or attaches to a platform entry) and forwards every request
 * to {@link fetch}; its initialization failure rejects the fiber.
 */
export abstract class WebServer extends Service {
  private readonly exact = new Map<string, WebRoute>()
  private readonly prefixes = new Map<string, WebRoute>()
  private readonly sockets = new Map<string, WebSocketRoute>()
  private readonly indexTaps: ((html: string) => string)[] = []
  private fallback: WebRequestHandler | undefined

  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }

  /**
   * The listening address, or `undefined` for a provider driven by a platform
   * fetch entry, which has no listener of its own.
   */
  abstract get address(): WebServerAddress | undefined

  /**
   * Register a named route. Duplicate (kind, path) throws — route patterns are
   * a composition-level contract, so a collision is a misconfiguration.
   * @param route - kind, path, and the owning handler.
   * @returns the disposer removing the route.
   */
  register(route: WebRoute): () => void {
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(route.path)) {
      throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    }
    table.set(route.path, route)
    return () => { table.delete(route.path) }
  }

  /**
   * Register an exact-path WebSocket route. Duplicate paths throw because
   * one socket can have only one protocol owner.
   * @param route - pathname, the pre-handshake decision, and the socket owner.
   * @returns the disposer removing the route.
   */
  registerUpgrade(route: WebSocketRoute): () => void {
    if (this.sockets.has(route.path)) {
      throw new Error(`webserver: duplicate upgrade route "${route.path}"`)
    }
    this.sockets.set(route.path, route)
    return () => { this.sockets.delete(route.path) }
  }

  /**
   * Claim the fallback seat: the handler answering every request no named
   * route matches (the SPA dist server in the shipped Web composition). One
   * owner only — a second registration throws, because two fallbacks cannot
   * compose.
   * @param handler - produces the response for unmatched requests.
   * @returns the disposer releasing the seat.
   */
  registerFallback(handler: WebRequestHandler): () => void {
    if (this.fallback !== undefined) {
      throw new Error('webserver: fallback already registered')
    }
    this.fallback = handler
    return () => { this.fallback = undefined }
  }

  /**
   * Register a raw-HTML index transform, the escape hatch for markup no
   * {@link IndexInjection} row expresses: {@link renderIndex} applies taps in
   * registration order after rendering the structured rows.
   * @param transform - pure html-to-html function.
   * @returns the disposer removing the transform.
   */
  tapIndex(transform: (html: string) => string): () => void {
    this.indexTaps.push(transform)
    return () => {
      const at = this.indexTaps.indexOf(transform)
      if (at !== -1) this.indexTaps.splice(at, 1)
    }
  }

  /**
   * Dispatch one HTTP request: the exact table, then longest-prefix over the
   * prefix table, then the fallback seat, then 404. A handler's rejection
   * propagates to the provider, which answers it as a per-request failure.
   * @param request - the request as the provider received it.
   * @returns the matched handler's response.
   */
  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname
    const route = this.match(pathname)
    if (route !== undefined) return await route.handler(request)
    const fallback = this.fallback
    if (fallback === undefined) return new Response(null, { status: 404 })
    return await fallback(request)
  }

  /**
   * The WebSocket route owning a pathname, for the provider's handshake.
   * @param pathname - decoded request pathname.
   * @returns the route, or undefined when no owner is registered.
   */
  upgradeRoute(pathname: string): WebSocketRoute | undefined {
    return this.sockets.get(pathname)
  }

  /** Longest-prefix-wins over the prefix table after an exact-table miss. */
  private match(pathname: string): WebRoute | undefined {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact
    let best: WebRoute | undefined
    for (const [prefix, route] of this.prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    return best
  }

  /**
   * Run an index.html body through the registered taps in registration order
   * — called by the fallback owner on every index response it renders.
   * @param html - the raw index.html body.
   * @returns the transformed body.
   */
  applyIndexTaps(html: string): string {
    let out = html
    for (const transform of this.indexTaps) out = transform(out)
    return out
  }

  /**
   * Gather the structured injection table: one `webserver/index-inject` emit,
   * every subscriber pushes its current rows. Fresh per call, so subscribers
   * read live state (module graph, theme preference) at emit time.
   * @returns rows in subscriber activation order.
   */
  collectIndexInjections(): IndexInjection[] {
    const table: IndexInjection[] = []
    this.ctx.emit('webserver/index-inject', table)
    return table
  }

  /**
   * Render one index.html body: the structured injection table first, then
   * the raw `tapIndex` transforms over the result.
   * @param html - the raw index.html body.
   * @returns the transformed body.
   */
  renderIndex(html: string): string {
    return this.applyIndexTaps(renderIndexInjections(html, this.collectIndexInjections()))
  }
}

export default WebServer
