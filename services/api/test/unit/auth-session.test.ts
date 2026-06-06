import { describe, it, expect, vi } from "vitest"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { InMemorySessionStore } from "../../src/auth/stores.js"
import { SessionService, DEFAULT_SESSION_TTL_SECONDS } from "../../src/auth/session-service.js"
import { sha256Hex } from "../../src/auth/crypto.js"

const USER = "11111111-1111-1111-1111-111111111111"

/** Build a service over an in-memory store + cache with a controllable clock. */
function makeService(startMs = 1_700_000_000_000) {
  const clockRef = { value: startMs }
  const now = (): number => clockRef.value
  const store = new InMemorySessionStore()
  const cache = new InMemoryCacheClient(now)
  const service = new SessionService({ store, cache, now })
  return { service, store, cache, clockRef, advance: (ms: number) => (clockRef.value += ms) }
}

describe("SessionService", () => {
  it("createSession stores only the sha256 of the token and returns the raw token", async () => {
    const { service, store } = makeService()
    const token = await service.createSession(USER, ["citizen"])
    const hash = await sha256Hex(token)
    // The raw token is NOT a key in the store; its hash is.
    expect(await store.findById(token)).toBeNull()
    const row = await store.findById(hash)
    expect(row).not.toBeNull()
    expect(row?.userId).toBe(USER)
    expect(row?.roles).toEqual(["citizen"])
  })

  it("resolveSession HIT path reads ONLY the cache (never the store)", async () => {
    const { service, store } = makeService()
    const token = await service.createSession(USER, ["citizen"])

    // Spy AFTER creation so the insert's bookkeeping does not count.
    const findSpy = vi.spyOn(store, "findById")
    const resolved = await service.resolveSession(token)

    expect(resolved).not.toBeNull()
    expect(resolved?.userId).toBe(USER)
    expect(resolved?.source).toBe("cache")
    // The section-17 property: a warm session is served from Redis with NO Postgres read.
    expect(findSpy).not.toHaveBeenCalled()
  })

  it("resolveSession MISS path reads the store and re-warms the cache", async () => {
    const { service, store, cache } = makeService()
    const token = await service.createSession(USER, ["gov_user"])
    const hash = await sha256Hex(token)

    // Simulate a Redis eviction/flush: drop the cache entry only.
    await cache.del(`sess:${hash}`)
    expect(await cache.get(`sess:${hash}`)).toBeNull()

    const findSpy = vi.spyOn(store, "findById")
    const resolved = await service.resolveSession(token)
    expect(resolved?.source).toBe("store")
    expect(resolved?.userId).toBe(USER)
    expect(findSpy).toHaveBeenCalledTimes(1)

    // Cache is re-warmed, so a second resolve is a HIT with no further store read.
    findSpy.mockClear()
    const again = await service.resolveSession(token)
    expect(again?.source).toBe("cache")
    expect(findSpy).not.toHaveBeenCalled()
  })

  it("does NOT extend expiry when more than half the window remains", async () => {
    const { service, store, advance } = makeService()
    const token = await service.createSession(USER, ["citizen"])
    const hash = await sha256Hex(token)
    const before = (await store.findById(hash))!.expiresAt.getTime()

    const updateSpy = vi.spyOn(store, "updateExpiry")
    // Advance only 1 day (well under half of 30 days).
    advance(24 * 60 * 60 * 1000)
    await service.resolveSession(token)

    expect(updateSpy).not.toHaveBeenCalled()
    expect((await store.findById(hash))!.expiresAt.getTime()).toBe(before)
  })

  it("extends expiry (sliding) when less than half the window remains", async () => {
    const { service, store, advance } = makeService()
    const token = await service.createSession(USER, ["citizen"])
    const hash = await sha256Hex(token)
    const before = (await store.findById(hash))!.expiresAt.getTime()

    const updateSpy = vi.spyOn(store, "updateExpiry")
    // Advance past the halfway mark (16 days of a 30-day TTL).
    advance(16 * 24 * 60 * 60 * 1000)
    const resolved = await service.resolveSession(token)
    expect(resolved).not.toBeNull()

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const after = (await store.findById(hash))!.expiresAt.getTime()
    expect(after).toBeGreaterThan(before)
    // before = createdAt + 30d. After advancing 16d, now = createdAt + 16d, and the new expiry is
    // now + 30d = createdAt + 46d = before + 16d.
    const expected = before + 16 * 24 * 60 * 60 * 1000
    expect(Math.abs(after - expected)).toBeLessThan(2000)
    // Sanity: the extension is exactly a full TTL ahead of "now".
    expect(after).toBe(
      (await store.findById(hash))!.lastSeenAt.getTime() + DEFAULT_SESSION_TTL_SECONDS * 1000,
    )
  })

  it("returns null and cleans up for an expired session on the miss path", async () => {
    const { service, store, cache, advance } = makeService()
    const token = await service.createSession(USER, ["citizen"])
    const hash = await sha256Hex(token)

    // Drop the cache so resolution must consult the store, then advance past expiry.
    await cache.del(`sess:${hash}`)
    advance((DEFAULT_SESSION_TTL_SECONDS + 1) * 1000)

    const resolved = await service.resolveSession(token)
    expect(resolved).toBeNull()
    // Expired row is removed from the durable store too.
    expect(await store.findById(hash)).toBeNull()
  })

  it("revokeSession clears both the store row and the cache entry", async () => {
    const { service, store, cache } = makeService()
    const token = await service.createSession(USER, ["citizen"])
    const hash = await sha256Hex(token)

    expect(await store.findById(hash)).not.toBeNull()
    expect(await cache.get(`sess:${hash}`)).not.toBeNull()

    await service.revokeSession(token)

    expect(await store.findById(hash)).toBeNull()
    expect(await cache.get(`sess:${hash}`)).toBeNull()
    expect(await service.resolveSession(token)).toBeNull()
  })

  it("revokeAllForUser revokes every session for the user (store rows + cache) but not others (Phase 2 ban)", async () => {
    const { service, store, cache } = makeService()
    const OTHER = "22222222-2222-2222-2222-222222222222"
    // Two sessions for the banned user, one for an unrelated user.
    const t1 = await service.createSession(USER, ["citizen"])
    const t2 = await service.createSession(USER, ["citizen"])
    const tOther = await service.createSession(OTHER, ["citizen"])
    const h1 = await sha256Hex(t1)
    const h2 = await sha256Hex(t2)
    const hOther = await sha256Hex(tOther)

    const revoked = await service.revokeAllForUser(USER)
    expect(revoked).toBe(2)

    // Both of the banned user's sessions are gone from BOTH layers; a warm hit can no longer keep them in.
    expect(await store.findById(h1)).toBeNull()
    expect(await store.findById(h2)).toBeNull()
    expect(await cache.get(`sess:${h1}`)).toBeNull()
    expect(await cache.get(`sess:${h2}`)).toBeNull()
    expect(await service.resolveSession(t1)).toBeNull()
    expect(await service.resolveSession(t2)).toBeNull()

    // The unrelated user's session is untouched.
    expect(await store.findById(hOther)).not.toBeNull()
    expect(await service.resolveSession(tOther)).not.toBeNull()
  })

  it("revokeAllForUser is idempotent: a user with no sessions revokes 0", async () => {
    const { service } = makeService()
    expect(await service.revokeAllForUser("33333333-3333-3333-3333-333333333333")).toBe(0)
  })

  it("P1-6: the cache TTL is derived from the SAME clock read as the stored expiry (no undershoot)", async () => {
    // A STRIPED clock that advances on EVERY read. The bug was writeCache calling now() a SECOND time, so
    // its TTL was computed against a LATER instant than expiresAt -> the Redis key would expire before the
    // Postgres row. With the fix, writeCache uses the nowMs already captured, so the TTL is exactly the
    // full lifetime. We pin the cache's OWN clock to a fixed instant so we can recover the TTL the writer
    // set (entryExpiry - fixedCacheNow) and assert it equals the configured lifetime to the second.
    let striped = 1_700_000_000_000
    const STEP = 1000 // each now() read advances 1s, so a second read would visibly shrink a buggy TTL.
    const serviceNow = (): number => {
      const v = striped
      striped += STEP
      return v
    }
    const FIXED_CACHE_NOW = 1_700_000_000_000
    const store = new InMemorySessionStore()
    const cache = new InMemoryCacheClient(() => FIXED_CACHE_NOW)
    const ttlSeconds = 1000
    const service = new SessionService({ store, cache, ttlSeconds, now: serviceNow })

    const token = await service.createSession(USER, ["citizen"])
    const hash = await sha256Hex(token)

    const storedExpiry = (await store.findById(hash))!.expiresAt.getTime()
    const cacheExpiry = cache.expiryOf(`sess:${hash}`)
    expect(cacheExpiry).not.toBeNull()

    // The TTL the writer set, recovered against the cache's fixed clock.
    const ttlSet = Math.round((cacheExpiry! - FIXED_CACHE_NOW) / 1000)
    // With the fix it is the FULL lifetime (same nowMs as expiresAt). The bug would make it < ttlSeconds.
    expect(ttlSet).toBe(ttlSeconds)

    // And the cache key never expires before the durable row: its absolute expiry is >= the stored row's.
    expect(cacheExpiry!).toBeGreaterThanOrEqual(storedExpiry)
  })

  it("expired cache entry falls through to the store and is re-validated", async () => {
    // TTL short so the cache entry expires on its own while the store row would also be expired.
    const clockRef = { value: 1_700_000_000_000 }
    const now = (): number => clockRef.value
    const store = new InMemorySessionStore()
    const cache = new InMemoryCacheClient(now)
    const service = new SessionService({ store, cache, ttlSeconds: 100, now })

    const token = await service.createSession(USER, ["citizen"])
    const hash = await sha256Hex(token)

    // Advance beyond TTL: the cache entry is now expired (returns null) and so is the store row.
    clockRef.value += 101 * 1000
    expect(await cache.get(`sess:${hash}`)).toBeNull()
    expect(await service.resolveSession(token)).toBeNull()
  })
})

describe("SessionService banned-account control (H2)", () => {
  it("banUser revokes all sessions AND sets a marker; isUserActive then reports false", async () => {
    const { service, store } = makeService()
    await service.createSession(USER, ["operator"])
    expect(store.count()).toBe(1)
    expect(await service.isUserActive(USER)).toBe(true)

    const revoked = await service.banUser(USER)
    expect(revoked).toBe(1)
    // All sessions gone (durable) AND the account is marked banned (defense in depth).
    expect(store.count()).toBe(0)
    expect(await service.isUserActive(USER)).toBe(false)
  })

  it("isUserActive returns false for a banned user even if a session was NOT revoked (missed-revoke window)", async () => {
    // Simulate the partial-failure case: set the marker WITHOUT revoking (a session is still live).
    const { service, cache } = makeService()
    const token = await service.createSession(USER, ["operator"])
    // The session still resolves at the SessionService layer (it only checks the session itself)...
    expect((await service.resolveSession(token))?.userId).toBe(USER)
    // ...but the banned marker is the request-path veto: mark banned without touching sessions.
    await cache.set(`banned:${USER}`, "1", 60)
    expect(await service.isUserActive(USER)).toBe(false)
  })

  it("clearBan lifts the marker so the account is active again", async () => {
    const { service } = makeService()
    await service.banUser(USER)
    expect(await service.isUserActive(USER)).toBe(false)
    await service.clearBan(USER)
    expect(await service.isUserActive(USER)).toBe(true)
  })

  it("V1: a banned user cannot keep a session alive by repeatedly hitting the API (veto BEFORE slide)", async () => {
    // The missed-durable-revoke window: a live session whose durable row was NOT deleted (only the banned
    // marker is set). Without the V1 fix, resolveSession would SLIDE this session's expiry forward before
    // the banned veto ran, so a banned user hammering the API for ~30 days could push the orphaned session
    // past the (fixed-TTL) marker and re-authenticate. With the fix, resolveSession vetoes the banned
    // account BEFORE maybeSlide, so the session is never extended and every resolve returns null.
    const { service, store, cache, clockRef } = makeService()
    const token = await service.createSession(USER, ["operator"])
    const hash = await sha256Hex(token)
    const originalExpiry = (await store.findById(hash))!.expiresAt.getTime()

    // Set ONLY the banned marker (simulate a silently-failed durable revoke: the session row survives).
    await cache.set(`banned:${USER}`, "1", DEFAULT_SESSION_TTL_SECONDS + 60)

    // A maybeSlide must NEVER run for a banned account, regardless of how far the clock has advanced.
    const updateSpy = vi.spyOn(store, "updateExpiry")

    // Hammer the API across the slide threshold: jump past the halfway mark (>15 days) where an ACTIVE
    // session would slide, then keep resolving. Every call must be vetoed, and the expiry must not move.
    clockRef.value += 20 * 24 * 60 * 60 * 1000 // 20 days: well past the half-window slide trigger.
    for (let i = 0; i < 5; i++) {
      expect(await service.resolveSession(token)).toBeNull()
      clockRef.value += 24 * 60 * 60 * 1000 // advance another day each iteration.
    }

    // The veto won regardless of slide order: no extension was ever written, so the session expiry is
    // unchanged and the orphaned session cannot outlive the banned marker.
    expect(updateSpy).not.toHaveBeenCalled()
    expect((await store.findById(hash))!.expiresAt.getTime()).toBe(originalExpiry)

    // And the cache TTL was likewise never pushed forward (the marker would expire before a slid session).
    const cacheExpiry = cache.expiryOf(`sess:${hash}`)
    expect(cacheExpiry).not.toBeNull()
    expect(cacheExpiry!).toBeLessThanOrEqual(originalExpiry)
  })
})
