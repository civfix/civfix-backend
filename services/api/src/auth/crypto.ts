/**
 * Low-level auth crypto primitives.
 *
 * This module is the ONLY place in the auth subsystem that reaches for raw crypto (oslo +
 * node:crypto). Everything else (session service, OTP, CSRF) composes these helpers so the choice
 * of primitive lives in one audited spot.
 *
 *   - opaque tokens are 256 bits of CSPRNG entropy, base64url-encoded (no padding);
 *   - only the SHA-256 hex of a token is ever persisted, so a store leak does not expose live
 *     tokens;
 *   - numeric OTP codes use a rejection-free uniform integer draw (no modulo bias);
 *   - string comparisons that touch secrets are constant-time.
 */

import { randomBytes } from "node:crypto"
import { sha256 } from "oslo/crypto"
import { constantTimeEqual } from "oslo/crypto"

/** Byte length of an opaque session / CSRF / anon token before encoding (256 bits). */
export const TOKEN_BYTES = 32

/**
 * Generate a high-entropy opaque token: 256 random bits, base64url without padding. Node's base64url
 * is the genuinely URL-safe alphabet (`-`/`_`, no padding), so the token is safe verbatim in a cookie
 * value AND in an Authorization header without any further encoding. (oslo's encodeBase64url emits
 * the standard `+`/`/` alphabet, which is NOT cookie-safe, so we deliberately do not use it here.)
 */
export function generateToken(byteLength: number = TOKEN_BYTES): string {
  return randomBytes(byteLength).toString("base64url")
}

/**
 * SHA-256 hex digest of a UTF-8 string (64 lowercase hex chars). Used to derive the stored session
 * id from the raw token and to fingerprint anon tokens.
 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await sha256(new TextEncoder().encode(input))
  return Buffer.from(digest).toString("hex")
}

/**
 * Draw a cryptographically uniform integer in [0, max) without modulo bias. Uses rejection sampling
 * over whole bytes so every value in range is equally likely.
 */
export function randomIntBelow(max: number): number {
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error("randomIntBelow: max must be a positive integer")
  }
  // Number of bytes needed to represent max-1, and the largest multiple of `max` that fits so we can
  // reject the remainder and stay unbiased.
  const bytes = Math.ceil(Math.log2(max) / 8) || 1
  const maxUint = 256 ** bytes
  const limit = maxUint - (maxUint % max)
  for (;;) {
    const buf = randomBytes(bytes)
    let value = 0
    for (let i = 0; i < bytes; i++) {
      value = value * 256 + buf[i]!
    }
    if (value < limit) {
      return value % max
    }
  }
}

/**
 * Generate a zero-padded numeric code of the given length (e.g. a 6-digit OTP). Each digit is an
 * independent unbiased draw.
 */
export function generateNumericCode(digits: number): string {
  let out = ""
  for (let i = 0; i < digits; i++) {
    out += String(randomIntBelow(10))
  }
  return out
}

/**
 * Constant-time string equality. Compares the UTF-8 byte encodings; returns false for differing
 * lengths (oslo's constantTimeEqual short-circuits on length, which is acceptable: the length of a
 * token / CSRF value is not secret, only its contents are).
 */
export function constantTimeStringEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a)
  const bb = new TextEncoder().encode(b)
  return constantTimeEqual(ab, bb)
}
