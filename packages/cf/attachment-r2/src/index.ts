/**
 * R2-backed attachment store: content-addressed image objects under
 * `<prefix>/sha256:<digest>` in one bucket, with the verified media type as
 * the object's content type. Objects are immutable and self-describing, so no
 * index lives in the Durable Object; a read fetches by key and re-verifies
 * the digest against the reference exactly as the local store does.
 * @module @deepseek-ai/dsh-attachment-r2
 */

import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-cf-bindings'
import type { CfR2Bucket } from '@deepseek-ai/dsh-cf-bindings'
import { AttachmentError, AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { detectImage, probeImage } from './image.ts'

export { detectImage, probeImage } from './image.ts'
export type { DecodedImageLimits, DetectedImage } from './image.ts'

/** Default maximum encoded bytes for one image. */
export const DEFAULT_MAX_IMAGE_BYTES = 3.5 * 1024 * 1024
/** Default maximum images in one prompt. */
export const DEFAULT_MAX_IMAGES_PER_MESSAGE = 20
/** Default maximum aggregate image bytes in one prompt. */
export const DEFAULT_MAX_MESSAGE_IMAGE_BYTES = 100 * 1024 * 1024
/** Default maximum intrinsic pixels for one image. */
export const DEFAULT_MAX_IMAGE_PIXELS = 40_000_000
/** Default maximum intrinsic width and height for one image; the same line the local store admits at. */
export const DEFAULT_MAX_IMAGE_DIMENSION = 2000

const ID_PATTERN = /^sha256:([a-f0-9]{64})$/

/** R2 attachment store configuration. */
export interface Config {
  /** The R2 bucket binding name. */
  bucket: string
  /** Key prefix every object lives under. */
  prefix: string
  /** Maximum encoded bytes accepted for one image. */
  maxImageBytes: number
  /** Maximum image count accepted in one submitted message. */
  maxImagesPerMessage: number
  /** Maximum aggregate encoded image bytes accepted in one submitted message. */
  maxMessageImageBytes: number
  /** Maximum intrinsic width multiplied by height accepted for one image. */
  maxImagePixels: number
  /** Maximum intrinsic width and maximum intrinsic height accepted for one image. */
  maxImageDimension: number
}

/** Validated configuration. */
export const Config: z<Config> = z.object({
  bucket: z.string().default('ATTACHMENTS'),
  prefix: z.string().default('attachments'),
  maxImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_BYTES),
  maxImagesPerMessage: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGES_PER_MESSAGE),
  maxMessageImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_IMAGE_BYTES),
  maxImagePixels: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_PIXELS),
  maxImageDimension: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_DIMENSION),
})

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function displayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  // Strip both separator styles: a Windows client's full local path must not
  // leak into the reference and the session log.
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255)
  return clean === '' ? undefined : clean
}

function ensureReference(ref: ImageAttachmentRef): string {
  const match = ID_PATTERN.exec(String(ref.attachmentId))
  if (match?.[1] === undefined) throw new AttachmentError('Attachment reference is invalid.', 'INVALID_ATTACHMENT_REF')
  return match[1]
}

function inspectMetadata(
  data: Uint8Array,
  declaredMediaType: ImageAttachmentRef['mediaType'],
  limits: ImageAttachmentLimits,
): Omit<ImageAttachmentRef, 'attachmentId' | 'name'> {
  if (data.byteLength === 0) throw new AttachmentError('Image is empty.', 'INVALID_IMAGE')
  const detected = detectImage(data, { maxPixels: limits.maxImagePixels, maxDimension: limits.maxImageDimension })
  if (detected.mediaType !== declaredMediaType) throw new AttachmentError('Declared image type does not match its bytes.', 'IMAGE_TYPE_MISMATCH')
  return { ...detected, bytes: data.byteLength }
}

/** Content-addressed attachment store over one R2 bucket. */
export class R2AttachmentStore extends AttachmentStore {
  static inject = ['cf']
  static Config: z<Config> = Config

  readonly imageLimits: ImageAttachmentLimits
  private readonly bucket: CfR2Bucket
  private readonly prefix: string

  constructor(ctx: Context, readonly config: Config) {
    super(ctx)
    this.bucket = ctx.cf.binding(config.bucket) as CfR2Bucket
    this.prefix = config.prefix
    this.imageLimits = Object.freeze({
      maxImageBytes: config.maxImageBytes,
      maxImagesPerMessage: config.maxImagesPerMessage,
      maxMessageImageBytes: config.maxMessageImageBytes,
      maxImagePixels: config.maxImagePixels,
      maxImageDimension: config.maxImageDimension,
      mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const),
    })
  }

  /** The R2 object key for one content digest. */
  private key(sha256: string): string {
    return `${this.prefix}/sha256:${sha256}`
  }

  override validateImage(input: SaveImageAttachment): Promise<void> {
    if (input.data.byteLength > this.imageLimits.maxImageBytes) {
      return Promise.reject(new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE'))
    }
    try {
      inspectMetadata(input.data, input.mediaType, this.imageLimits)
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    return Promise.resolve()
  }

  override async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    if (input.data.byteLength > this.imageLimits.maxImageBytes) {
      throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE')
    }
    const metadata = inspectMetadata(input.data, input.mediaType, this.imageLimits)
    const sha256 = digest(input.data)
    try {
      // Content addressing makes a repeated put idempotent: identical bytes
      // land on the identical key, so no read-before-write is needed.
      await this.bucket.put(this.key(sha256), input.data, {
        httpMetadata: { contentType: metadata.mediaType },
        customMetadata: { sha256, width: String(metadata.width), height: String(metadata.height) },
      })
    } catch (error) {
      throw new AttachmentError('Unable to persist image attachment.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
    }
    const name = displayName(input.name)
    return {
      attachmentId: AttachmentId(`sha256:${sha256}`),
      ...metadata,
      ...(name !== undefined ? { name } : {}),
    }
  }

  override async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    signal?.throwIfAborted()
    const sha256 = ensureReference(ref)
    let data: Uint8Array
    try {
      const object = await this.bucket.get(this.key(sha256))
      if (object === null) throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
      data = new Uint8Array(await object.arrayBuffer())
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof AttachmentError) throw error
      throw new AttachmentError('Unable to read image attachment.', 'ATTACHMENT_READ_FAILED', { cause: error })
    }
    signal?.throwIfAborted()
    if (digest(data) !== sha256) throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
    const metadata = probeImage(data)
    if (metadata.mediaType !== ref.mediaType || data.byteLength !== ref.bytes
      || metadata.width !== ref.width || metadata.height !== ref.height) {
      throw new AttachmentError('Stored attachment metadata does not match its reference.', 'ATTACHMENT_CORRUPT')
    }
    return { ref, data }
  }
}

export default R2AttachmentStore
