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
 *
 * Absolute lifetime: sliding expiry is bounded by ABSOLUTE_SESSION_MAX_SECONDS measured from the row's
 * created_at, so no amount of activity can keep a session (or a stolen token) alive indefinitely.
 */

import type { Role } from "@civfix/shared"
import { generateToken, sha256Hex } from "./crypto.js"
import type { CacheClient } from "./cache.js"
import type { SessionStore } from "./stores.js"

/** Default session lifetime: 30 days. */
export const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * Absolute session lifetime: 90 days from CREATION, regardless of activity (M3).
 *
 * Sliding expiry alone has no ceiling, so on a passwordless product one request every 15 days keeps a
 * token alive forever: a stolen session is a PERMANENT credential, and the only thing that ever ends it
 * is an explicit revoke by someone who has noticed. The cap makes every session mortal — after 90 days
 * it stops being extendable AND stops resolving, and the holder (attacker or owner) must re-authenticate
 * through a channel the real account owner controls. 90 days is chosen to be long enough that a normal
 * mobile user is never surprised by it, while bounding the blast radius of an undetected token theft.
 */
export const ABSOLUTE_SESSION_MAX_SECONDS = 90 * 24 * 60 * 60

/**
 * Extra seconds the banned marker outlives the session TTL, so it can veto any session that could still
 * be live (the marker must not expire before the longest-lived session it backstops).
 */
export const BANNED_MARKER_GRACE_SECONDS = 60

/** Redis key namespace for sessions. */
const SESSION_KEY_PREFIX = "sess:"

/**
 * Redis key namespace for the banned-account marker (H2 defense-in-depth). A flag set when a user is
 * banned, so even if a session-revoke was missed (a Redis/Pg hiccup during the ban) a still-warm session
 * does not resolve to an authenticated context. The marker is consulted by resolveSession via a single
 * cache read - never Postgres - and is checked BEFORE the sliding-expiry extension (V1), so a banned
 * account can neither resolve nor have its session slid; the "warm session is Redis-only" property is
 * preserved. TTL >= the session TTL so the marker outlives any session it must veto.
 */
const BANNED_KEY_PREFIX = "banned:"

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

/**
 * Shape stored in Redis. Kept minimal; timestamps are epoch ms for cheap comparison.
 *
 * `createdAtMs` is what makes the absolute cap (M3) enforceable on the cache-hit path, which never reads
 * the durable row. It is optional ONLY so that entries written by an older build (which had no such
 * field) are recognizable: those are treated as a cache MISS rather than as uncapped, so the ceiling is
 * enforced from the durable createdAt and the entry self-heals on its first use.
 */
interface CachedSession {
  userId: string
  roles: Role[]
  expiresAtMs: number
  createdAtMs?: number
}

export interface SessionServiceOptions {
  store: SessionStore
  cache: CacheClient
  /** Total session lifetime in seconds. Defaults to 30 days. */
  ttlSeconds?: number
  /** Absolute lifetime from creation, in seconds. Defaults to 90 days. */
  absoluteMaxSeconds?: number
  /** Injectable clock (epoch ms) for deterministic sliding-expiry tests. */
  now?: () => number
}

function sessionKey(hash: string): string {
  return SESSION_KEY_PREFIX + hash
}

function bannedKey(userId: string): string {
  return BANNED_KEY_PREFIX + userId
}

/**
 * The session service. Construct once per process (production: Pg store + Redis cache; tests:
 * in-memory store + in-memory cache) and share it across requests.
 */
export class SessionService {
  private readonly store: SessionStore
  private readonly cache: CacheClient
  private readonly ttlSeconds: number
  private readonly absoluteMaxSeconds: number
  private readonly now: () => number

  constructor(opts: SessionServiceOptions) {
    this.store = opts.store
    this.cache = opts.cache
    this.ttlSeconds = opts.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS
    this.absoluteMaxSeconds = opts.absoluteMaxSeconds ?? ABSOLUTE_SESSION_MAX_SECONDS
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
      { userId, roles: [...roles], expiresAtMs: expiresAt.getTime(), createdAtMs: nowMs },
      nowMs,
    )
    return token
  }

  /**
   * Resolve a presented token to an identity, or null. Redis-first: a HIT returns without any store
   * read. A MISS reads the durable store, re-warms Redis on a valid row, and returns. Expired rows
   * (in either layer) resolve to null. On success, sliding expiry may extend the session.
   *
   * Banned veto (V1): a banned account is vetoed BEFORE the session expiry is slid, so a still-warm
   * session whose durable revoke was missed can NOT be extended past the banned marker's lifetime (the
   * marker has a fixed TTL; sliding would otherwise let an orphaned session outlive it). The veto is a
   * single Redis read (isUserActive, never Postgres), so the warm-session Redis-only property is
   * preserved for active users (no store read is added on the hot path).
   */
  async resolveSession(token: string): Promise<ResolveResult | null> {
    const hash = await sha256Hex(token)
    const nowMs = this.now()

    // --- Cache-first path: on HIT we must NOT touch the store. ---
    const cachedRaw = await this.cache.get(sessionKey(hash))
    if (cachedRaw !== null) {
      const cached = this.parseCache(cachedRaw)
      // An entry without createdAtMs predates the absolute cap (M3) and cannot be checked against it, so
      // it is deliberately NOT trusted here: falling through to the durable row applies the ceiling and
      // rewrites the entry with its creation time.
      if (cached && cached.createdAtMs !== undefined && cached.expiresAtMs > nowMs) {
        if (this.absolutelyExpired(cached.createdAtMs, nowMs)) {
          await this.expireSession(hash)
          return null
        }
        // Veto a banned account BEFORE sliding (V1): never extend a session whose account is inactive.
        if (!(await this.isUserActive(cached.userId))) return null
        await this.maybeSlide(hash, cached.expiresAtMs, cached.createdAtMs, nowMs)
        return { userId: cached.userId, roles: cached.roles, source: "cache" }
      }
      // Corrupt or stale cache entry: drop it (best-effort — a del blip must not 500 a resolvable
      // request) and fall through to the durable store.
      await this.cache.del(sessionKey(hash)).catch(() => {})
    }

    // --- Miss path: durable store is the source of truth. ---
    const row = await this.store.findById(hash)
    if (!row) return null
    // Past its sliding expiry, or past the absolute ceiling measured from creation (M3): either way the
    // session is over. Clean up both layers so it cannot be re-warmed.
    if (
      row.expiresAt.getTime() <= nowMs ||
      this.absolutelyExpired(row.createdAt.getTime(), nowMs)
    ) {
      await this.expireSession(hash)
      return null
    }

    // Veto a banned account BEFORE re-warming/sliding (V1), same Redis-only read as the hit path.
    if (!(await this.isUserActive(row.userId))) return null

    // Re-warm Redis from the durable row, then apply sliding expiry. The TTL uses the SAME nowMs (P1-6).
    await this.writeCache(
      hash,
      {
        userId: row.userId,
        roles: row.roles,
        expiresAtMs: row.expiresAt.getTime(),
        createdAtMs: row.createdAt.getTime(),
      },
      nowMs,
    )
    await this.maybeSlide(hash, row.expiresAt.getTime(), row.createdAt.getTime(), nowMs)
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

  /**
   * Revoke ALL of a user's sessions at once (Phase 2: banning a user). Deletes every durable session row
   * for the user (the store returns the deleted ids, which ARE the token SHA-256 hashes) and drops each
   * matching write-through cache entry so a warm Redis hit cannot keep a banned user signed in. Returns
   * the number of sessions revoked. Idempotent: a user with no sessions revokes 0.
   */
  async revokeAllForUser(userId: string): Promise<number> {
    const ids = await this.store.deleteAllForUser(userId)
    // Drop every write-through entry, but best-effort: the durable rows are already gone (the source of
    // truth), so one cache.del reject must not abort the rest and leave other entries warm. The banned
    // marker (banUser) is the backstop for any that slip through.
    await Promise.allSettled(ids.map((hash) => this.cache.del(sessionKey(hash))))
    return ids.length
  }

  /**
   * Ban a user (H2): revoke ALL their sessions (durable rows + cache entries) AND set a banned marker so a
   * still-warm session that slipped through the revoke (a partial-failure window) is rejected by
   * isUserActive on the next request. The revoke runs FIRST so a revoke failure surfaces (the caller must
   * treat it as a failed ban and not 200); the marker is then set as the backstop. Returns the number of
   * sessions revoked.
   */
  async banUser(userId: string): Promise<number> {
    const revoked = await this.revokeAllForUser(userId)
    await this.cache.set(bannedKey(userId), "1", this.ttlSeconds + BANNED_MARKER_GRACE_SECONDS)
    return revoked
  }

  /** Clear a user's banned marker (H2): on un-ban (status set back to active/suspended/review). Idempotent. */
  async clearBan(userId: string): Promise<void> {
    await this.cache.del(bannedKey(userId))
  }

  /**
   * Whether the account is NOT banned (H2 defense-in-depth). A single cache read (never Postgres), so it
   * preserves the warm-session Redis-only property. Returns true (active) when no marker is present - the
   * common case - so an unbanned user is unaffected.
   */
  async isUserActive(userId: string): Promise<boolean> {
    const marked = await this.cache.get(bannedKey(userId))
    return marked === null
  }

  /** Total configured TTL in seconds (exposed for callers that set matching cookie max-age). */
  get ttl(): number {
    return this.ttlSeconds
  }

  /** Whether a session created at `createdAtMs` has passed its absolute ceiling (M3). */
  private absolutelyExpired(createdAtMs: number, nowMs: number): boolean {
    return nowMs >= createdAtMs + this.absoluteMaxSeconds * 1000
  }

  /**
   * End a session in both layers. The durable delete is the one that matters (it is the source of truth
   * a cache miss falls back to); the cache del is best-effort, since a del blip must not 500 a request
   * that is being denied anyway.
   */
  private async expireSession(hash: string): Promise<void> {
    await this.store.deleteById(hash)
    await this.cache.del(sessionKey(hash)).catch(() => {})
  }

  /**
   * Sliding expiry: extend only when less than half the window remains. When extended, push
   * expires_at forward by a full TTL, refresh the cache TTL, and bump last_seen_at in the same write.
   * Above the halfway mark, do nothing (no store or cache write).
   *
   * The extension is CLAMPED to the absolute ceiling (M3): a session may be renewed up to, but never
   * past, createdAt + absoluteMaxSeconds. Without the clamp the sliding window is self-perpetuating, so
   * a token that keeps being used never expires. Once the clamp would not move the expiry forward there
   * is nothing left to extend and the write is skipped; resolveSession refuses the session outright
   * once the ceiling itself is reached.
   */
  private async maybeSlide(
    hash: string,
    currentExpiryMs: number,
    createdAtMs: number,
    nowMs: number,
  ): Promise<void> {
    const remainingMs = currentExpiryMs - nowMs
    const halfWindowMs = (this.ttlSeconds * 1000) / 2
    if (remainingMs >= halfWindowMs) return

    const ceilingMs = createdAtMs + this.absoluteMaxSeconds * 1000
    const extendedMs = Math.min(nowMs + this.ttlSeconds * 1000, ceilingMs)
    if (extendedMs <= currentExpiryMs) return
    const newExpiresAt = new Date(extendedMs)
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
        return {
          userId: parsed.userId,
          roles: parsed.roles as Role[],
          expiresAtMs: parsed.expiresAtMs,
          ...(typeof parsed.createdAtMs === "number" ? { createdAtMs: parsed.createdAtMs } : {}),
        }
      }
      return null
    } catch {
      return null
    }
  }
}
