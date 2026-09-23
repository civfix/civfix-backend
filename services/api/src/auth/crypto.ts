/**
 * The only place in the auth subsystem that reaches for raw crypto, so the choice of primitive lives in
 * one audited spot. Only the SHA-256 hex of a token is ever persisted, so a store leak does not expose
 * live tokens.
 */

import { randomBytes, timingSafeEqual } from "node:crypto"
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

/** Rejection sampling over whole bytes, so there is no modulo bias. */
export function randomIntBelow(max: number): number {
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error("randomIntBelow: max must be a positive integer")
  }
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
