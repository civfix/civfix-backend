/**
 * Atomic single-use secret store — the one mint/redeem machine behind every short-lived bearer secret
 * this service hands out (WS handshake tickets, native sign-in nonces).
 *
 * Both callers need the same two properties, and both are enforced HERE rather than by each caller, so
 * the M2/H1 reasoning lives in one audited place instead of being re-derived per feature:
 *
 *   - AT REST the secret is a credential, so only its SHA-256 is stored, exactly as session tokens are
 *     (a cache dump or a Redis MONITOR transcript must not yield a usable secret).
 *   - REDEMPTION IS ATOMIC. A `get` then `del` is a TOCTOU: N callers presenting the same secret
 *     concurrently all read the value before any of them deletes it, so "single-use" holds only when
 *     nothing races. The claim is taken with INCR — the one primitive on the CacheClient seam that is
 *     atomic across processes — and only the caller that receives 1 (the increment that CREATED the
 *     claim key) is the redeemer. Every concurrent loser and every later replay sees >1 and is refused,
 *     whether or not the value key has been deleted yet.
 *
 * Keys are `<prefix><sha256>` for the value and `<prefix>claim:<sha256>` for the claim, which is exactly
 * the layout the ws-ticket and oauth-nonce keys already had — an in-flight ticket or nonce in a live
 * Redis keeps redeeming across a deploy of this refactor.
 */

import { generateToken, sha256Hex } from "./crypto.js"
import type { CacheClient } from "./cache.js"

export interface SingleUseSecretStore {
  /**
   * Mint a secret and store `value` under its hash for the configured TTL. `value` is whatever the
   * redeemer needs back (a user id for a WS ticket); it defaults to a placeholder for secrets that
   * carry nothing but their own existence (a sign-in nonce).
   */
  mint(value?: string): Promise<{ secret: string; expiresInSeconds: number }>
  /**
   * Atomically spend a presented secret, returning its stored value — or null when it was never
   * issued, has expired, or has already been spent.
   */
  redeem(secret: string): Promise<string | null>
}

export interface SingleUseSecretOptions {
  /** Cache key namespace, including its trailing separator (e.g. "wsticket:"). */
  prefix: string
  /** Lifetime of both the value and its claim, in seconds. */
  ttlSeconds: number
  /** Secret generator; defaults to a 256-bit base64url token. Injectable for deterministic tests. */
  newSecret?: () => string
}

/** Value stored for a secret that only has to exist (nothing to carry back to the redeemer). */
const PRESENT = "1"

export function makeSingleUseSecretStore(
  cache: CacheClient,
  opts: SingleUseSecretOptions,
): SingleUseSecretStore {
  const { prefix, ttlSeconds } = opts
  const newSecret = opts.newSecret ?? (() => generateToken())
  const claimPrefix = `${prefix}claim:`

  return {
    async mint(value: string = PRESENT): Promise<{ secret: string; expiresInSeconds: number }> {
      const secret = newSecret()
      await cache.set(prefix + (await sha256Hex(secret)), value, ttlSeconds)
      return { secret, expiresInSeconds: ttlSeconds }
    },

    async redeem(secret: string): Promise<string | null> {
      if (typeof secret !== "string" || secret.length === 0) return null
      const hash = await sha256Hex(secret)

      // Take the claim FIRST: whoever creates the claim key (result === 1) owns this redemption. The
      // claim carries the secret's own TTL so it expires with it and leaves nothing behind. A claim is
      // spent even for an unknown/expired secret, which is fine — it is keyed on that secret's hash, so
      // it can only ever throttle a replay of that same secret.
      const claim = await cache.incr(claimPrefix + hash, ttlSeconds)
      if (claim !== 1) return null

      const value = await cache.get(prefix + hash)
      if (value === null) return null
      await cache.del(prefix + hash)
      return value
    },
  }
}
