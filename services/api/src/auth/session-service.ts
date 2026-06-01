/**
 * Session core: Postgres-durable, Redis write-through (plan section 8 + the section-17 Redis probe).
 *
 * Token model:
 *   - createSession mints a 256-bit opaque token and persists ONLY its SHA-256 hex as sessions.id.
 *     The durable row in Postgres is the source of truth; a JSON projection {userId, roles,
 *     expiresAt} is written through to Redis under `sess:<hash>` with a matching TTL.
 *   - resolveSession hashes the presented token and tries Redis FIRST. On a cache HIT it returns the
 *     identity WITHOUT touching Postgres (this is the property the integration test asserts: an
 *     authenticated request is served entirely from Redis). On a MISS (eviction / flush / cold node)
 *     it falls back to Postgres, re-warms Redis, and returns; an expired/absent row yields null.
 *
 * Sliding expiry (lazy): on a successful resolve, if less than HALF the TTL window remains, the row's
 * expires_at is pushed forward by a full TTL and Redis is refreshed; otherwise NO write happens. This
 * keeps active sessions alive without a write on every request. last_seen_at is updated only as part
 * of that same extension write (throttled to the sliding-expiry cadence) so reads stay cheap.
 */

import type { Role } from "@civfix/shared"
import { generateToken, sha256Hex } from "./crypto.js"
import type { CacheClient } from "./cache.js"
import type { SessionStore } from "./stores.js"

/** Default session lifetime: 30 days. */
export const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

/** Redis key namespace for sessions. */
const SESSION_KEY_PREFIX = "sess:"

/** The resolved identity carried by a live session. */
export interface ResolvedSession {
  userId: string
  roles: Role[]
}

/** Where a resolved session was served from (used by tests + diagnostics, not the wire). */
export type SessionSource = "cache" | "store"

export interface ResolveResult extends ResolvedSession {
  source: SessionSource
}

/** Request metadata captured on the session row. */
export interface SessionMeta {
  userAgent?: string | null
  ip?: string | null
}

/** Shape stored in Redis. Kept minimal; expiresAt is epoch ms for cheap comparison. */
interface CachedSession {
  userId: string
  roles: Role[]
  expiresAtMs: number
}

export interface SessionServiceOptions {
  store: SessionStore
  cache: CacheClient
  /** Total session lifetime in seconds. Defaults to 30 days. */
  ttlSeconds?: number
  /** Injectable clock (epoch ms) for deterministic sliding-expiry tests. */
  now?: () => number
}

function sessionKey(hash: string): string {
  return SESSION_KEY_PREFIX + hash
}

/**
 * The session service. Construct once per process (production: Pg store + Redis cache; tests:
 * in-memory store + in-memory cache) and share it across requests.
 */
export class SessionService {
  private readonly store: SessionStore
  private readonly cache: CacheClient
  private readonly ttlSeconds: number
  private readonly now: () => number

  constructor(opts: SessionServiceOptions) {
    this.store = opts.store
    this.cache = opts.cache
    this.ttlSeconds = opts.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS
    this.now = opts.now ?? Date.now
  }

  /**
   * Create a durable session for `userId`/`roles` and return the RAW token (never persisted). The
   * caller decides transport (bearer body vs cookie). Postgres is written first (durability), then
   * Redis is warmed; a Redis warm failure must not lose the session, so the cache write is the last
   * step and a thrown error from it surfaces to the caller intentionally only after the row exists.
   */
  async createSession(userId: string, roles: Role[], meta: SessionMeta = {}): Promise<string> {
    const token = generateToken()
    const hash = await sha256Hex(token)
    const nowMs = this.now()
    const expiresAt = new Date(nowMs + this.ttlSeconds * 1000)
    const lastSeen = new Date(nowMs)

    await this.store.insert({
      id: hash,
      userId,
      roles: [...roles],
      expiresAt,
      lastSeenAt: lastSeen,
      userAgent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
    })

    // Derive the cache TTL from the SAME nowMs used for expiresAt (P1-6), not a second clock read.
    await this.writeCache(
      hash,
      { userId, roles: [...roles], expiresAtMs: expiresAt.getTime() },
      nowMs,
    )
    return token
  }

  /**
   * Resolve a presented token to an identity, or null. Redis-first: a HIT returns without any store
   * read. A MISS reads the durable store, re-warms Redis on a valid row, and returns. Expired rows
   * (in either layer) resolve to null. On success, sliding expiry may extend the session.
   */
  async resolveSession(token: string): Promise<ResolveResult | null> {
    const hash = await sha256Hex(token)
    const nowMs = this.now()

    // --- Cache-first path: on HIT we must NOT touch the store. ---
    const cachedRaw = await this.cache.get(sessionKey(hash))
    if (cachedRaw !== null) {
      const cached = this.parseCache(cachedRaw)
      if (cached && cached.expiresAtMs > nowMs) {
        await this.maybeSlide(hash, cached.expiresAtMs, nowMs)
        return { userId: cached.userId, roles: cached.roles, source: "cache" }
      }
      // Corrupt or stale cache entry: drop it and fall through to the durable store.
      await this.cache.del(sessionKey(hash))
    }

    // --- Miss path: durable store is the source of truth. ---
    const row = await this.store.findById(hash)
    if (!row) return null
    if (row.expiresAt.getTime() <= nowMs) {
      // Expired: clean up both layers so it cannot be re-warmed.
      await this.store.deleteById(hash)
      await this.cache.del(sessionKey(hash))
      return null
    }

    // Re-warm Redis from the durable row, then apply sliding expiry. The TTL uses the SAME nowMs (P1-6).
    await this.writeCache(
      hash,
      {
        userId: row.userId,
        roles: row.roles,
        expiresAtMs: row.expiresAt.getTime(),
      },
      nowMs,
    )
    await this.maybeSlide(hash, row.expiresAt.getTime(), nowMs)
    return { userId: row.userId, roles: row.roles, source: "store" }
  }

  /**
   * Revoke a session: delete the durable row and the cache entry. Idempotent. Accepts the raw token
   * (the common case from a logout handler).
   */
  async revokeSession(token: string): Promise<void> {
    const hash = await sha256Hex(token)
    await this.store.deleteById(hash)
    await this.cache.del(sessionKey(hash))
  }

  /** Total configured TTL in seconds (exposed for callers that set matching cookie max-age). */
  get ttl(): number {
    return this.ttlSeconds
  }

  /**
   * Sliding expiry: extend only when less than half the window remains. When extended, push
   * expires_at forward by a full TTL, refresh the cache TTL, and bump last_seen_at in the same write.
   * Above the halfway mark, do nothing (no store or cache write).
   */
  private async maybeSlide(hash: string, currentExpiryMs: number, nowMs: number): Promise<void> {
    const remainingMs = currentExpiryMs - nowMs
    const halfWindowMs = (this.ttlSeconds * 1000) / 2
    if (remainingMs >= halfWindowMs) return

    const newExpiresAt = new Date(nowMs + this.ttlSeconds * 1000)
    await this.store.updateExpiry(hash, newExpiresAt, new Date(nowMs))

    // Refresh the cache value + TTL to match the new expiry. We need the identity to rewrite the
    // value; read it back from cache (cheap) and only rewrite when present. The TTL uses the SAME nowMs
    // captured by resolveSession (P1-6), so it cannot undershoot the just-written expiry.
    const raw = await this.cache.get(sessionKey(hash))
    const cached = raw ? this.parseCache(raw) : null
    if (cached) {
      await this.writeCache(hash, { ...cached, expiresAtMs: newExpiresAt.getTime() }, nowMs)
    }
  }

  /**
   * Write the session projection to Redis with a TTL clamped to the remaining lifetime. `nowMs` is the
   * SAME clock reading the caller used to compute `value.expiresAtMs`, so the TTL and the stored expiry
   * agree exactly (P1-6): without this the method read the clock a SECOND time, and with an advancing
   * clock (a GC pause in prod, or a striped clock in tests) the TTL could undershoot the expiry, evicting
   * the Redis key slightly before the Postgres row and forcing an unnecessary cache miss + re-warm.
   */
  private async writeCache(hash: string, value: CachedSession, nowMs: number): Promise<void> {
    const ttl = Math.max(1, Math.ceil((value.expiresAtMs - nowMs) / 1000))
    await this.cache.set(sessionKey(hash), JSON.stringify(value), ttl)
  }

  private parseCache(raw: string): CachedSession | null {
    try {
      const parsed = JSON.parse(raw) as Partial<CachedSession>
      if (
        typeof parsed.userId === "string" &&
        Array.isArray(parsed.roles) &&
        typeof parsed.expiresAtMs === "number"
      ) {
        return { userId: parsed.userId, roles: parsed.roles as Role[], expiresAtMs: parsed.expiresAtMs }
      }
      return null
    } catch {
      return null
    }
  }
}
