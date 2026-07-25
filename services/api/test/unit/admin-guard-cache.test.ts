/**
 * src/auth/admin-guard.ts — the CACHE semantics of the H2 operator-allowlist check (auth finding #17 / D33).
 *
 * admin-auth-guard.test.ts already covers accept/reject/ordering. What nothing exercised is the Redis layer
 * that makes the check affordable, and every property of it is security- or availability-relevant:
 *
 *   - BOTH verdicts are cached. A negative verdict must be cached too, or a stranger's request storm turns
 *     into a Postgres read storm (the reason the check is allowed to touch the user table at all).
 *   - The TTL is the OFF-BOARDING WINDOW the file header promises. Within it a revoked operator keeps
 *     access; the moment it lapses the verdict is re-derived. Without a test, a cache with no expiry (or a
 *     wrong TTL unit) would make "dropping an address revokes access on the next request" silently false.
 *   - A cache failure must FAIL CLOSED (propagate, 500) and never degrade into a pass — the exact way a
 *     Redis outage could otherwise disable the whole allowlist control.
 *
 * Everything is asserted through real HTTP (`app.inject`) against a real admin data route. `GET
 * /v1/admin/moderation` is used because `moderationOverrides` makes it answer 200 with no database, so
 * "passed the guard" (200) is distinguishable from "denied" (403) and from "cache error" (500) — an
 * always-500 route could not tell those apart.
 *
 * Off-boarding is simulated by flipping the stored user's EMAIL out of the allowlist rather than mutating
 * `env.ADMIN_EMAILS` (loaded once at boot): `isAllowlistedOperator` resolves `user.email` per lookup, so
 * the two are the same input to `isAdminEmail`.
 */

import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient, type CacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import type { UserRecord, UserStore } from "../../src/auth/stores.js"
import { buildAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import { OPERATOR_ALLOWLIST_TTL_SECONDS } from "../../src/auth/admin-guard.js"
import { InMemoryModerationRepository } from "../../src/services/admin/moderation-repository.memory.js"

const ALLOWED = "ops@civfix.org"
const NOT_ALLOWED = "stranger@example.com"
const ALLOWLIST_KEY_PREFIX = "opallow:"

/** A UserStore delegate that counts findById calls and can rewrite a user's email (off-boarding). */
class SpyUserStore implements UserStore {
  /** How many times the allowlist resolution actually reached the user store. */
  lookups = 0
  /** userId -> email to report instead of the stored one. */
  readonly emailOverrides = new Map<string, string | null>()

  constructor(private readonly inner: UserStore) {}

  async findById(id: string): Promise<UserRecord | null> {
    this.lookups += 1
    const row = await this.inner.findById(id)
    if (row !== null && this.emailOverrides.has(id)) {
      return { ...row, email: this.emailOverrides.get(id)! }
    }
    return row
  }

  findByEmail(email: string): Promise<UserRecord | null> {
    return this.inner.findByEmail(email)
  }
  findByHandle(handle: string): Promise<UserRecord | null> {
    return this.inner.findByHandle(handle)
  }
  create(email: string | null, input: Parameters<UserStore["create"]>[1]): Promise<UserRecord> {
    return this.inner.create(email, input)
  }
  updateProfile(id: string, input: Parameters<UserStore["updateProfile"]>[1]): Promise<UserRecord> {
    return this.inner.updateProfile(id, input)
  }
  setRole(id: string, role: Parameters<UserStore["setRole"]>[1]): Promise<UserRecord> {
    return this.inner.setRole(id, role)
  }
  updateSettings(id: string, input: Parameters<UserStore["updateSettings"]>[1]): Promise<UserRecord> {
    return this.inner.updateSettings(id, input)
  }
  softDeleteAndAnonymize(id: string): Promise<UserRecord> {
    return this.inner.softDeleteAndAnonymize(id)
  }
}

/**
 * A CacheClient over InMemoryCacheClient that records the allowlist keys it is asked about and can be made
 * to throw on get/set for those keys only (the session write-through cache must keep working, or the
 * request would fail before the guard even runs).
 */
class SpyCache implements CacheClient {
  readonly gets: string[] = []
  readonly sets: Array<{ key: string; value: string; ttlSeconds: number }> = []
  failGet = false
  failSet = false

  constructor(private readonly inner: InMemoryCacheClient) {}

  private isAllowlistKey(key: string): boolean {
    return key.startsWith(ALLOWLIST_KEY_PREFIX)
  }

  get(key: string): Promise<string | null> {
    if (this.isAllowlistKey(key)) {
      this.gets.push(key)
      if (this.failGet) return Promise.reject(new Error("redis down (GET)"))
    }
    return this.inner.get(key)
  }

  set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.isAllowlistKey(key)) {
      this.sets.push({ key, value, ttlSeconds })
      if (this.failSet) return Promise.reject(new Error("redis down (SET)"))
    }
    return this.inner.set(key, value, ttlSeconds)
  }

  del(key: string): Promise<void> {
    return this.inner.del(key)
  }
  incr(key: string, ttlSeconds: number): Promise<number> {
    return this.inner.incr(key, ttlSeconds)
  }
  expiryOf(key: string): number | null {
    return this.inner.expiryOf(key)
  }
}

interface Harness {
  app: FastifyInstance
  services: AuthServices
  users: SpyUserStore
  cache: SpyCache
  clock: { ms: number }
  /** Advance the shared clock (cache TTLs + session clock) by `seconds`. */
  advanceSeconds(seconds: number): void
  /** Seed an operator-role user + a bearer session for it. */
  operator(email: string | null): Promise<{ userId: string; token: string }>
}

let current: Harness | undefined

afterEach(async () => {
  if (current) {
    await current.app.close()
    current = undefined
  }
})

async function makeHarness(): Promise<Harness> {
  const clock = { ms: Date.UTC(2026, 6, 24, 12, 0, 0) }
  const inner = makeInMemoryStores()
  const users = new SpyUserStore(inner.users)
  const cache = new SpyCache(new InMemoryCacheClient(() => clock.ms))
  const services = buildAuthServices({
    stores: { ...inner, users },
    cache,
    mailer: new FakeMailer(),
    oauthConfig: {},
    now: () => clock.ms,
  })
  const env = loadEnv({ NODE_ENV: "test", ADMIN_EMAILS: ALLOWED })
  const app = await buildServer({
    env,
    authServices: services,
    // Makes GET /v1/admin/moderation answer 200 offline, so a guard PASS is observable.
    moderationOverrides: { repo: new InMemoryModerationRepository() },
  })

  const h: Harness = {
    app,
    services,
    users,
    cache,
    clock,
    advanceSeconds(seconds: number) {
      clock.ms += seconds * 1000
    },
    async operator(email: string | null) {
      const user = await inner.users.create(email, {
        displayName: "Operator",
        role: "operator",
        emailVerified: true,
      })
      const token = await services.sessions.createSession(user.id, ["operator"])
      return { userId: user.id, token }
    },
  }
  current = h
  return h
}

/** GET an admin data route with a bearer operator session. 200 = passed the guard, 403 = denied. */
function get(h: Harness, token: string) {
  return h.app.inject({
    method: "GET",
    url: "/v1/admin/moderation",
    headers: { authorization: `Bearer ${token}` },
  })
}

describe("operator allowlist verdict caching", () => {
  it("caches a POSITIVE verdict: the second request passes with NO additional user lookup", async () => {
    const h = await makeHarness()
    const { userId, token } = await h.operator(ALLOWED)

    const first = await get(h, token)
    expect(first.statusCode).toBe(200)
    expect(first.json()).toEqual({ items: [], nextCursor: null })
    expect(h.users.lookups).toBe(1)

    for (let i = 0; i < 4; i++) {
      expect((await get(h, token)).statusCode).toBe(200)
    }
    // Still ONE lookup: the console's request stream costs ~1 user read per TTL, not one per request.
    expect(h.users.lookups).toBe(1)
    expect(h.cache.sets).toEqual([
      { key: ALLOWLIST_KEY_PREFIX + userId, value: "1", ttlSeconds: OPERATOR_ALLOWLIST_TTL_SECONDS },
    ])
  })

  it("caches a NEGATIVE verdict: a denied caller's storm costs ONE user lookup, not one per request", async () => {
    const h = await makeHarness()
    // A real users.role='operator' row + a live session, but the address is not (or no longer) allowlisted.
    const { userId, token } = await h.operator(NOT_ALLOWED)

    for (let i = 0; i < 5; i++) {
      const res = await get(h, token)
      expect(res.statusCode, `request ${i}`).toBe(403)
      expect(res.json().code).toBe("FORBIDDEN")
    }
    expect(h.users.lookups).toBe(1)
    expect(h.cache.sets).toEqual([
      { key: ALLOWLIST_KEY_PREFIX + userId, value: "0", ttlSeconds: OPERATOR_ALLOWLIST_TTL_SECONDS },
    ])
  })

  it("keys the verdict PER USER (one operator's denial does not deny another)", async () => {
    const h = await makeHarness()
    const good = await h.operator(ALLOWED)
    const bad = await h.operator(NOT_ALLOWED)

    expect((await get(h, bad.token)).statusCode).toBe(403)
    expect((await get(h, good.token)).statusCode).toBe(200)
    expect((await get(h, bad.token)).statusCode).toBe(403)
    expect((await get(h, good.token)).statusCode).toBe(200)

    expect(h.users.lookups).toBe(2) // one per user, then both cached
    expect(h.cache.sets.map((s) => s.key).sort()).toEqual(
      [ALLOWLIST_KEY_PREFIX + bad.userId, ALLOWLIST_KEY_PREFIX + good.userId].sort(),
    )
  })

  it("sets the cache expiry exactly OPERATOR_ALLOWLIST_TTL_SECONDS ahead (not ms, not forever)", async () => {
    const h = await makeHarness()
    const { userId, token } = await h.operator(ALLOWED)
    expect((await get(h, token)).statusCode).toBe(200)
    expect(h.cache.expiryOf(ALLOWLIST_KEY_PREFIX + userId)).toBe(
      h.clock.ms + OPERATOR_ALLOWLIST_TTL_SECONDS * 1000,
    )
  })
})

describe("the off-boarding window IS the cache TTL", () => {
  it("keeps an off-boarded operator in for at most the TTL, then re-derives and 403s", async () => {
    const h = await makeHarness()
    const { userId, token } = await h.operator(ALLOWED)
    expect((await get(h, token)).statusCode).toBe(200)
    expect(h.users.lookups).toBe(1)

    // OFF-BOARD: the address is no longer allowlisted.
    h.users.emailOverrides.set(userId, NOT_ALLOWED)

    // Inside the window the cached positive verdict still wins — this is the documented, deliberate
    // staleness trade, not a bug. Pinned so shortening/lengthening it is a conscious change.
    h.advanceSeconds(OPERATOR_ALLOWLIST_TTL_SECONDS - 1)
    expect((await get(h, token)).statusCode).toBe(200)
    expect(h.users.lookups).toBe(1)

    // Past the TTL the verdict is re-derived from the (now non-allowlisted) email.
    h.advanceSeconds(2)
    const after = await get(h, token)
    expect(after.statusCode).toBe(403)
    expect(h.users.lookups).toBe(2)
    // And the fresh NEGATIVE verdict is cached in turn.
    expect(h.cache.sets.at(-1)).toEqual({
      key: ALLOWLIST_KEY_PREFIX + userId,
      value: "0",
      ttlSeconds: OPERATOR_ALLOWLIST_TTL_SECONDS,
    })
    expect((await get(h, token)).statusCode).toBe(403)
    expect(h.users.lookups).toBe(2)
  })

  it("re-onboarding is symmetric: a cached DENIAL also expires after the TTL", async () => {
    const h = await makeHarness()
    const { userId, token } = await h.operator(NOT_ALLOWED)
    expect((await get(h, token)).statusCode).toBe(403)

    h.users.emailOverrides.set(userId, ALLOWED)
    // The negative verdict is sticky for the same window (no special-casing of "0").
    h.advanceSeconds(OPERATOR_ALLOWLIST_TTL_SECONDS - 1)
    expect((await get(h, token)).statusCode).toBe(403)
    expect(h.users.lookups).toBe(1)

    h.advanceSeconds(2)
    expect((await get(h, token)).statusCode).toBe(200)
    expect(h.users.lookups).toBe(2)
  })
})

describe("fail-closed", () => {
  it("a cache GET failure surfaces as a 500 and NEVER as a pass", async () => {
    const h = await makeHarness()
    const { token } = await h.operator(ALLOWED)
    h.cache.failGet = true

    const res = await get(h, token)
    expect(res.statusCode).toBe(500)
    expect(res.statusCode).not.toBe(200)
    // The guard threw before resolving the user: a Redis outage does not silently disable the check.
    expect(h.users.lookups).toBe(0)
    expect(h.cache.sets).toHaveLength(0)
  })

  it("a cache SET failure also surfaces (an un-cacheable verdict is not quietly accepted)", async () => {
    const h = await makeHarness()
    const { userId, token } = await h.operator(ALLOWED)
    h.cache.failSet = true

    const res = await get(h, token)
    expect(res.statusCode).toBe(500)
    // The lookup DID happen (the failure is on the write-back), and nothing was persisted.
    expect(h.users.lookups).toBe(1)
    expect(h.cache.expiryOf(ALLOWLIST_KEY_PREFIX + userId)).toBeNull()
  })

  it("403s (and caches the denial) when the operator row has NO email at all", async () => {
    const h = await makeHarness()
    const { userId, token } = await h.operator(null)
    expect((await get(h, token)).statusCode).toBe(403)
    expect(h.cache.sets).toEqual([
      { key: ALLOWLIST_KEY_PREFIX + userId, value: "0", ttlSeconds: OPERATOR_ALLOWLIST_TTL_SECONDS },
    ])
  })

  it("403s when the session's user row is GONE (a deleted operator with a warm session)", async () => {
    const h = await makeHarness()
    const { userId, token } = await h.operator(ALLOWED)
    // No user row resolves => no operator authority, even though the session still carries the claim.
    h.users.emailOverrides.set(userId, null)
    expect((await get(h, token)).statusCode).toBe(403)
  })

  it("never consults the allowlist cache for an anonymous or citizen caller", async () => {
    const h = await makeHarness()
    expect(
      (await h.app.inject({ method: "GET", url: "/v1/admin/moderation" })).statusCode,
    ).toBe(401)

    const inner = await h.services.sessions.createSession(
      (await h.services.users.create("citizen@example.com", { displayName: "C" })).id,
      ["citizen"],
    )
    expect((await get(h, inner)).statusCode).toBe(403)

    // The cheap session-claim check rejects both BEFORE any allowlist resolution: no `opallow:` cache
    // traffic and no user read at all, so an anonymous request storm cannot cost anything.
    expect(h.cache.gets).toHaveLength(0)
    expect(h.cache.sets).toHaveLength(0)
    expect(h.users.lookups).toBe(0)
  })
})
