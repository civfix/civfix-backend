/**
 * The only place in the auth subsystem that reaches for raw crypto, so the choice of primitive lives in
 * one audited spot. Only the SHA-256 hex of a token is ever persisted, so a store leak does not expose
 * live tokens.
 */

import { randomBytes, randomInt, timingSafeEqual } from "node:crypto"
import { sha256 } from "oslo/crypto"

export const TOKEN_BYTES = 32

/**
 * Node's base64url is the genuinely URL-safe alphabet with no padding, so the token is safe verbatim in a
 * cookie and an Authorization header. oslo's encodeBase64url emits `+` and `/`, which is not cookie-safe.
 */
export function generateToken(byteLength: number = TOKEN_BYTES): string {
  return randomBytes(byteLength).toString("base64url")
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await sha256(new TextEncoder().encode(input))
  return Buffer.from(digest).toString("hex")
}

/** node's randomInt rejection-samples, so there is no modulo bias; it throws on a max outside [1, 2^48). */
export function randomIntBelow(max: number): number {
  return randomInt(max)
}

export function generateNumericCode(digits: number): string {
  let out = ""
  for (let i = 0; i < digits; i++) {
    out += String(randomIntBelow(10))
  }
  return out
}

/**
 * A length mismatch returns early: the length of a token, CSRF value or HMAC is not secret, only its
 * contents are, and every caller compares fixed-width values. The one canonical secret compare for auth,
 * the inbound-mail webhook and anon tokens and codes; do not reimplement it elsewhere.
 */
export function constantTimeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
