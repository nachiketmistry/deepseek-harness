/**
 * Pure-JavaScript raster header inspection for the four accepted image
 * formats. workerd has no native image decoder, so admission verifies the
 * container signature and intrinsic dimensions from the header instead of
 * the local provider's full raster decode; a truncated or corrupt pixel
 * stream is therefore not detected here and reaches the model provider.
 * @module @deepseek-ai/dsh-attachment-r2/image
 */

import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** Header-derived metadata from a supported image. */
export interface DetectedImage {
  mediaType: ImageMediaType
  width: number
  height: number
}

/** Admission limits applied to a raster's intrinsic dimensions. */
export interface DecodedImageLimits {
  /** Pixel (width times height) admission limit. */
  maxPixels?: number
  /** Per-side admission limit applied to width and height independently. */
  maxDimension?: number
}

function invalid(): AttachmentError {
  return new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE')
}

function u16be(view: DataView, offset: number): number {
  if (offset + 2 > view.byteLength) throw invalid()
  return view.getUint16(offset)
}

function u32be(view: DataView, offset: number): number {
  if (offset + 4 > view.byteLength) throw invalid()
  return view.getUint32(offset)
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  if (offset + length > data.byteLength) return ''
  let out = ''
  for (let i = offset; i < offset + length; i++) out += String.fromCharCode(data[i] as number)
  return out
}

function png(data: Uint8Array, view: DataView): DetectedImage {
  // Signature, then the IHDR chunk must come first: length(4) "IHDR"(4) width(4) height(4).
  if (ascii(data, 12, 4) !== 'IHDR') throw invalid()
  const width = u32be(view, 16)
  const height = u32be(view, 20)
  if (width === 0 || height === 0) throw invalid()
  return { mediaType: 'image/png', width, height }
}

function gif(view: DataView): DetectedImage {
  const width = view.getUint16(6, true)
  const height = view.getUint16(8, true)
  if (width === 0 || height === 0) throw invalid()
  return { mediaType: 'image/gif', width, height }
}

function jpeg(data: Uint8Array, view: DataView): DetectedImage {
  // Walk the marker segments to the first start-of-frame marker.
  let offset = 2
  while (offset + 4 <= data.byteLength) {
    if (data[offset] !== 0xff) throw invalid()
    const marker = data[offset + 1] as number
    if (marker === 0xff) {
      offset += 1
      continue
    }
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = u16be(view, offset + 2)
    if (length < 2) throw invalid()
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      const height = u16be(view, offset + 5)
      const width = u16be(view, offset + 7)
      if (width === 0 || height === 0) throw invalid()
      return { mediaType: 'image/jpeg', width, height }
    }
    if (marker === 0xd9 || marker === 0xda) break
    offset += 2 + length
  }
  throw invalid()
}

function webp(data: Uint8Array, view: DataView): DetectedImage {
  const chunk = ascii(data, 12, 4)
  if (chunk === 'VP8 ') {
    // Lossy bitstream: 3-byte frame tag, 3-byte start code, then 14-bit dimensions.
    if (data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) throw invalid()
    const width = view.getUint16(26, true) & 0x3fff
    const height = view.getUint16(28, true) & 0x3fff
    if (width === 0 || height === 0) throw invalid()
    return { mediaType: 'image/webp', width, height }
  }
  if (chunk === 'VP8L') {
    if (data[20] !== 0x2f) throw invalid()
    const bits = view.getUint32(21, true)
    return { mediaType: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    if (data.byteLength < 30) throw invalid()
    const width = 1 + ((data[24] as number) | ((data[25] as number) << 8) | ((data[26] as number) << 16))
    const height = 1 + ((data[27] as number) | ((data[28] as number) << 8) | ((data[29] as number) << 16))
    return { mediaType: 'image/webp', width, height }
  }
  throw invalid()
}

/**
 * Parse a supported raster's header and return its intrinsic metadata.
 * @param data - complete encoded image bytes.
 * @returns verified format and dimensions.
 * @throws AttachmentError `INVALID_IMAGE` when no accepted signature matches or the header is malformed.
 */
export function probeImage(data: Uint8Array): DetectedImage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  try {
    if (data.byteLength >= 24 && ascii(data, 1, 3) === 'PNG' && data[0] === 0x89) return png(data, view)
    if (data.byteLength >= 10 && (ascii(data, 0, 6) === 'GIF87a' || ascii(data, 0, 6) === 'GIF89a')) return gif(view)
    if (data.byteLength >= 4 && data[0] === 0xff && data[1] === 0xd8) return jpeg(data, view)
    if (data.byteLength >= 30 && ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 4) === 'WEBP') return webp(data, view)
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
  }
  throw invalid()
}

/**
 * Inspect a supported raster's header and apply the intrinsic-dimension limits.
 * @param data - complete encoded image bytes.
 * @param limits - intrinsic-dimension admission limits.
 * @returns verified format and dimensions.
 */
export function detectImage(data: Uint8Array, limits?: DecodedImageLimits): DetectedImage {
  const detected = probeImage(data)
  if (limits?.maxPixels !== undefined && detected.width * detected.height > limits.maxPixels) {
    throw new AttachmentError('Image exceeds the configured decoded-pixel limit.', 'IMAGE_TOO_MANY_PIXELS')
  }
  if (limits?.maxDimension !== undefined && Math.max(detected.width, detected.height) > limits.maxDimension) {
    throw new AttachmentError('Image exceeds the configured per-side pixel limit.', 'IMAGE_DIMENSION_TOO_LARGE')
  }
  return detected
}
