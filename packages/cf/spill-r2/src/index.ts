/**
 * R2-backed spill store: a tool's oversized text lands as one object under
 * `<prefix>/session-<hash>/<random>-<safe-name>` and the returned locator is
 * that R2 key. The local store returns a host path that the model reads back
 * through the `read` and `grep` tools over `ctx.fs`; the container filesystem
 * on Cloudflare is not the bucket, so the retrieval hint names the key as a
 * spill object rather than a path. Wiring a retrieval tool over the bucket is
 * the consumer's work, not this store's.
 * @module @deepseek-ai/dsh-spill-r2
 */

import { createHash, randomBytes } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-cf-bindings'
import type { CfR2Bucket } from '@deepseek-ai/dsh-cf-bindings'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'

/** R2 spill store configuration. */
export interface Config {
  /** The R2 bucket binding name. */
  bucket: string
  /** Key prefix every spill object lives under. */
  prefix: string
}

/** Validated configuration. */
export const Config: z<Config> = z.object({
  bucket: z.string().default('SPILL'),
  prefix: z.string().default('spill'),
})

/**
 * Encode an arbitrary string as one safe key segment, injectively over all JS
 * strings: `[A-Za-z0-9._-]` minus `~` stays literal, everything else becomes
 * `~XXXX`; `.` and `..` are escaped whole and the empty string becomes `~`.
 * Mirrors the local spill store's segment encoder so a suggested name renders
 * the same on both backends.
 * @param raw - the untrusted string to encode.
 * @returns one injective key segment.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) return '~'
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}

/**
 * The session-scoped key segment: `session-<hash(sessionId)>`, a short stable hash.
 * @param sessionId - the owning session id.
 * @returns the segment.
 */
export function sessionSegment(sessionId: string): string {
  return `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`
}

/** Spill store over one R2 bucket. */
export class R2SpillStore extends SpillStore {
  static inject = ['cf']
  static Config: z<Config> = Config

  private readonly bucket: CfR2Bucket
  private readonly prefix: string

  constructor(ctx: Context, readonly config: Config) {
    super(ctx)
    this.bucket = ctx.cf.binding(config.bucket) as CfR2Bucket
    this.prefix = config.prefix
  }

  override async saveText(input: SaveTextSpill): Promise<SpillRef> {
    const name = `${randomBytes(6).toString('hex')}-${encodeSegment(input.suggestedName)}`
    const key = `${this.prefix}/${sessionSegment(input.owner.sessionId)}/${name}`
    const bytes = Buffer.byteLength(input.content, 'utf8')
    await this.bucket.put(key, input.content, {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
      customMetadata: {
        sessionId: input.owner.sessionId,
        toolName: input.source.toolName,
        callId: input.source.callId,
        label: input.source.label,
      },
    })
    return {
      locator: SpillLocator(key),
      bytes,
      retrievalHint: 'This is a spill object key in the deployment spill bucket; it is not a filesystem path.',
    }
  }
}

export default R2SpillStore
