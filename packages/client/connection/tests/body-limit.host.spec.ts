/** Behavior of the `/api` request-body cap wrapper. */

import { describe, expect, it } from 'vitest'
import { withBodyLimit, type FetchHandler } from '../src/body-limit.ts'

const URL_ = 'http://127.0.0.1/api/session.list'

/** Records every request the guarded handler lets through and answers 200. */
function recorder(): { handler: FetchHandler; received: Request[] } {
  const received: Request[] = []
  return {
    received,
    handler: {
      async fetch(request) {
        received.push(request)
        return new Response('ok')
      },
    },
  }
}

/** A chunked (undeclared-length) request body fed from the given pieces. */
function chunked(chunks: readonly Uint8Array[], onCancel: () => void): Request {
  let pulled = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[pulled]
      if (chunk === undefined) {
        controller.close()
        return
      }
      pulled += 1
      controller.enqueue(chunk)
    },
    cancel: onCancel,
  })
  return new Request(URL_, { method: 'POST', body, duplex: 'half' } as RequestInit)
}

describe('withBodyLimit', () => {
  it('passes a bodyless request through untouched', async () => {
    const { handler, received } = recorder()
    const request = new Request(URL_)
    const response = await withBodyLimit(handler, 4).fetch(request)
    expect(response.status).toBe(200)
    expect(received).toEqual([request])
  })

  it('accepts a body exactly at the cap and refuses one byte over with 413 + connection: close', async () => {
    const { handler, received } = recorder()
    const guarded = withBodyLimit(handler, 4)
    const exact = await guarded.fetch(new Request(URL_, { method: 'POST', body: 'abcd' }))
    expect(exact.status).toBe(200)
    await expect(received[0]!.text()).resolves.toBe('abcd')

    const over = await guarded.fetch(new Request(URL_, { method: 'POST', body: 'abcde' }))
    expect(over.status).toBe(413)
    expect(over.headers.get('connection')).toBe('close')
    expect(received).toHaveLength(1)
  })

  it('refuses a declared oversize body without reading it', async () => {
    const { handler, received } = recorder()
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('the body must never be read')
      },
      cancel() { cancelled = true },
    })
    const request = new Request(URL_, {
      method: 'POST',
      body,
      duplex: 'half',
      headers: { 'content-length': '5' },
    } as RequestInit)
    const response = await withBodyLimit(handler, 4).fetch(request)
    expect(response.status).toBe(413)
    expect(response.headers.get('connection')).toBe('close')
    expect(cancelled).toBe(true)
    expect(received).toHaveLength(0)
  })

  it('refuses a chunked body at the first byte past the cap and cancels the source', async () => {
    const { handler, received } = recorder()
    let cancelled = false
    const request = chunked([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])], () => {
      cancelled = true
    })
    const response = await withBodyLimit(handler, 4).fetch(request)
    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
    expect(received).toHaveLength(0)
  })

  it('reassembles a multi-chunk body in order and keeps the request method, headers, and abort signal', async () => {
    const { handler, received } = recorder()
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{"a":'))
        stream.enqueue(new TextEncoder().encode('[1,'))
        stream.enqueue(new TextEncoder().encode('2]}'))
        stream.close()
      },
    })
    const request = new Request(URL_, {
      method: 'POST',
      body,
      duplex: 'half',
      headers: { 'content-type': 'application/json', 'x-trace': 'abc' },
      signal: controller.signal,
    } as RequestInit)
    const response = await withBodyLimit(handler, 64).fetch(request)
    expect(response.status).toBe(200)
    const delivered = received[0]!
    expect(delivered.method).toBe('POST')
    expect(delivered.url).toBe(URL_)
    expect(delivered.headers.get('x-trace')).toBe('abc')
    await expect(delivered.json()).resolves.toEqual({ a: [1, 2] })
    // The re-issued request's signal follows the carrier's: a client departure
    // still reaches the handler after buffering.
    expect(delivered.signal.aborted).toBe(false)
    controller.abort()
    expect(delivered.signal.aborted).toBe(true)
  })
})
