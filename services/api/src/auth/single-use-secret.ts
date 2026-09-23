/**
 * Atomic single-use secret store behind every short-lived bearer secret this service hands out (WS
 * handshake tickets, native sign-in nonces).
 *
 * At rest the secret is a credential, so only its SHA-256 is stored, as for session tokens: a cache dump
 * or a Redis MONITOR transcript must not yield a usable secret.
 *
 * Redemption is atomic. A `get` then `del` is a TOCTOU: concurrent callers presenting the same secret all
 * read the value before any of them deletes it. The claim is taken with INCR, the one primitive on the
 * CacheClient seam that is atomic across processes, and only the caller that receives 1 (the increment
 * that created the claim key) redeems. Every concurrent loser and every later replay sees more than 1 and
 * is refused, whether or not the value key has been deleted yet.
 */

import { generateToken, sha256Hex } from "./crypto.js"
import type { CacheClient } from "./cache.js"

export interface SingleUseSecretStore {
  /**
   * `value` is whatever the redeemer needs back (a user id for a WS ticket); it defaults to a placeholder
   * for secrets that carry nothing but their own existence (a sign-in nonce).
   */
  mint(value?: string): Promise<{ secret: string; expiresInSeconds: number }>
  /** Null when the secret was never issued, has expired, or has already been spent. */
  redeem(secret: string): Promise<string | null>
}

export interface SingleUseSecretOptions {
  /** Includes its trailing separator (e.g. "wsticket:"). */
  prefix: string
  /** Lifetime of both the value and its claim. */
  ttlSeconds: number
  newSecret?: () => string
}

const PRESENT = "1"

const CLAIM_SEGMENT = "claim:"

export function makeSingleUseSecretStore(
  cache: CacheClient,
  opts: SingleUseSecretOptions,
): SingleUseSecretStore {
  const { prefix, ttlSeconds } = opts
  const newSecret = opts.newSecret ?? (() => generateToken())
  const claimPrefix = prefix + CLAIM_SEGMENT

  return {
    async mint(value: string = PRESENT): Promise<{ secret: string; expiresInSeconds: number }> {
      const secret = newSecret()
      await cache.set(prefix + (await sha256Hex(secret)), value, ttlSeconds)
      return { secret, expiresInSeconds: ttlSeconds }
    },

    async redeem(secret: string): Promise<string | null> {
      if (typeof secret !== "string" || secret.length === 0) return null
      const hash = await sha256Hex(secret)

      // The claim is taken first and carries the secret's own TTL, so it expires with it. A claim spent on
      // an unknown or expired secret is harmless: it is keyed on that secret's hash, so it can only ever
      // throttle a replay of that same secret.
      const claim = await cache.incr(claimPrefix + hash, ttlSeconds)
      if (claim !== 1) return null

      const value = await cache.get(prefix + hash)
      if (value === null) return null
      await cache.del(prefix + hash)
      return value
    },
  }
}
