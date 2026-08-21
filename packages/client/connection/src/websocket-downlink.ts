/** Host-side frame pump for the two server-to-browser WebSocket event streams. */

import { WEBSOCKET_OPEN, type WebServerSocket } from '@deepseek-ai/dsh-host-webserver'
import type {
  ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'

type Frame = MuxFrame | HostFrame

function serverRequest(frame: RpcRequest<Frame>): ServerRequest {
  return {
    type: 'server-request',
    rpcId: frame.rpcId,
    method: frame.payload.type,
    payload: frame.payload,
  }
}

function send(socket: WebServerSocket, frame: RpcRequest<Frame>): void {
  if (socket.readyState !== WEBSOCKET_OPEN) {
    throw new Error('websocket downlink closed before frame delivery')
  }
  socket.send(JSON.stringify(serverRequest(frame)))
}

function failureFrame(error: unknown): RpcRequest<Frame> {
  return {
    rpcId: RpcId(crypto.randomUUID()),
    payload: {
      type: 'stream/error',
      error: { code: 'internal', message: String(error), details: {} },
    },
  }
}

/**
 * Pumps the connection plugin's two downlinks onto carrier-accepted sockets.
 * Client messages are a protocol violation: upstream traffic remains on HTTP.
 */
export class WebSocketDownlinks {
  private readonly sockets = new Set<WebServerSocket>()
  private readonly pumps = new Set<Promise<void>>()

  /** @param api - host API supplying the typed event streams. */
  constructor(private readonly api: ApiProxy) {}

  /**
   * Pump the mux stream onto one accepted socket until either side closes.
   * @param socket - the accepted server-side socket.
   * @returns resolves when the pump ends.
   */
  openMux(socket: WebServerSocket): Promise<void> {
    return this.open(socket, signal => this.api.events.mux({
      rpcId: RpcId(crypto.randomUUID()),
      payload: {},
    }, signal))
  }

  /**
   * Pump the host stream onto one accepted socket until either side closes.
   * @param socket - the accepted server-side socket.
   * @returns resolves when the pump ends.
   */
  openHost(socket: WebServerSocket): Promise<void> {
    return this.open(socket, signal => this.api.events.host({
      rpcId: RpcId(crypto.randomUUID()),
      payload: {},
    }, signal))
  }

  /**
   * Close every owned socket and await the frame pumps.
   * @returns A promise resolving after every socket and source iterator stops.
   */
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.close(1001, 'server shutting down')
    await Promise.all(this.pumps)
  }

  private open<F extends Frame>(
    socket: WebServerSocket,
    frames: (signal: AbortSignal) => AsyncIterable<RpcRequest<F>>,
  ): Promise<void> {
    const abort = new AbortController()
    socket.addEventListener('close', () => { abort.abort() })
    socket.addEventListener('error', () => { abort.abort() })
    socket.addEventListener('message', () => {
      socket.close(1008, 'downlink only')
    })
    this.sockets.add(socket)
    const pump = this.pump(socket, frames(abort.signal), abort).finally(() => {
      this.sockets.delete(socket)
    })
    this.pumps.add(pump)
    void pump.then(() => { this.pumps.delete(pump) })
    return pump
  }

  private async pump<F extends Frame>(
    socket: WebServerSocket,
    frames: AsyncIterable<RpcRequest<F>>,
    abort: AbortController,
  ): Promise<void> {
    try {
      for await (const frame of frames) send(socket, frame)
    } catch (error) {
      if (!abort.signal.aborted) {
        try {
          send(socket, failureFrame(error))
        } catch {
          // Socket loss won the race; no downstream remains to receive the failure frame.
        }
      }
    } finally {
      abort.abort()
      if (socket.readyState === WEBSOCKET_OPEN) socket.close()
    }
  }
}
