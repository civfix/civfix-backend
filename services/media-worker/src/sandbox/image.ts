/**
 * Sandboxed image processing (sharp + exifr).
 *
 * This is the untrusted-image decode boundary. Hardening:
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

import sharp from "sharp"
import exifr from "exifr"
import type { WorkerLimits } from "../config.js"

// Predictable memory under the worker concurrency cap: no internal cache, single libvips thread.
sharp.cache(false)
sharp.concurrency(1)

/** GPS coordinates read from EXIF, if present and finite. */
export interface ExifGps {
  lat: number
  lng: number
}

export interface ImageMeta {
  width: number
  height: number
  /** sharp's detected format (e.g. "jpeg", "png", "webp"). */
  format: string
}

export interface ProcessedImage {
  meta: ImageMeta
  /** EXIF-stripped, auto-oriented re-encode of the full image. */
  strippedBytes: Buffer
  /** Content-type for the stripped image (matches the chosen output encoder). */
  strippedContentType: string
  /** ~thumbnailMaxEdge JPEG thumbnail (also metadata-free). */
  thumbnailBytes: Buffer
  thumbnailContentType: string
  /** GPS from the ORIGINAL EXIF (for the report GPS cross-check), or null. */
  exifGps: ExifGps | null
}

/** Error thrown when an image cannot be safely decoded/processed (bomb, garbage, unsupported). */
export class ImageProcessingError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined)
    this.name = "ImageProcessingError"
    Object.setPrototypeOf(this, ImageProcessingError.prototype)
  }
}

/** Reject a promise if it does not settle within `ms`. Used to bound native sharp work. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new ImageProcessingError(`${label} timed out after ${ms}ms`))
    }, ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (err: unknown) => {
        clearTimeout(t)
        reject(
          err instanceof ImageProcessingError
            ? err
            : new ImageProcessingError(`${label} failed`, err),
        )
      },
    )
  })
}

/** Formats we will DECODE + re-encode. A spoofed-MIME input that libvips detects as anything else (SVG,
 * TIFF, AVIF, GIF, ...) is rejected before any full decode rather than re-encoded via an unintended codec. */
const ALLOWED_DECODED_FORMATS: ReadonlySet<string> = new Set(["jpeg", "png", "webp"])

/** Build a guarded sharp instance over untrusted bytes (no decoding happens until a consumer runs). */
function guardedSharp(bytes: Uint8Array, limits: WorkerLimits): sharp.Sharp {
  return sharp(Buffer.from(bytes), {
    // Reject decode bombs at header parse: refuse inputs above this pixel ceiling.
    limitInputPixels: limits.sharpPixelLimit,
    // sharp's documented untrusted-input value: reject a corrupt/partial stream. ("error" still decodes
    // many malformed streams; "warning" is the stricter untrusted boundary.)
    failOn: "warning",
    // Decode ONLY the first frame/page of an animated GIF/WebP or multi-page TIFF, so frames×pixels of an
    // animation cannot blow past the pixel budget (the post-metadata check multiplies by meta.pages too).
    pages: 1,
    animated: false,
    // Stream large progressive JPEG/TIFF inputs in one forward pass instead of libvips' random-access
    // read, so we never keep more of the decoded surface resident than necessary (caps peak RSS per
    // concurrent job under adversarial large-but-legal uploads).
    sequentialRead: true,
    // sharp's own per-pipeline wall clock (seconds), rounded up so a sub-second config still yields >= 1s.
  }).timeout({ seconds: Math.max(1, Math.ceil(limits.imageTimeoutMs / 1000)) })
}

/** Choose the stripped-image output encoder + content type from the detected (allowlisted) input format. */
function chooseOutput(format: string): {
  apply: (s: sharp.Sharp) => sharp.Sharp
  contentType: string
} {
  switch (format) {
    case "png":
      return { apply: (s) => s.png({ compressionLevel: 9 }), contentType: "image/png" }
    case "webp":
      return { apply: (s) => s.webp({ quality: 90 }), contentType: "image/webp" }
    default:
      return { apply: (s) => s.jpeg({ quality: 90, mozjpeg: false }), contentType: "image/jpeg" }
  }
}

/**
 * Read GPS from EXIF without decoding pixels. Never throws: a parse failure or missing GPS yields null
 * (absence of location is not an error). Returns null unless both lat/lng are finite.
 */
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
 * Decode-guard + EXIF read/strip + thumbnail. Throws ImageProcessingError on any unsafe/undecodable
 * input (the job handler maps that to a rejected asset). On success returns the stripped image, a
 * thumbnail, dimensions, and the original EXIF GPS (for the report cross-check).
 */
export async function processImage(
  bytes: Uint8Array,
  limits: WorkerLimits,
): Promise<ProcessedImage> {
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
  // Format allowlist: reject a spoofed-MIME polyglot (SVG/TIFF/AVIF/GIF/...) before any full decode so an
  // unintended libvips codec is never reached. Only jpeg/png/webp are decoded + re-encoded.
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

  // GPS from the original EXIF (pre-strip), for the report GPS cross-check note. Never throws.
  const exifGps = await readExifGps(bytes)

  // Stripped full image AND thumbnail from a SINGLE decode: a fresh guardedSharp() per output would run
  // an independent full libvips decode (roughly doubling per-image CPU + peak surface on this CPU-bound
  // worker). Instead build one guarded pipeline, bake the EXIF orientation into the pixels once
  // (`.rotate()` with no args), then `.clone()` per output so sharp shares the one decoded surface.
  // Neither output calls withMetadata(), so all EXIF/XMP/ICC metadata is dropped on re-encode.
  const out = chooseOutput(meta.format)
  const base = guardedSharp(bytes, limits).rotate()
  const [strippedBytes, thumbnailBytes] = await Promise.all([
    // Stripped full image: chosen output encoder, metadata-free.
    withTimeout(out.apply(base.clone()).toBuffer(), limits.imageTimeoutMs, "strip"),
    // Thumbnail: longest edge <= thumbnailMaxEdge, JPEG, metadata-free.
    withTimeout(
      base
        .clone()
        .resize({
          width: limits.thumbnailMaxEdge,
          height: limits.thumbnailMaxEdge,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 80 })
        .toBuffer(),
      limits.imageTimeoutMs,
      "thumbnail",
    ),
  ])

  return {
    meta: { width: meta.width, height: meta.height, format: meta.format },
    strippedBytes,
    strippedContentType: out.contentType,
    thumbnailBytes,
    thumbnailContentType: "image/jpeg",
    exifGps,
  }
}

/**
 * Assert that a processed image buffer carries NO EXIF GPS. Used by tests (and as a cheap post-strip
 * self-check) to prove the strip worked. Returns true when no GPS is present.
 */
export async function hasNoGps(bytes: Uint8Array): Promise<boolean> {
  return (await readExifGps(bytes)) === null
}
