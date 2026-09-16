import { describe, it, expect, vi } from "vitest"
import { InMemoryCacheClient, type CacheClient } from "../../src/auth/cache.js"
import { InMemorySessionStore, type AccountStatus } from "../../src/auth/stores.js"
import {
  SessionService,
  DEFAULT_SESSION_TTL_SECONDS,
  ABSOLUTE_SESSION_MAX_SECONDS,
} from "../../src/auth/session-service.js"
import { sha256Hex } from "../../src/auth/crypto.js"
import { applyRoleChange } from "../../src/services/admin/role-change.js"
import type { Role } from "@civfix/shared"

const USER = "11111111-1111-1111-1111-111111111111"

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
    expect(await store.findById(token)).toBeNull()
    const row = await store.findById(hash)
    expect(row).not.toBeNull()
    expect(row?.userId).toBe(USER)
    expect(row?.roles).toEqual(["citizen"])
  })

  it("resolveSession HIT path reads ONLY the cache (never the store)", async () => {
    const { service, store } = makeService()
    const token = await service.createSession(USER, ["citizen"])

    const findSpy = vi.spyOn(store, "findById")
    const resolved = await service.resolveSession(token)

    expect(resolved).not.toBeNull()
    expect(resolved?.userId).toBe(USER)
    expect(resolved?.source).toBe("cache")
    expect(findSpy).not.toHaveBeenCalled()
  })

  it("resolveSession MISS path reads the store and re-warms the cache", async () => {
    const { service, store, cache } = makeService()
    const token = await service.createSession(USER, ["gov_user"])
    const hash = await sha256Hex(token)

    await cache.del(`sess:${hash}`)
    expect(await cache.get(`sess:${hash}`)).toBeNull()

    const findSpy = vi.spyOn(store, "findById")
    const resolved = await service.resolveSession(token)
    expect(resolved?.source).toBe("store")
    expect(resolved?.userId).toBe(USER)
    expect(findSpy).toHaveBeenCalledTimes(1)

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
    advance(16 * 24 * 60 * 60 * 1000)
    const resolved = await service.resolveSession(token)
    expect(resolved).not.toBeNull()

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const after = (await store.findById(hash))!.expiresAt.getTime()
    expect(after).toBeGreaterThan(before)
    const expected = before + 16 * 24 * 60 * 60 * 1000
    expect(Math.abs(after - expected)).toBeLessThan(2000)
    expect(after).toBe(
      (await store.findById(hash))!.lastSeenAt.getTime() + DEFAULT_SESSION_TTL_SECONDS * 1000,
    )
  })

  it("returns null and cleans up for an expired session on the miss path", async () => {
    const { service, store, cache, advance } = makeService()
    const token = await service.createSession(USER, ["citizen"])
    const hash = await sha256Hex(token)

    await cache.del(`sess:${hash}`)
    advance((DEFAULT_SESSION_TTL_SECONDS + 1) * 1000)

    const resolved = await service.resolveSession(token)
    expect(resolved).toBeNull()
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
    const t1 = await service.createSession(USER, ["citizen"])
    const t2 = await service.createSession(USER, ["citizen"])
    const tOther = await service.createSession(OTHER, ["citizen"])
    const h1 = await sha256Hex(t1)
    const h2 = await sha256Hex(t2)
    const hOther = await sha256Hex(tOther)

    const revoked = await service.revokeAllForUser(USER)
    expect(revoked).toBe(2)

    expect(await store.findById(h1)).toBeNull()
    expect(await store.findById(h2)).toBeNull()
    expect(await cache.get(`sess:${h1}`)).toBeNull()
    expect(await cache.get(`sess:${h2}`)).toBeNull()
    expect(await service.resolveSession(t1)).toBeNull()
    expect(await service.resolveSession(t2)).toBeNull()

    expect(await store.findById(hOther)).not.toBeNull()
    expect(await service.resolveSession(tOther)).not.toBeNull()
  })

  it("revokeAllForUser is idempotent: a user with no sessions revokes 0", async () => {
    const { service } = makeService()
    expect(await service.revokeAllForUser("33333333-3333-3333-3333-333333333333")).toBe(0)
  })

  it("P1-6: the cache TTL is derived from the SAME clock read as the stored expiry (no undershoot)", async () => {
    let striped = 1_700_000_000_000
    const STEP = 1000
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

    const ttlSet = Math.round((cacheExpiry! - FIXED_CACHE_NOW) / 1000)
    expect(ttlSet).toBe(ttlSeconds)

    expect(cacheExpiry!).toBeGreaterThanOrEqual(storedExpiry)
  })

  it("expired cache entry falls through to the store and is re-validated", async () => {
    const clockRef = { value: 1_700_000_000_000 }
    const now = (): number => clockRef.value
    const store = new InMemorySessionStore()
    const cache = new InMemoryCacheClient(now)
    const service = new SessionService({ store, cache, ttlSeconds: 100, now })

    const token = await service.createSession(USER, ["citizen"])
    const hash = await sha256Hex(token)

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
    expect(store.count()).toBe(0)
    expect(await service.isUserActive(USER)).toBe(false)
  })

  it("isUserActive returns false for a banned user even if a session was NOT revoked (missed-revoke window)", async () => {
    const { service, cache } = makeService()
    const token = await service.createSession(USER, ["operator"])
    expect((await service.resolveSession(token))?.userId).toBe(USER)
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
    const { service, store, cache, clockRef } = makeService()
    const token = await service.createSession(USER, ["operator"])
    const hash = await sha256Hex(token)
    const originalExpiry = (await store.findById(hash))!.expiresAt.getTime()

    await cache.set(`banned:${USER}`, "1", DEFAULT_SESSION_TTL_SECONDS + 60)

    const updateSpy = vi.spyOn(store, "updateExpiry")

    clockRef.value += 20 * 24 * 60 * 60 * 1000
    for (let i = 0; i < 5; i++) {
      expect(await service.resolveSession(token)).toBeNull()
      clockRef.value += 24 * 60 * 60 * 1000
    }

    expect(updateSpy).not.toHaveBeenCalled()
    expect((await store.findById(hash))!.expiresAt.getTime()).toBe(originalExpiry)

    const cacheExpiry = cache.expiryOf(`sess:${hash}`)
    expect(cacheExpiry).not.toBeNull()
    expect(cacheExpiry!).toBeLessThanOrEqual(originalExpiry)
  })
})

describe("SessionService absolute lifetime (M3)", () => {
  const DAY = 24 * 60 * 60 * 1000

  async function keepAlive(
    svc: ReturnType<typeof makeService>,
    stepDays: number,
    maxDays: number,
  ): Promise<{ token: string; aliveDays: number }> {
    const token = await svc.service.createSession(USER, ["citizen"])
    let day = 0
    for (; day < maxDays; day += stepDays) {
      svc.advance(stepDays * DAY)
      if ((await svc.service.resolveSession(token)) === null) break
    }
    return { token, aliveDays: day }
  }

  it("a token used every 10 days STOPS working at the 90-day ceiling (it used to live forever)", async () => {
    const svc = makeService()
    const { aliveDays } = await keepAlive(svc, 10, 400)
    expect(aliveDays).toBeGreaterThanOrEqual(80)
    expect(aliveDays).toBeLessThanOrEqual(100)
  })

  it("refuses to extend past createdAt + ABSOLUTE_MAX, and the row is deleted once past it", async () => {
    const svc = makeService()
    const { service, store, cache, advance } = svc
    const token = await service.createSession(USER, ["citizen"])
    const hash = await sha256Hex(token)
    const createdAt = (await store.findById(hash))!.createdAt.getTime()

    for (let day = 0; day < 80; day += 10) {
      advance(10 * DAY)
      expect(await service.resolveSession(token)).not.toBeNull()
    }
    expect((await store.findById(hash))!.expiresAt.getTime()).toBe(
      createdAt + ABSOLUTE_SESSION_MAX_SECONDS * 1000,
    )

    advance(11 * DAY)
    expect(await service.resolveSession(token)).toBeNull()
    expect(await store.findById(hash)).toBeNull()
    expect(await cache.get(`sess:${hash}`)).toBeNull()
  })

  it("enforces the ceiling on the CACHE-HIT path too (no store read needed to deny)", async () => {
    const { service, store, cache, clockRef } = makeService()
    const token = await service.createSession(USER, ["citizen"])
    const hash = await sha256Hex(token)
    await cache.set(
      `sess:${hash}`,
      JSON.stringify({
        userId: USER,
        roles: ["citizen"],
        expiresAtMs: clockRef.value + 10 * DAY,
        createdAtMs: clockRef.value - (ABSOLUTE_SESSION_MAX_SECONDS * 1000 + 1000),
        epoch: 0,
        accountStatus: "active",
      }),
      DEFAULT_SESSION_TTL_SECONDS,
    )
    const findSpy = vi.spyOn(store, "findById")
    expect(await service.resolveSession(token)).toBeNull()
    expect(findSpy).toHaveBeenCalledTimes(0)
  })

  it("a cache entry written by an older build (no createdAtMs) is re-validated against the store", async () => {
    const { service, store, cache } = makeService()
    const token = await service.createSession(USER, ["citizen"])
    const hash = await sha256Hex(token)
    const row = (await store.findById(hash))!
    await cache.set(
      `sess:${hash}`,
      JSON.stringify({ userId: USER, roles: ["citizen"], expiresAtMs: row.expiresAt.getTime() }),
      DEFAULT_SESSION_TTL_SECONDS,
    )
    const resolved = await service.resolveSession(token)
    expect(resolved?.source).toBe("store")
    const raw = await cache.get(`sess:${hash}`)
    expect(JSON.parse(raw!).createdAtMs).toBe(row.createdAt.getTime())
  })
})

class FlakyDelCache implements CacheClient {
  failDel = false
  sadd(key: string, ...members: string[]): Promise<number> {
    return this.inner.sadd(key, ...members)
  }
  srem(key: string, ...members: string[]): Promise<number> {
    return this.inner.srem(key, ...members)
  }
  smembers(key: string): Promise<string[]> {
    return this.inner.smembers(key)
  }
  scard(key: string): Promise<number> {
    return this.inner.scard(key)
  }
  expire(key: string, ttlSeconds: number): Promise<void> {
    return this.inner.expire(key, ttlSeconds)
  }
  errors: unknown[] = []
  constructor(private readonly inner: InMemoryCacheClient) {}
  get(key: string): Promise<string | null> {
    return this.inner.get(key)
  }
  set(key: string, value: string, ttlSeconds: number): Promise<void> {
    return this.inner.set(key, value, ttlSeconds)
  }
  incr(key: string, ttlSeconds: number): Promise<number> {
    return this.inner.incr(key, ttlSeconds)
  }
  del(key: string): Promise<void> {
    if (this.failDel) return Promise.reject(new Error("redis del down"))
    return this.inner.del(key)
  }
}

function makeFlakyService(startMs = 1_700_000_000_000) {
  const clockRef = { value: startMs }
  const now = (): number => clockRef.value
  const store = new InMemorySessionStore()
  const cache = new FlakyDelCache(new InMemoryCacheClient(now))
  const logger = { error: (obj: unknown) => cache.errors.push(obj) }
  const service = new SessionService({ store, cache, now, logger })
  return { service, store, cache, logger }
}

describe("SessionService revoke robustness", () => {
  it("resolveSession surfaces expiresAtMs on both paths (F035)", async () => {
    const { service, store } = makeService()
    const token = await service.createSession(USER, ["citizen"])
    const hash = await sha256Hex(token)
    const hit = await service.resolveSession(token)
    expect(hit?.expiresAtMs).toBe((await store.findById(hash))!.expiresAt.getTime())
  })

  it("revokeSession evicts the cache BEFORE the durable row (F033)", async () => {
    const { service, store, cache } = makeFlakyService()
    const token = await service.createSession(USER, ["citizen"])
    const hash = await sha256Hex(token)
    cache.failDel = true
    await expect(service.revokeSession(token)).rejects.toThrow()
    expect(await store.findById(hash)).not.toBeNull()
  })

  it("H3: revokeAllForUser survives a failed cache eviction — the stranded entry no longer authenticates", async () => {
    const { service, store, cache } = makeFlakyService()
    const token = await service.createSession(USER, ["gov_admin"])
    const hash = await sha256Hex(token)
    cache.failDel = true

    expect(await service.revokeAllForUser(USER)).toBe(1)
    expect(cache.errors.length).toBeGreaterThan(0)
    expect(await cache.get(`sess:${hash}`)).not.toBeNull()
    expect(await store.findById(hash)).toBeNull()

    expect(await service.resolveSession(token)).toBeNull()
  })

  it("H3: a retry of revokeAllForUser is a safe no-op (the hashes are gone, the epoch already moved)", async () => {
    const { service, cache } = makeFlakyService()
    const token = await service.createSession(USER, ["gov_admin"])
    cache.failDel = true
    await service.revokeAllForUser(USER)
    cache.failDel = false
    expect(await service.revokeAllForUser(USER)).toBe(0)
    expect(await service.resolveSession(token)).toBeNull()
  })

  it("H3: a fresh login after a revoke works and is cached under the NEW epoch", async () => {
    const { service } = makeFlakyService()
    await service.createSession(USER, ["citizen"])
    await service.revokeAllForUser(USER)
    const next = await service.createSession(USER, ["citizen"])
    const resolved = await service.resolveSession(next)
    expect(resolved?.userId).toBe(USER)
    expect(resolved?.source).toBe("cache")
  })

  it("H3: applyRoleChange leaves no session serving the OLD role, even when eviction fails", async () => {
    const { service, cache } = makeFlakyService()
    const token = await service.createSession(USER, ["gov_admin"])
    cache.failDel = true
    let written: Role[] | null = null
    await applyRoleChange(
      {
        write: (_userId, role) => {
          written = [role]
          return Promise.resolve()
        },
        revokeAll: (userId) => service.revokeAllForUser(userId),
      },
      USER,
      "citizen",
    )
    expect(written).toEqual(["citizen"])
    expect(await service.resolveSession(token)).toBeNull()
  })

  it("H3: banUser sets the marker BEFORE deleting rows, so a later failure still locks the account", async () => {
    const { service, cache } = makeFlakyService()
    const token = await service.createSession(USER, ["citizen"])
    cache.failDel = true
    await service.banUser(USER)
    expect(await service.isUserActive(USER)).toBe(false)
    expect(await service.resolveSession(token)).toBeNull()
  })

  it("H4: applyAccountStatus('suspended') revokes every session and lifts a stale ban marker", async () => {
    const { service } = makeService()
    const token = await service.createSession(USER, ["citizen"])
    await service.banUser(USER)
    expect(await service.isUserActive(USER)).toBe(false)

    expect(await service.applyAccountStatus(USER, "suspended")).toBe(0)
    expect(await service.isUserActive(USER)).toBe(true)
    expect(await service.resolveSession(token)).toBeNull()
  })

  it("H4: applyAccountStatus('review') keeps the session alive but re-reads the store", async () => {
    const { service, store } = makeService()
    const token = await service.createSession(USER, ["citizen"])
    store.setAccountStatus(USER, "review")
    await service.applyAccountStatus(USER, "review")
    const resolved = await service.resolveSession(token)
    expect(resolved?.userId).toBe(USER)
    expect(resolved?.source).toBe("store")
    expect(resolved?.accountStatus).toBe("review")
  })

  it("H4: a session projection carries the account status from the users join", async () => {
    const { service, store } = makeService()
    const token = await service.createSession(USER, ["citizen"], { accountStatus: "active" })
    expect((await service.resolveSession(token))?.accountStatus).toBe("active")
    store.setAccountStatus(USER, "suspended")
    await service.bumpEpoch(USER)
    expect((await service.resolveSession(token))?.accountStatus).toBe("suspended")
  })

  it("banUser still sets the marker even when cache eviction fails (F032)", async () => {
    const { service, cache } = makeFlakyService()
    await service.createSession(USER, ["citizen"])
    cache.failDel = true
    await service.banUser(USER)
    expect(await service.isUserActive(USER)).toBe(false)
  })
})

class StubUserLookup {
  private readonly statuses = new Map<string, AccountStatus>()
  private readonly roles = new Map<string, Role>()

  setStatus(id: string, status: AccountStatus): void {
    this.statuses.set(id, status)
  }

  setRole(id: string, role: Role): void {
    this.roles.set(id, role)
  }

  accountStatus(id: string): Promise<AccountStatus> {
    return Promise.resolve(this.statuses.get(id) ?? "active")
  }

  findById(id: string): Promise<{ role: Role } | null> {
    return Promise.resolve({ role: this.roles.get(id) ?? "citizen" })
  }
}

function makeGuardedService(startMs = 1_700_000_000_000) {
  const clockRef = { value: startMs }
  const now = (): number => clockRef.value
  const store = new InMemorySessionStore()
  const cache = new InMemoryCacheClient(now)
  const users = new StubUserLookup()
  const service = new SessionService({ store, cache, users, now })
  return { service, store, cache, users, advance: (ms: number) => (clockRef.value += ms) }
}

describe("B2: Postgres is authoritative for a banned account, not the Redis marker", () => {
  it("a banned ROW with NO ban marker resolves to null, deletes the row, and re-sets the marker", async () => {
    const { service, store, cache } = makeService()
    const token = await service.createSession(USER, ["citizen"])
    const hash = await sha256Hex(token)

    store.setAccountStatus(USER, "banned")
    await cache.del(`sess:${hash}`)
    expect(await cache.get(`banned:${USER}`)).toBeNull()

    expect(await service.resolveSession(token)).toBeNull()
    expect(await store.findById(hash)).toBeNull()
    expect(await cache.get(`banned:${USER}`)).not.toBeNull()
    expect(await service.isUserActive(USER)).toBe(false)
  })

  it("a banned CACHED projection never authenticates either", async () => {
    const { service, store, cache } = makeService()
    const token = await service.createSession(USER, ["citizen"])
    const hash = await sha256Hex(token)
    store.setAccountStatus(USER, "banned")

    const raw = JSON.parse((await cache.get(`sess:${hash}`))!) as Record<string, unknown>
    raw.accountStatus = "banned"
    await cache.set(`sess:${hash}`, JSON.stringify(raw), 1000)

    expect(await service.resolveSession(token)).toBeNull()
  })

  it("a SUSPENDED row with no marker still resolves, carrying the read-only status", async () => {
    const { service, store, cache } = makeService()
    const token = await service.createSession(USER, ["citizen"])
    const hash = await sha256Hex(token)

    store.setAccountStatus(USER, "suspended")
    await cache.del(`sess:${hash}`)

    const resolved = await service.resolveSession(token)
    expect(resolved?.userId).toBe(USER)
    expect(resolved?.accountStatus).toBe("suspended")
    expect(await store.findById(hash)).not.toBeNull()
  })

  it("createSession refuses to mint for a user the DB reports banned or suspended (ban/login race)", async () => {
    const { service, users, store } = makeGuardedService()
    users.setStatus(USER, "banned")
    await expect(service.createSession(USER, ["citizen"])).rejects.toMatchObject({
      httpStatus: 403,
    })
    users.setStatus(USER, "suspended")
    await expect(service.createSession(USER, ["citizen"])).rejects.toMatchObject({
      httpStatus: 403,
    })
    expect(store.count()).toBe(0)

    users.setStatus(USER, "active")
    expect(typeof (await service.createSession(USER, ["citizen"]))).toBe("string")
  })
})

describe("B1: an operator account can never be suspended or banned", () => {
  it("applyAccountStatus refuses suspended and banned for an operator, whoever calls it", async () => {
    const { service, users } = makeGuardedService()
    users.setRole(USER, "operator")
    const token = await service.createSession(USER, ["operator"])

    await expect(service.applyAccountStatus(USER, "suspended")).rejects.toMatchObject({
      httpStatus: 403,
    })
    await expect(service.applyAccountStatus(USER, "banned")).rejects.toMatchObject({
      httpStatus: 403,
    })
    expect((await service.resolveSession(token))?.userId).toBe(USER)
    expect(await service.isUserActive(USER)).toBe(true)
  })

  it("still allows active and review for an operator, and both statuses for everyone else", async () => {
    const { service, users } = makeGuardedService()
    users.setRole(USER, "operator")
    await expect(service.applyAccountStatus(USER, "active")).resolves.toBe(0)
    await expect(service.applyAccountStatus(USER, "review")).resolves.toBe(0)

    const citizen = "22222222-2222-2222-2222-222222222222"
    await service.createSession(citizen, ["citizen"])
    await expect(service.applyAccountStatus(citizen, "suspended")).resolves.toBe(1)
  })
})

describe("cache entries written by an older build are treated as a miss", () => {
  it("an entry with no epoch / no accountStatus is discarded and re-read from the store", async () => {
    const { service, store, cache } = makeService()
    const token = await service.createSession(USER, ["citizen"])
    const hash = await sha256Hex(token)
    const row = (await store.findById(hash))!

    await cache.set(
      `sess:${hash}`,
      JSON.stringify({
        userId: USER,
        roles: ["citizen"],
        expiresAtMs: row.expiresAt.getTime(),
        createdAtMs: row.createdAt.getTime(),
      }),
      1000,
    )

    const resolved = await service.resolveSession(token)
    expect(resolved?.source).toBe("store")
    const rewritten = JSON.parse((await cache.get(`sess:${hash}`))!) as Record<string, unknown>
    expect(rewritten.epoch).toBe(0)
    expect(rewritten.accountStatus).toBe("active")
  })

  it("a pre-deploy entry for a user suspended since the deploy does NOT keep write access", async () => {
    const { service, store, cache } = makeService()
    const token = await service.createSession(USER, ["citizen"])
    const hash = await sha256Hex(token)
    const row = (await store.findById(hash))!
    store.setAccountStatus(USER, "suspended")

    await cache.set(
      `sess:${hash}`,
      JSON.stringify({
        userId: USER,
        roles: ["citizen"],
        expiresAtMs: row.expiresAt.getTime(),
        createdAtMs: row.createdAt.getTime(),
      }),
      1000,
    )

    expect((await service.resolveSession(token))?.accountStatus).toBe("suspended")
  })
})

describe("sliding expiry is coarse-grained, so a hot session does not UPDATE on every request", () => {
  function slidingService(granularityMs: number) {
    const clockRef = { value: 1_700_000_000_000 }
    const now = (): number => clockRef.value
    const store = new InMemorySessionStore()
    const cache = new InMemoryCacheClient(now)
    const service = new SessionService({
      store,
      cache,
      now,
      ttlSeconds: 100,
      slideGranularityMs: granularityMs,
    })
    return { service, store, clockRef, advance: (ms: number) => (clockRef.value += ms) }
  }

  it("two resolves inside the granularity window produce ONE updateExpiry", async () => {
    const { service, store, advance } = slidingService(60_000)
    const token = await service.createSession(USER, ["citizen"])
    const spy = vi.spyOn(store, "updateExpiry")

    advance(60_000)
    await service.resolveSession(token)
    expect(spy).toHaveBeenCalledTimes(1)

    advance(55_000)
    await service.resolveSession(token)
    expect(spy).toHaveBeenCalledTimes(1)

    advance(10_000)
    await service.resolveSession(token)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it("the session still slides — it never expires under continuous use", async () => {
    const { service, store, advance } = slidingService(60_000)
    const token = await service.createSession(USER, ["citizen"])
    const hash = await sha256Hex(token)
    const originalExpiry = (await store.findById(hash))!.expiresAt.getTime()

    for (let i = 0; i < 6; i += 1) {
      advance(65_000)
      expect(await service.resolveSession(token)).not.toBeNull()
    }
    expect((await store.findById(hash))!.expiresAt.getTime()).toBeGreaterThan(originalExpiry)
  })
})
