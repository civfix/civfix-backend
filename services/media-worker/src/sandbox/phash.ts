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

import { guardedSharp, ImageProcessingError } from "./image.js"
import type { WorkerLimits } from "../config.js"

/** dHash grid: (HASH_W + 1) columns x HASH_H rows -> HASH_W*HASH_H comparison bits. */
const HASH_W = 8
const HASH_H = 8

/**
 * Compute the dHash hex string for `bytes`. The SECOND untrusted-decode boundary (the image path is the
 * first), so it uses image.ts's guardedSharp rather than its own sharp options: that is the single place
 * the container sniff (L15), pixel ceiling, failOn "warning", single-page and sequential-read guards live.
 * It previously duplicated the options and had drifted — no magic-byte sniff — which mattered because
 * seams.ts injects this function into RealAbuseChecks.pHash, where a future caller need not have run
 * processImage's container check first. Throws ImageProcessingError if the bytes cannot be decoded.
 */
export async function perceptualHash(bytes: Uint8Array, limits: WorkerLimits): Promise<string> {
  let raw: Buffer
  try {
    raw = await guardedSharp(bytes, limits)
      // Grayscale, exact small size (ignore aspect so the grid is fixed), raw 1-channel pixels.
      .greyscale()
      .resize(HASH_W + 1, HASH_H, { fit: "fill" })
      .raw()
      .toBuffer()
  } catch (err) {
    throw err instanceof ImageProcessingError
      ? err
      : new ImageProcessingError("perceptual hash decode failed", err)
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
