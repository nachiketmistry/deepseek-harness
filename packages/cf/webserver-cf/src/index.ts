/**
 * @deepseek-ai/dsh-webserver-cf — the web carrier Service Provider for a
 * Cloudflare Durable Object. It owns no listener: the object's `fetch` hands
 * every request to {@link CfWebServer.handle}, which dispatches HTTP requests
 * through the Service Definition's route tables and accepts WebSocket
 * upgrades under the hibernation API. A socket accepted before a hibernation
 * is recovered on the next wake: its route's `open` runs again with the
 * request the socket was accepted for, rebuilt from the socket attachment.
 * @module @deepseek-ai/dsh-webserver-cf
 */

import type { Context } from '@deepseek-ai/cordis'
import { WebServer, type WebServerAddress, type WebServerSocket, type WebSocketRoute } from '@deepseek-ai/dsh-host-webserver'
import type { CfServerSocket } from '@deepseek-ai/dsh-cf-bindings'

/** What a socket remembers across hibernation: enough to rebuild its upgrade request. */
interface SocketAttachment {
  url: string
  headers: [string, string][]
}

type MessageListener = (event: { data: unknown }) => void

/** The workerd `WebSocketPair` global, declared structurally: this package compiles under Node types. */
declare const WebSocketPair: new () => { 0: unknown; 1: CfServerSocket }

/** The SD socket surface over one hibernatable server socket; events arrive through {@link CfWebServer}. */
class SocketAdapter implements WebServerSocket {
  private readonly message = new Set<MessageListener>()
  private readonly close_ = new Set<() => void>()
  private readonly error = new Set<() => void>()

  constructor(readonly socket: CfServerSocket) {}

  get readyState(): number {
    return this.socket.readyState
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.socket.send(data)
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason)
  }

  addEventListener(type: 'message', listener: MessageListener): void
  addEventListener(type: 'close' | 'error', listener: () => void): void
  addEventListener(type: 'message' | 'close' | 'error', listener: MessageListener | (() => void)): void {
    // A `message` listener takes the event; `close`/`error` listeners take nothing, so a
    // zero-argument function satisfies both sets and the union collapses structurally.
    const target = type === 'message' ? this.message : type === 'close' ? this.close_ : this.error
    ;(target as Set<MessageListener | (() => void)>).add(listener)
  }

  /** Deliver one platform event to the registered listeners. */
  dispatch(type: 'message', data: unknown): void
  dispatch(type: 'close' | 'error'): void
  dispatch(type: 'message' | 'close' | 'error', data?: unknown): void {
    switch (type) {
      case 'message': for (const listener of this.message) listener({ data }); break
      case 'close': for (const listener of this.close_) listener(); break
      case 'error': for (const listener of this.error) listener(); break
    }
  }
}

/** The hibernatable-socket carrier. Mount through the Durable Object's `prepare` step; it is never a row. */
export class CfWebServer extends WebServer {
  private readonly adapters = new Map<CfServerSocket, SocketAdapter>()
  private readonly tag: string

  /**
   * @param ctx - the tree's root context.
   * @param tag - the hibernation tag marking sockets this carrier accepted.
   */
  constructor(ctx: Context, tag = 'dsh-webserver') {
    super(ctx)
    this.tag = tag
  }

  override get address(): WebServerAddress | undefined {
    return undefined
  }

  /**
   * The Durable Object fetch entry: WebSocket upgrades go to their route,
   * everything else through {@link WebServer.fetch}.
   * @param request - the request as the object received it.
   * @returns the response; a route's rejection becomes a 500 with the message.
   */
  async handle(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') return this.upgrade(request)
    try {
      return await this.fetch(request)
    } catch (error) {
      return new Response(`dsh: ${error instanceof Error ? error.message : String(error)}`, { status: 500 })
    }
  }

  /**
   * Re-open every socket the platform kept across a hibernation. Call once
   * per object wake after the tree is active; sockets accepted during this
   * wake are already open and are skipped.
   */
  recover(): void {
    for (const socket of this.ctx.cf.sockets.getWebSockets(this.tag)) {
      if (!this.adapters.has(socket)) this.reopen(socket)
    }
  }

  /**
   * The object's `webSocketMessage` hook.
   * @param socket - the platform socket.
   * @param data - the frame payload.
   */
  message(socket: CfServerSocket, data: string | ArrayBuffer): void {
    this.adapter(socket)?.dispatch('message', data)
  }

  /**
   * The object's `webSocketClose` hook.
   * @param socket - the platform socket.
   */
  closed(socket: CfServerSocket): void {
    this.adapter(socket)?.dispatch('close')
    this.adapters.delete(socket)
  }

  /**
   * The object's `webSocketError` hook.
   * @param socket - the platform socket.
   */
  errored(socket: CfServerSocket): void {
    this.adapter(socket)?.dispatch('error')
    this.adapters.delete(socket)
  }

  private upgrade(request: Request): Response {
    const pathname = new URL(request.url).pathname
    const route = this.upgradeRoute(pathname)
    if (route === undefined) return new Response(null, { status: 404 })
    const refusal = route.authorize?.(request)
    if (refusal !== undefined) return refusal
    const { 0: client, 1: server } = new WebSocketPair()
    const attachment: SocketAttachment = { url: request.url, headers: [...request.headers.entries()] }
    server.serializeAttachment(attachment)
    this.ctx.cf.sockets.acceptWebSocket(server, [this.tag])
    this.open(route, request, server)
    return new Response(null, { status: 101, webSocket: client } as ResponseInit)
  }

  private open(route: WebSocketRoute, request: Request, socket: CfServerSocket): void {
    const adapter = new SocketAdapter(socket)
    this.adapters.set(socket, adapter)
    void Promise.resolve(route.open(request, adapter)).catch((error: unknown) => {
      this.ctx.logger.warn('webserver-cf: socket route %s failed: %s', route.path, error instanceof Error ? error.message : String(error))
      socket.close(1011, 'route failure')
    })
  }

  private reopen(socket: CfServerSocket): void {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null
    if (attachment === null) return
    const request = new Request(attachment.url, { headers: attachment.headers })
    const route = this.upgradeRoute(new URL(attachment.url).pathname)
    if (route === undefined) {
      socket.close(1011, 'route gone')
      return
    }
    this.open(route, request, socket)
  }

  private adapter(socket: CfServerSocket): SocketAdapter | undefined {
    const known = this.adapters.get(socket)
    if (known !== undefined) return known
    this.reopen(socket)
    return this.adapters.get(socket)
  }
}

export default CfWebServer
