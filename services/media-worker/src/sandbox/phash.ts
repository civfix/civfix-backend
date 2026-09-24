/**
 * The hash is computed from PIXELS (not raw file bytes) so visually-similar images map to similar
 * hashes, which is what near-duplicate detection needs. Algorithm: difference hash (dHash):
 *   1. downscale to (W+1) x H grayscale (default 9x8 -> 64-bit hash);
 *   2. for each row, compare each pixel to its right neighbor: bit = left > right;
 *   3. pack the 64 comparison bits into a 16-char hex string.
 * dHash is robust to scaling/JPEG artifacts and is cheap + fully deterministic across platforms.
 *
 * The hash is the worker's own perceptual signature. The job handler separately calls the
 * AbuseChecks.isNearDuplicate seam (passing this hash) to decide dedupe, so the perceptual signal and
 * the dedupe POLICY stay decoupled.
 */

import { guardedSharp, ImageProcessingError } from "./image.js"
import type { WorkerLimits } from "../config.js"

const HASH_W = 8
const HASH_H = 8

/**
 * The SECOND untrusted-decode boundary (the image path is the first), so it uses image.ts's guardedSharp
 * rather than its own sharp options: that is the single place the container sniff, pixel ceiling, failOn
 * "warning", single-page and sequential-read guards live. seams.ts injects this into
 * RealAbuseChecks.pHash, where a caller need not have run processImage's container check first.
 */
export async function perceptualHash(bytes: Uint8Array, limits: WorkerLimits): Promise<string> {
  let raw: Buffer
  try {
    raw = await guardedSharp(bytes, limits)
      // Aspect is ignored so the grid is fixed.
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
  const bits: number[] = []
  for (let y = 0; y < HASH_H; y++) {
    for (let x = 0; x < HASH_W; x++) {
      const left = raw[y * cols + x] ?? 0
      const right = raw[y * cols + x + 1] ?? 0
      bits.push(left > right ? 1 : 0)
    }
  }

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
