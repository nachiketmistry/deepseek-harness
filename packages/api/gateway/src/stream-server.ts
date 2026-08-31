/** Host WebSocket owner for multiplexed Typert Remote streams. */

import { WEBSOCKET_OPEN, type WebServerSocket } from '@deepseek-ai/dsh-host-webserver'
import {
  parseRemoteStreamClientMessage,
  type RemoteStreamFailure,
  type RemoteStreamServerMessage,
} from './stream-protocol.ts'

/** Open one validated Remote stream for a decoded wire request. */
export type RemoteStreamOpener = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<AsyncIterable<unknown>>

/** Convert an invocation or carrier failure to a stable wire value. */
export type RemoteStreamFailureMapper = (error: unknown) => RemoteStreamFailure

/** Own every accepted socket and its active logical streams. */
export class RemoteStreamMuxServer {
  private readonly sockets = new Set<WebServerSocket>()
  private readonly connections = new Set<Promise<void>>()
  private heartbeatTimer: NodeJS.Timeout | undefined

  /**
   * @param open - Gateway stream dispatcher.
   * @param failure - Gateway error-to-wire mapper.
   * @param heartbeatIntervalMs - interval between WebSocket Ping control frames.
   */
  constructor(
    private readonly open: RemoteStreamOpener,
    private readonly failure: RemoteStreamFailureMapper,
    private readonly heartbeatIntervalMs: number,
  ) {}

  /**
   * Serve one accepted socket's logical streams until it closes.
   * @param socket - socket the carrier accepted for this route.
   * @returns settles when the socket has closed and every iterator has returned.
   */
  async serve(socket: WebServerSocket): Promise<void> {
    this.startHeartbeat()
    this.sockets.add(socket)
    const connection = new RemoteStreamMuxConnection(socket, this.open, this.failure)
    const done = connection.run()
    this.connections.add(done)
    try {
      await done
    } finally {
      this.connections.delete(done)
      this.sockets.delete(socket)
    }
  }

  /** Close all sockets and wait until every iterator has returned. */
  async close(): Promise<void> {
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    for (const socket of this.sockets) socket.close(1001, 'server shutting down')
    await Promise.all(this.connections)
  }

  /** Start one `unref()` timer after the first upgrade; it spans empty-client periods until close(). */
  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) return
    this.heartbeatTimer = setInterval(() => {
      for (const socket of this.sockets) {
        if (socket.readyState === WEBSOCKET_OPEN) socket.ping?.()
      }
    }, this.heartbeatIntervalMs)
    // A provider whose platform owns keepalive has no ping(); the timer is then
    // inert, and unref() keeps it from holding the process open either way.
    this.heartbeatTimer.unref()
  }
}

interface ActiveStream {
  readonly abort: AbortController
  done: Promise<void>
}

class RemoteStreamMuxConnection {
  private readonly streams = new Map<string, ActiveStream>()
  private writes = Promise.resolve()

  constructor(
    private readonly socket: WebServerSocket,
    private readonly open: RemoteStreamOpener,
    private readonly failure: RemoteStreamFailureMapper,
  ) {}

  async run(): Promise<void> {
    const closed = new Promise<void>((resolve) => {
      this.socket.addEventListener('close', resolve)
      this.socket.addEventListener('error', () => { this.socket.close(1011, 'socket error') })
      this.socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') {
          this.socket.close(1003, 'text messages required')
          return
        }
        try {
          this.receive(event.data)
        } catch {
          this.socket.close(1008, 'invalid Remote stream request')
        }
      })
    })
    await closed
    const active = [...this.streams.values()]
    for (const stream of active) stream.abort.abort(new Error('Remote stream socket closed'))
    await Promise.all(active.map(stream => stream.done))
  }

  private receive(text: string): void {
    const message = parseRemoteStreamClientMessage(text)
    if (message.type === 'cancel') {
      this.streams.get(message.streamId)?.abort.abort(new Error('Remote stream cancelled'))
      return
    }
    if (this.streams.has(message.streamId)) {
      throw new Error(`api gateway: duplicate Remote stream id ${JSON.stringify(message.streamId)}`)
    }
    const abort = new AbortController()
    const active: ActiveStream = {
      abort,
      done: Promise.resolve(),
    }
    this.streams.set(message.streamId, active)
    const done = this.pump(message.streamId, message.endpoint, message.payload, active)
    active.done = done
    const remove = (): void => { this.streams.delete(message.streamId) }
    void done.then(remove, remove)
  }

  private async pump(
    streamId: string,
    endpoint: string,
    payload: unknown,
    active: ActiveStream,
  ): Promise<void> {
    try {
      const source = await this.open(endpoint, payload, active.abort.signal)
      for await (const value of source) {
        await this.send({ type: 'item', streamId, value })
      }
      if (!active.abort.signal.aborted) await this.send({ type: 'end', streamId })
    } catch (error) {
      if (!active.abort.signal.aborted && this.socket.readyState === WEBSOCKET_OPEN) {
        try {
          await this.send({ type: 'error', streamId, error: this.failure(error) })
        } catch {
          // A terminal frame that cannot be encoded or written leaves the
          // logical stream ambiguous, so fail the physical generation.
          this.socket.close(1011, 'Remote stream failure could not be delivered')
        }
      }
    }
  }

  private send(message: RemoteStreamServerMessage): Promise<void> {
    let text: string
    try {
      text = JSON.stringify(message)
    } catch (cause) {
      return Promise.reject(new Error('api gateway: Remote stream item is not JSON serializable', { cause }))
    }
    // The carrier's send() is fire-and-forget, so ordering is preserved by the
    // write chain rather than by a per-frame completion callback.
    const delivery = this.writes.then(() => {
      if (this.socket.readyState !== WEBSOCKET_OPEN) {
        throw new Error('api gateway: Remote stream socket is closed')
      }
      this.socket.send(text)
    })
    this.writes = delivery.catch(() => undefined)
    return delivery
  }
}
