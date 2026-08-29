/** Request-body cap applied to every `/api` request before its handler reads the body. */

/** Default cap, sized for the default aggregate image limit (200 MiB) after
 * base64 expansion plus envelope headroom (~267.7 MiB required), rounded up for
 * slack. An oversize body is refused before its handler runs, so this cap is
 * also the per-request resident bound. */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 300 * 1024 * 1024

/** Transport-independent request handler: the webserver route handler shape. */
export interface FetchHandler {
  /**
   * Handle one standard Fetch request.
   * @param request - request produced by the active carrier.
   * @returns complete or streaming Fetch response.
   */
  fetch(request: Request): Promise<Response>
}

const REFUSED = (): Response => new Response(null, { status: 413, headers: { connection: 'close' } })

/**
 * Wrap a handler so an oversize body is refused with 413 before the handler
 * runs: a declared `Content-Length` over the cap is refused without reading,
 * and an undeclared or chunked body is read up to the cap and refused at the
 * first byte past it. The handler receives a request whose body is the
 * buffered bytes, so it may read it any number of times.
 * @param handler - the handler that reads the body.
 * @param maxRequestBodyBytes - maximum body bytes buffered before dispatch.
 * @returns the guarded handler.
 */
export function withBodyLimit(handler: FetchHandler, maxRequestBodyBytes: number): FetchHandler {
  return {
    async fetch(request) {
      if (request.body === null) return handler.fetch(request)
      const declaredLength = request.headers.get('content-length')
      if (declaredLength !== null && Number(declaredLength) > maxRequestBodyBytes) {
        await request.body.cancel()
        return REFUSED()
      }
      const chunks: Uint8Array[] = []
      let received = 0
      const reader = request.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > maxRequestBodyBytes) {
          await reader.cancel()
          return REFUSED()
        }
        chunks.push(value)
      }
      const body = new Uint8Array(received)
      let offset = 0
      for (const chunk of chunks) {
        body.set(chunk, offset)
        offset += chunk.byteLength
      }
      return handler.fetch(new Request(request, { body, signal: request.signal }))
    },
  }
}
