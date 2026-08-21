/** Behavior of the host-side frame pump over the carrier's accepted socket. */

import { describe, expect, it, vi } from 'vitest'
import { WEBSOCKET_OPEN, type WebServerSocket } from '@deepseek-ai/dsh-host-webserver'
import type {
  ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { WebSocketDownlinks } from '../src/websocket-downlink.ts'

type MuxSource = (signal: AbortSignal) => AsyncIterable<RpcRequest<MuxFrame>>
type HostSource = (signal: AbortSignal) => AsyncIterable<RpcRequest<HostFrame>>

const WEBSOCKET_CLOSED = 3

/** An accepted socket as a provider hands it over: records frames and close calls, dispatches events. */
class FakeSocket implements WebServerSocket {
  readyState = WEBSOCKET_OPEN
  readonly frames: ServerRequest[] = []
  readonly closes: { code: number | undefined; reason: string | undefined }[] = []
  private readonly listeners = new Map<string, ((event: { data: unknown }) => void)[]>()

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof data !== 'string') throw new TypeError('the downlink sends text frames only')
    this.frames.push(JSON.parse(data) as ServerRequest)
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
    if (this.readyState === WEBSOCKET_CLOSED) return
    this.readyState = WEBSOCKET_CLOSED
    this.dispatch('close', { data: undefined })
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  /** Deliver one event as the platform would. */
  dispatch(type: 'message' | 'close' | 'error', event: { data: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function untilAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

async function * idle<F>(signal: AbortSignal): AsyncGenerator<RpcRequest<F>> {
  await untilAbort(signal)
}

function api(mux: MuxSource, host: HostSource): ApiProxy {
  return {
    events: {
      mux: (_request, signal) => mux(signal),
      host: (_request, signal) => host(signal),
    },
  } as ApiProxy
}

/** A source that stays open until aborted, reporting the signal it was given and when it finished. */
function observed<F>(prelude?: RpcRequest<F>): {
  source: (signal: AbortSignal) => AsyncIterable<RpcRequest<F>>
  state: { signal?: AbortSignal; finished: boolean }
} {
  const state: { signal?: AbortSignal; finished: boolean } = { finished: false }
  return {
    state,
    source: async function * (signal) {
      state.signal = signal
      try {
        if (prelude !== undefined) yield prelude
        await untilAbort(signal)
      } finally {
        state.finished = true
      }
    },
  }
}

describe('WebSocketDownlinks', () => {
  it('sends mux and host frames as server-request envelopes on their own sockets', async () => {
    const mux = observed<MuxFrame>({
      rpcId: RpcId('mux-1'),
      payload: { type: 'session/subscribed', sessionId: 'session-1' as never, lastSeq: 4 },
    })
    const host = observed<HostFrame>({
      rpcId: RpcId('host-1'),
      payload: { type: 'host/remote-event', event: 'commands/change', args: [] },
    })
    const downlinks = new WebSocketDownlinks(api(mux.source, host.source))
    const muxSocket = new FakeSocket()
    const hostSocket = new FakeSocket()
    const muxPump = downlinks.openMux(muxSocket)
    const hostPump = downlinks.openHost(hostSocket)
    await vi.waitFor(() => {
      expect(muxSocket.frames).toHaveLength(1)
      expect(hostSocket.frames).toHaveLength(1)
    })
    expect(muxSocket.frames[0]).toEqual({
      type: 'server-request',
      rpcId: 'mux-1',
      method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 4 },
    })
    expect(hostSocket.frames[0]).toEqual({
      type: 'server-request',
      rpcId: 'host-1',
      method: 'host/remote-event',
      payload: { type: 'host/remote-event', event: 'commands/change', args: [] },
    })
    expect(mux.state.signal?.aborted).toBe(false)
    expect(host.state.signal?.aborted).toBe(false)

    // Each client departure cancels only its own source.
    muxSocket.close()
    await muxPump
    expect(mux.state.signal?.aborted).toBe(true)
    expect(mux.state.finished).toBe(true)
    expect(host.state.signal?.aborted).toBe(false)
    hostSocket.close()
    await hostPump
    expect(host.state.signal?.aborted).toBe(true)
    // The pump never re-closes a socket the client already closed.
    expect(muxSocket.closes).toEqual([{ code: undefined, reason: undefined }])
    expect(hostSocket.closes).toEqual([{ code: undefined, reason: undefined }])
  })

  it('closes 1008 on a client message because upstream stays on HTTP, aborting the source', async () => {
    const mux = observed<MuxFrame>()
    const downlinks = new WebSocketDownlinks(api(mux.source, idle))
    const socket = new FakeSocket()
    const pump = downlinks.openMux(socket)
    await vi.waitFor(() => { expect(mux.state.signal).toBeDefined() })
    socket.dispatch('message', { data: 'upstream payload' })
    await pump
    expect(socket.closes).toEqual([{ code: 1008, reason: 'downlink only' }])
    expect(mux.state.signal?.aborted).toBe(true)
    expect(mux.state.finished).toBe(true)
  })

  it('aborts the source when the socket reports a transport error', async () => {
    const mux = observed<MuxFrame>()
    const downlinks = new WebSocketDownlinks(api(mux.source, idle))
    const socket = new FakeSocket()
    const pump = downlinks.openMux(socket)
    await vi.waitFor(() => { expect(mux.state.signal).toBeDefined() })
    socket.dispatch('error', { data: new Error('transport failed') })
    await pump
    expect(mux.state.signal?.aborted).toBe(true)
    // The socket was still open from the pump's view, so it closes it itself.
    expect(socket.closes).toEqual([{ code: undefined, reason: undefined }])
  })

  it('sends one stream/error frame then closes when the source throws', async () => {
    const downlinks = new WebSocketDownlinks(api(
      async function * () {
        throw new Error('mux source failed')
      },
      idle,
    ))
    const socket = new FakeSocket()
    await downlinks.openMux(socket)
    expect(socket.frames).toHaveLength(1)
    expect(socket.frames[0]).toMatchObject({
      type: 'server-request',
      method: 'stream/error',
      payload: {
        type: 'stream/error',
        error: { code: 'internal', message: 'Error: mux source failed', details: {} },
      },
    })
    expect(socket.closes).toEqual([{ code: undefined, reason: undefined }])
    expect(socket.readyState).toBe(WEBSOCKET_CLOSED)
  })

  it('drops a frame that races after the client closed and swallows the send failure', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let sourceSignal: AbortSignal | undefined
    const downlinks = new WebSocketDownlinks(api(
      async function * (signal) {
        sourceSignal = signal
        await gate
        yield {
          rpcId: RpcId('late'),
          payload: { type: 'session/subscribed', sessionId: 'session-late' as never, lastSeq: 0 },
        }
      },
      idle,
    ))
    const socket = new FakeSocket()
    const pump = downlinks.openMux(socket)
    await vi.waitFor(() => { expect(sourceSignal).toBeDefined() })
    socket.close()
    expect(sourceSignal?.aborted).toBe(true)
    release()
    await pump
    // The late frame fails the closed-socket check; the pump neither
    // reports it (the client is gone) nor closes the socket twice.
    expect(socket.frames).toHaveLength(0)
    expect(socket.closes).toEqual([{ code: undefined, reason: undefined }])
  })

  it('swallows a failure frame that loses the race to socket loss', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const downlinks = new WebSocketDownlinks(api(
      async function * () {
        await gate
        throw new Error('failed after the socket went away')
      },
      idle,
    ))
    const socket = new FakeSocket()
    const pump = downlinks.openMux(socket)
    // The transport dies without the pump's signal aborting (readyState flips,
    // no close event reaches the listener), so the failure path still tries
    // to send and meets the closed-socket check.
    socket.readyState = WEBSOCKET_CLOSED
    release()
    await pump
    expect(socket.frames).toHaveLength(0)
    expect(socket.closes).toHaveLength(0)
  })

  it('close() closes every owned socket with 1001 and awaits the pumps', async () => {
    let cleanupStarted!: () => void
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve })
    let releaseCleanup!: () => void
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve })
    let cleaned = false
    const host = observed<HostFrame>()
    const downlinks = new WebSocketDownlinks(api(
      async function * (signal) {
        try {
          await untilAbort(signal)
        } finally {
          cleanupStarted()
          await cleanupGate
          cleaned = true
        }
      },
      host.source,
    ))
    const muxSocket = new FakeSocket()
    const hostSocket = new FakeSocket()
    void downlinks.openMux(muxSocket)
    void downlinks.openHost(hostSocket)
    await vi.waitFor(() => { expect(host.state.signal).toBeDefined() })
    let closed = false
    const closing = downlinks.close().then(() => { closed = true })
    await started
    expect(muxSocket.closes).toEqual([{ code: 1001, reason: 'server shutting down' }])
    expect(hostSocket.closes).toEqual([{ code: 1001, reason: 'server shutting down' }])
    expect(closed).toBe(false)
    releaseCleanup()
    await closing
    expect(cleaned).toBe(true)
    expect(host.state.finished).toBe(true)
  })

  it('releases a socket from the owned set once its pump ends', async () => {
    const mux = observed<MuxFrame>()
    const downlinks = new WebSocketDownlinks(api(mux.source, idle))
    const socket = new FakeSocket()
    const pump = downlinks.openMux(socket)
    await vi.waitFor(() => { expect(mux.state.signal).toBeDefined() })
    socket.close()
    await pump
    // A later shutdown touches nothing: the ended pump's socket is gone.
    await downlinks.close()
    expect(socket.closes).toEqual([{ code: undefined, reason: undefined }])
  })
})
