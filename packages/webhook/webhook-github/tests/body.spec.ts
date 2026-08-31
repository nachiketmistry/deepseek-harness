import { describe, expect, it } from 'vitest'
import { readBoundedUtf8Body } from '../src/body.ts'

/** A request whose body streams the given chunks, then optionally errors. */
function request(options: {
  chunks?: Array<Uint8Array | string>
  contentLength?: string
  error?: unknown
} = {}): Request {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of options.chunks ?? []) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      }
      if (options.error !== undefined) controller.error(options.error)
      else controller.close()
    },
  })
  return new Request('http://dsh.internal/webhook', {
    method: 'POST',
    headers: options.contentLength === undefined ? {} : { 'content-length': options.contentLength },
    body,
    duplex: 'half',
  } as RequestInit)
}

describe('bounded webhook body intake', () => {
  it('accepts an absent length and both binary and text chunks', async () => {
    await expect(readBoundedUtf8Body(request({ chunks: [new Uint8Array([0x7b]), '}'] }), 2)).resolves.toBe('{}')
  })

  it('rejects malformed, unsafe, and oversized declared lengths', async () => {
    await expect(readBoundedUtf8Body(request({ contentLength: '01' }), 10)).rejects.toMatchObject({ status: 400 })
    await expect(readBoundedUtf8Body(request({ contentLength: '999999999999999999999' }), Number.MAX_SAFE_INTEGER))
      .rejects.toMatchObject({ status: 413 })
    await expect(readBoundedUtf8Body(request({ contentLength: '3' }), 2)).rejects.toMatchObject({ status: 413 })
  })

  it('rejects a chunked body at the first byte beyond the cap', async () => {
    const streamed = request({ chunks: ['ab', 'c'] })
    await expect(readBoundedUtf8Body(streamed, 2)).rejects.toMatchObject({ status: 413 })
  })

  it('normalizes a stream failure as an aborted body', async () => {
    await expect(readBoundedUtf8Body(request({ error: new Error('socket') }), 10))
      .rejects.toMatchObject({ status: 400, message: 'request body was aborted' })
  })

  it('rejects invalid UTF-8 after a complete bounded read', async () => {
    await expect(readBoundedUtf8Body(request({ chunks: [new Uint8Array([0xff])] }), 1))
      .rejects.toMatchObject({ status: 400, message: 'request body is not valid UTF-8' })
  })
})
