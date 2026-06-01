/**
 * Sandboxed image processing (sharp + exifr).
 *
 * This is the untrusted-image decode boundary. Hardening:
 *   - DECODE GUARD: sharp is constructed with a hard `limitInputPixels` so a "pixel bomb" (tiny file
 *     declaring billions of pixels) is rejected at header-parse time, before any large allocation, and
 *     with `failOn: "error"` so a truncated/garbage stream errors instead of yielding a partial image.
 *   - TIMEOUT: sharp has no built-in wall clock, so every pipeline is wrapped in withTimeout(); if the
 *     native work wedges, the job-level deadline still fires and the asset is rejected (the sharp call
 *     is also bounded by sharp's own `timeout` option as a second line).
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

/** Build a guarded sharp instance over untrusted bytes (no decoding happens until a consumer runs). */
function guardedSharp(bytes: Uint8Array, limits: WorkerLimits): sharp.Sharp {
  return sharp(Buffer.from(bytes), {
    // Reject decode bombs at header parse: refuse inputs above this pixel ceiling.
    limitInputPixels: limits.sharpPixelLimit,
    // Error (do not silently truncate) on a corrupt/partial stream.
    failOn: "error",
    // sharp's own per-pipeline wall clock (seconds), as a second line under withTimeout.
    // (Rounded up so a sub-second config still yields >= 1s for libvips.)
  }).timeout({ seconds: Math.max(1, Math.ceil(limits.imageTimeoutMs / 1000)) })
}

/** Choose the stripped-image output encoder + content type from the detected input format. */
function chooseOutput(format: string): {
  apply: (s: sharp.Sharp) => sharp.Sharp
  contentType: string
} {
  switch (format) {
    case "png":
      return { apply: (s) => s.png({ compressionLevel: 9 }), contentType: "image/png" }
    case "webp":
      return { apply: (s) => s.webp({ quality: 90 }), contentType: "image/webp" }
    // jpeg, and anything else we successfully decoded, normalize to JPEG.
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
  // 1) Metadata/decode guard. metadata() parses the header and enforces limitInputPixels; a bomb or
  //    garbage throws here before any full decode.
  const meta = await withTimeout(
    guardedSharp(bytes, limits).metadata(),
    limits.imageTimeoutMs,
    "metadata",
  )

  if (!meta.format || typeof meta.width !== "number" || typeof meta.height !== "number") {
    throw new ImageProcessingError("image metadata missing format/dimensions")
  }
  // Defense in depth beyond sharp's own limit: enforce our (possibly stricter) pixel budget.
  const pixels = meta.width * meta.height
  if (pixels > limits.maxImagePixels) {
    throw new ImageProcessingError(
      `image ${meta.width}x${meta.height} exceeds pixel budget ${limits.maxImagePixels}`,
    )
  }

  // 2) GPS from the original EXIF (pre-strip), for the report GPS cross-check note. Never throws.
  const exifGps = await readExifGps(bytes)

  // 3) Stripped full image: auto-orient (bakes EXIF orientation into pixels), re-encode WITHOUT
  //    withMetadata() so all EXIF/XMP/ICC-as-metadata is dropped. limitInputPixels still applies.
  const out = chooseOutput(meta.format)
  const strippedBytes = await withTimeout(
    out.apply(guardedSharp(bytes, limits).rotate()).toBuffer(),
    limits.imageTimeoutMs,
    "strip",
  )

  // 4) Thumbnail: same guard, auto-oriented, longest edge <= thumbnailMaxEdge, JPEG, metadata-free.
  const thumbnailBytes = await withTimeout(
    guardedSharp(bytes, limits)
      .rotate()
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
  )

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
