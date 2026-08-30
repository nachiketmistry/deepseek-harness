/** Bounded raw HTTP body intake for GitHub signature verification. */

/** HTTP refusal whose message is safe to return without request data. */
export class WebhookHttpError extends Error {
  override readonly name = 'WebhookHttpError'

  constructor(
    readonly status: 400 | 401 | 405 | 413 | 415 | 503,
    message: string,
  ) {
    super(message)
  }
}

/** Parse a decimal Content-Length or reject an ambiguous header. */
function contentLength(request: Request): number | undefined {
  const value = request.headers.get('content-length')
  if (value === null) return undefined
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new WebhookHttpError(400, 'invalid Content-Length')
  }
  const length = Number(value)
  if (!Number.isSafeInteger(length)) throw new WebhookHttpError(413, 'request body is too large')
  return length
}

/**
 * Read one request body as exact, bounded UTF-8 text.
 * @param request - the request whose body no other reader has consumed.
 * @param maxBodyBytes - positive byte ceiling.
 * @returns the decoded body after EOF.
 * @throws {WebhookHttpError} for invalid length, excessive bytes, invalid UTF-8, or an aborted stream.
 */
export async function readBoundedUtf8Body(
  request: Request,
  maxBodyBytes: number,
): Promise<string> {
  const declared = contentLength(request)
  if (declared !== undefined && declared > maxBodyBytes) {
    throw new WebhookHttpError(413, 'request body is too large')
  }

  const chunks: Uint8Array[] = []
  let size = 0
  const body = request.body
  if (body !== null) {
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBodyBytes) {
          await reader.cancel()
          throw new WebhookHttpError(413, 'request body is too large')
        }
        chunks.push(value)
      }
    } catch (error: unknown) {
      if (error instanceof WebhookHttpError) throw error
      throw new WebhookHttpError(400, 'request body was aborted')
    }
  }
  const joined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(joined)
  } catch {
    // TextDecoder is the only statement in the try; GitHub JSON must be valid UTF-8.
    throw new WebhookHttpError(400, 'request body is not valid UTF-8')
  }
}
