/**
 * Perceptual hash (dHash) computed from a normalized small grayscale via sharp.
 *
 * We compute the hash from PIXELS (not raw file bytes) so visually-similar images map to similar
 * hashes, which is what near-duplicate detection needs. Algorithm: difference hash (dHash):
 *   1. downscale to (W+1) x H grayscale (default 9x8 -> 64-bit hash);
 *   2. for each row, compare each pixel to its right neighbor: bit = left > right;
 *   3. pack the 64 comparison bits into a 16-char hex string.
 * dHash is robust to scaling/JPEG artifacts and is cheap + fully deterministic across platforms.
 *
 * The hash is the worker's own perceptual signature. The job handler separately calls the
 * AbuseChecks.isNearDuplicate seam (passing this hash) to decide dedupe, so the perceptual signal and
 * the dedupe POLICY stay decoupled. sharp is confined to sandbox/ per the seam rule.
 */

import sharp from "sharp"
import { ImageProcessingError } from "./image.js"
import type { WorkerLimits } from "../config.js"

/** dHash grid: (HASH_W + 1) columns x HASH_H rows -> HASH_W*HASH_H comparison bits. */
const HASH_W = 8
const HASH_H = 8

/**
 * Compute the dHash hex string for `bytes`. The SECOND untrusted-decode boundary (the image path is the
 * first), so it mirrors guardedSharp's hardening: limitInputPixels + failOn "warning" + pages:1/
 * animated:false (decode one frame only). Throws ImageProcessingError if the bytes cannot be decoded.
 */
export async function perceptualHash(bytes: Uint8Array, limits: WorkerLimits): Promise<string> {
  let raw: Buffer
  try {
    raw = await sharp(Buffer.from(bytes), {
      limitInputPixels: limits.sharpPixelLimit,
      // sharp's documented untrusted-input value (matches image.ts guardedSharp).
      failOn: "warning",
      // Decode only the first frame/page (no animation surface) — matches the image path's cap.
      pages: 1,
      animated: false,
      // Stream large progressive inputs in one forward pass so the hash decode never keeps more of the
      // surface resident than needed under the worker concurrency cap.
      sequentialRead: true,
    })
      .timeout({ seconds: Math.max(1, Math.ceil(limits.imageTimeoutMs / 1000)) })
      // Grayscale, exact small size (ignore aspect so the grid is fixed), raw 1-channel pixels.
      .greyscale()
      .resize(HASH_W + 1, HASH_H, { fit: "fill" })
      .raw()
      .toBuffer()
  } catch (err) {
    throw new ImageProcessingError("perceptual hash decode failed", err)
  }

  const cols = HASH_W + 1
  // Build the bitstring row by row: compare each pixel to its right neighbor.
  const bits: number[] = []
  for (let y = 0; y < HASH_H; y++) {
    for (let x = 0; x < HASH_W; x++) {
      const left = raw[y * cols + x] ?? 0
      const right = raw[y * cols + x + 1] ?? 0
      bits.push(left > right ? 1 : 0)
    }
  }

  // Pack 64 bits into 16 hex chars (4 bits per char).
  let hex = ""
  for (let i = 0; i < bits.length; i += 4) {
    const nibble =
      ((bits[i] ?? 0) << 3) |
      ((bits[i + 1] ?? 0) << 2) |
      ((bits[i + 2] ?? 0) << 1) |
      (bits[i + 3] ?? 0)
    hex += nibble.toString(16)
  }
  return hex
}

/** Hamming distance between two equal-length hex hashes (number of differing bits). */
export function hammingDistanceHex(a: string, b: string): number {
  if (a.length !== b.length) return Math.max(a.length, b.length) * 4
  let dist = 0
  for (let i = 0; i < a.length; i++) {
    const xor = (parseInt(a[i] ?? "0", 16) ^ parseInt(b[i] ?? "0", 16)) & 0xf
    dist += (xor & 1) + ((xor >> 1) & 1) + ((xor >> 2) & 1) + ((xor >> 3) & 1)
  }
  return dist
}
