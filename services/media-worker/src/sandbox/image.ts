/**
 * The untrusted-image decode boundary. Hardening:
 *   - DECODE GUARD: sharp is constructed with a hard `limitInputPixels` so a "pixel bomb" (tiny file
 *     declaring billions of pixels) is rejected at header-parse time, before any large allocation;
 *     `failOn: "warning"` (sharp's documented untrusted-input value - "error" still decodes many
 *     malformed/partial streams) so a corrupt stream is rejected; and `pages: 1` / `animated: false` so a
 *     multi-frame GIF/WebP / multi-page TIFF decodes only one surface (an animation's frames×pixels cannot
 *     blow the pixel budget). The post-metadata budget multiplies by `meta.pages` for the same reason.
 *   - FORMAT ALLOWLIST: after metadata() we assert the detected format is jpeg/png/webp, so a spoofed-MIME
 *     polyglot (SVG/TIFF/AVIF) cannot be decoded/re-encoded by an unintended libvips codec.
 *   - TIMEOUT: sharp has no built-in wall clock, so the JS-side withTimeout() rejects the promise on a
 *     wedge; the native libvips work continues until sharp's own `timeout` option fires, so peak RSS is
 *     bounded by the larger of the two (the JS reject does not cancel native work).
 *   - MEMORY: sharp.cache(false) and sharp.concurrency(1) keep per-call memory predictable under the
 *     worker's concurrency cap.
 *   - EXIF: read GPS for the report cross-check BEFORE stripping, then STRIP by re-encoding WITHOUT
 *     withMetadata() (sharp drops all metadata by default on output). Orientation is preserved by
 *     auto-rotating (`.rotate()` with no args bakes the EXIF orientation into the pixels) so dropping
 *     the EXIF orientation tag does not visually rotate the image.
 *
 * The seam rule: sharp and exifr are confined to sandbox/. exifr is used ONLY to read GPS (it does not
 * decode pixels); sharp owns all pixel work.
 */

import sharp, { type Sharp } from "sharp"
import exifr from "exifr"
import { settleWithin } from "@civfix/api/timeout"
import type { WorkerLimits } from "../config.js"

sharp.cache(false)
sharp.concurrency(1)

export const ALLOWED_IMAGE_FORMATS = ["jpeg", "png", "webp"] as const
export type AllowedImageFormat = (typeof ALLOWED_IMAGE_FORMATS)[number]

const PNG_COMPRESSION_LEVEL = 9
const STRIPPED_QUALITY = 90
const THUMB_QUALITY = 80
const THUMB_CONTENT_TYPE = "image/jpeg"
const MS_PER_SECOND = 1000
const MIN_SHARP_TIMEOUT_SEC = 1

const JPEG_MAGIC = [0xff, 0xd8, 0xff]
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46]
const WEBP_FORM_TYPE = [0x57, 0x45, 0x42, 0x50]
const WEBP_FORM_TYPE_OFFSET = 8

export interface ExifGps {
  lat: number
  lng: number
}

export interface ImageMeta {
  width: number
  height: number
  format: string
}

export interface ProcessedImage {
  meta: ImageMeta
  /** EXIF-stripped, auto-oriented re-encode of the full image. */
  strippedBytes: Buffer
  strippedContentType: string
  /** Also metadata-free. */
  thumbnailBytes: Buffer
  thumbnailContentType: string
  /** From the ORIGINAL EXIF, for the report GPS cross-check. */
  exifGps: ExifGps | null
}

export class ImageProcessingError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined)
    this.name = "ImageProcessingError"
    Object.setPrototypeOf(this, ImageProcessingError.prototype)
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return settleWithin(p, ms, {
    timeoutError: () => new ImageProcessingError(`${label} timed out after ${ms}ms`),
    // Every rejection out of this boundary must be an ImageProcessingError: the pipeline maps that (and
    // only that) to "reject the asset" rather than "retry the job".
    normalizeError: (err) =>
      err instanceof ImageProcessingError ? err : new ImageProcessingError(`${label} failed`, err),
  })
}

/** A spoofed-MIME input that libvips detects as anything else (SVG, TIFF, AVIF, GIF, ...) is rejected
 * before any full decode rather than re-encoded via an unintended codec. */
const ALLOWED_DECODED_FORMATS: ReadonlySet<string> = new Set(ALLOWED_IMAGE_FORMATS)

/**
 * The ALLOWED_DECODED_FORMATS check runs on `meta.format`, i.e. AFTER `metadata()`, and `metadata()`
 * is what dispatches untrusted bytes to a libvips loader. libvips picks the loader from the bytes, so an
 * SVG, PDF or TIFF header reached the corresponding libvips/librsvg/poppler header parser before we ever
 * got to reject it. The format allowlist was enforced one step too late to keep those codecs off the
 * untrusted path.
 *
 * This sniff runs in pure JS, on the raw bytes, BEFORE any sharp instance is constructed: only JPEG,
 * PNG and WebP signatures proceed, so libvips is never handed a non-allowlisted container at all. It is
 * a container gate, not a validity check: `metadata()` and the existing `meta.format` allowlist still
 * run afterwards and remain the authority on what is actually decoded.
 *
 * Signatures:
 *   JPEG  FF D8 FF
 *   PNG   89 50 4E 47 0D 0A 1A 0A
 *   WebP  "RIFF" .... "WEBP"  (RIFF container, WEBP form type at offset 8)
 */
export function sniffAllowedImageContainer(bytes: Uint8Array): AllowedImageFormat | null {
  if (hasBytesAt(bytes, 0, JPEG_MAGIC)) return "jpeg"
  if (hasBytesAt(bytes, 0, PNG_MAGIC)) return "png"
  if (
    hasBytesAt(bytes, 0, RIFF_MAGIC) &&
    hasBytesAt(bytes, WEBP_FORM_TYPE_OFFSET, WEBP_FORM_TYPE)
  ) {
    return "webp"
  }
  return null
}

function hasBytesAt(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  return (
    bytes.length >= offset + signature.length &&
    signature.every((byte, i) => bytes[offset + i] === byte)
  )
}

/**
 * EVERY untrusted-decode entry point must go through this, not a bare `sharp()`: it is where the container
 * sniff, pixel ceiling, failOn, single-page and sequential-read guards live as ONE set. phash.ts once kept
 * its own copy of the options, which drifted (no container sniff).
 */
export function guardedSharp(bytes: Uint8Array, limits: WorkerLimits): Sharp {
  // Refuse to even CONSTRUCT the pipeline for a container we would reject anyway, so libvips'
  // SVG/PDF/TIFF/GIF header loaders never see untrusted bytes.
  const container = sniffAllowedImageContainer(bytes)
  if (container === null) {
    throw new ImageProcessingError("unsupported image container (magic bytes not JPEG/PNG/WebP)")
  }
  return sharp(Buffer.from(bytes), {
    limitInputPixels: limits.sharpPixelLimit,
    failOn: "warning",
    pages: 1,
    animated: false,
    // Stream large progressive JPEG/TIFF inputs in one forward pass instead of libvips' random-access
    // read, so we never keep more of the decoded surface resident than necessary (caps peak RSS per
    // concurrent job under adversarial large-but-legal uploads).
    sequentialRead: true,
    // Seconds, rounded up so a sub-second config still yields >= 1s.
  }).timeout({
    seconds: Math.max(MIN_SHARP_TIMEOUT_SEC, Math.ceil(limits.imageTimeoutMs / MS_PER_SECOND)),
  })
}

function chooseOutput(format: string): {
  apply: (s: Sharp) => Sharp
  contentType: string
} {
  switch (format) {
    case "png":
      return {
        apply: (s) => s.png({ compressionLevel: PNG_COMPRESSION_LEVEL }),
        contentType: "image/png",
      }
    case "webp":
      return { apply: (s) => s.webp({ quality: STRIPPED_QUALITY }), contentType: "image/webp" }
    default:
      return {
        apply: (s) => s.jpeg({ quality: STRIPPED_QUALITY, mozjpeg: false }),
        contentType: "image/jpeg",
      }
  }
}

/** Never throws: a parse failure or missing GPS yields null, since absence of location is not an error. */
export async function readExifGps(bytes: Uint8Array): Promise<ExifGps | null> {
  try {
    const gps = (await exifr.gps(Buffer.from(bytes))) as
      | { latitude?: number; longitude?: number }
      | undefined
    if (
      gps &&
      typeof gps.latitude === "number" &&
      Number.isFinite(gps.latitude) &&
      typeof gps.longitude === "number" &&
      Number.isFinite(gps.longitude)
    ) {
      return { lat: gps.latitude, lng: gps.longitude }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Throws ImageProcessingError on any unsafe/undecodable input; the job handler maps that to a rejected
 * asset.
 */
export async function processImage(
  bytes: Uint8Array,
  limits: WorkerLimits,
): Promise<ProcessedImage> {
  const meta = await readGuardedMeta(bytes, limits)
  const exifGps = await readExifGps(bytes)
  const encoded = await encodeStrippedOutputs(bytes, meta.format, limits)
  return {
    meta,
    strippedBytes: encoded.strippedBytes,
    strippedContentType: encoded.strippedContentType,
    thumbnailBytes: encoded.thumbnailBytes,
    thumbnailContentType: THUMB_CONTENT_TYPE,
    exifGps,
  }
}

async function readGuardedMeta(bytes: Uint8Array, limits: WorkerLimits): Promise<ImageMeta> {
  // metadata() parses the header and enforces limitInputPixels; a bomb or garbage throws here before any
  // full decode.
  const meta = await withTimeout(
    guardedSharp(bytes, limits).metadata(),
    limits.imageTimeoutMs,
    "metadata",
  )

  if (!meta.format || typeof meta.width !== "number" || typeof meta.height !== "number") {
    throw new ImageProcessingError("image metadata missing format/dimensions")
  }
  if (!ALLOWED_DECODED_FORMATS.has(meta.format)) {
    throw new ImageProcessingError(`unsupported image format: ${meta.format}`)
  }
  // Defense in depth beyond sharp's own limit: enforce our (possibly stricter) pixel budget over the FULL
  // stacked surface (width*height*pages) so a multi-page/animated input cannot bypass maxImagePixels even
  // though we only decode page 1.
  const pixels = meta.width * meta.height * (meta.pages ?? 1)
  if (pixels > limits.maxImagePixels) {
    throw new ImageProcessingError(
      `image ${meta.width}x${meta.height}x${meta.pages ?? 1} exceeds pixel budget ${limits.maxImagePixels}`,
    )
  }
  return { width: meta.width, height: meta.height, format: meta.format }
}

async function encodeStrippedOutputs(
  bytes: Uint8Array,
  format: string,
  limits: WorkerLimits,
): Promise<{ strippedBytes: Buffer; strippedContentType: string; thumbnailBytes: Buffer }> {
  // Stripped full image AND thumbnail from a SINGLE decode: a fresh guardedSharp() per output would run
  // an independent full libvips decode (roughly doubling per-image CPU + peak surface on this CPU-bound
  // worker). Instead build one guarded pipeline, bake the EXIF orientation into the pixels once
  // (`.rotate()` with no args), then `.clone()` per output so sharp shares the one decoded surface.
  // Neither output calls withMetadata(), so all EXIF/XMP/ICC metadata is dropped on re-encode.
  const out = chooseOutput(format)
  const base = guardedSharp(bytes, limits).rotate()
  const [strippedBytes, thumbnailBytes] = await Promise.all([
    withTimeout(out.apply(base.clone()).toBuffer(), limits.imageTimeoutMs, "strip"),
    withTimeout(
      base
        .clone()
        .resize({
          width: limits.thumbnailMaxEdge,
          height: limits.thumbnailMaxEdge,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: THUMB_QUALITY })
        .toBuffer(),
      limits.imageTimeoutMs,
      "thumbnail",
    ),
  ])
  return { strippedBytes, strippedContentType: out.contentType, thumbnailBytes }
}

/** Proves the strip worked: true when no GPS survives in the re-encoded bytes. */
export async function hasNoGps(bytes: Uint8Array): Promise<boolean> {
  return (await readExifGps(bytes)) === null
}
