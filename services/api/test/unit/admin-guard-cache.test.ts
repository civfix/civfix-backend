import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { makeServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient, type CacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import type { UserRecord, UserStore } from "../../src/auth/stores.js"
import { makeAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import { OPERATOR_ALLOWLIST_TTL_SECONDS } from "../../src/auth/admin-guard.js"
import { InMemoryModerationRepository } from "../helpers/admin/moderation-repository.memory.js"

const ALLOWED = "ops@civfix.org"
const NOT_ALLOWED = "stranger@example.com"
const ALLOWLIST_KEY_PREFIX = "opallow:"

class SpyUserStore implements UserStore {
  lookups = 0
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
  updateSettings(
    id: string,
    input: Parameters<UserStore["updateSettings"]>[1],
  ): Promise<UserRecord> {
    return this.inner.updateSettings(id, input)
  }
  softDeleteAndAnonymize(id: string): Promise<UserRecord> {
    return this.inner.softDeleteAndAnonymize(id)
  }
  accountStatus(id: string): Promise<import("../../src/auth/stores.js").AccountStatus> {
    return this.inner.accountStatus(id)
  }
}

class SpyCache implements CacheClient {
  readonly gets: string[] = []
  sadd(key: string, ...members: string[]): Promise<number> {
    return this.inner.sadd(key, ...members)
  }
  srem(key: string, ...members: string[]): Promise<number> {
    return this.inner.srem(key, ...members)
  }
  smembers(key: string): Promise<string[]> {
    return this.inner.smembers(key)
  }
  smismember(key: string, members: readonly string[]): Promise<number[]> {
    return this.inner.smismember(key, members)
  }
  scard(key: string): Promise<number> {
    return this.inner.scard(key)
  }
  expire(key: string, ttlSeconds: number): Promise<void> {
    return this.inner.expire(key, ttlSeconds)
  }
  expireNx(key: string, ttlSeconds: number): Promise<void> {
    return this.inner.expireNx(key, ttlSeconds)
  }
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
  advanceSeconds(seconds: number): void
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
  const services = makeAuthServices({
    stores: { ...inner, users },
    cache,
    mailer: new FakeMailer(),
    oauthConfig: {},
    now: () => clock.ms,
  })
  const env = loadEnv({ NODE_ENV: "test", ADMIN_EMAILS: ALLOWED })
  const app = await makeServer({
    env,
    authServices: services,
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
    expect(h.users.lookups).toBe(1)
    expect(h.cache.sets).toEqual([
      {
        key: ALLOWLIST_KEY_PREFIX + userId,
        value: "1",
        ttlSeconds: OPERATOR_ALLOWLIST_TTL_SECONDS,
      },
    ])
  })

  it("caches a NEGATIVE verdict: a denied caller's storm costs ONE user lookup, not one per request", async () => {
    const h = await makeHarness()
    const { userId, token } = await h.operator(NOT_ALLOWED)

    for (let i = 0; i < 5; i++) {
      const res = await get(h, token)
      expect(res.statusCode, `request ${i}`).toBe(403)
      expect(res.json().code).toBe("FORBIDDEN")
    }
    expect(h.users.lookups).toBe(1)
    expect(h.cache.sets).toEqual([
      {
        key: ALLOWLIST_KEY_PREFIX + userId,
        value: "0",
        ttlSeconds: OPERATOR_ALLOWLIST_TTL_SECONDS,
      },
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

    expect(h.users.lookups).toBe(2)
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

    h.users.emailOverrides.set(userId, NOT_ALLOWED)

    h.advanceSeconds(OPERATOR_ALLOWLIST_TTL_SECONDS - 1)
    expect((await get(h, token)).statusCode).toBe(200)
    expect(h.users.lookups).toBe(1)

    h.advanceSeconds(2)
    const after = await get(h, token)
    expect(after.statusCode).toBe(403)
    expect(h.users.lookups).toBe(2)
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
    expect(h.users.lookups).toBe(0)
    expect(h.cache.sets).toHaveLength(0)
  })

  it("a cache SET failure also surfaces (an un-cacheable verdict is not quietly accepted)", async () => {
    const h = await makeHarness()
    const { userId, token } = await h.operator(ALLOWED)
    h.cache.failSet = true

    const res = await get(h, token)
    expect(res.statusCode).toBe(500)
    expect(h.users.lookups).toBe(1)
    expect(h.cache.expiryOf(ALLOWLIST_KEY_PREFIX + userId)).toBeNull()
  })

  it("403s (and caches the denial) when the operator row has NO email at all", async () => {
    const h = await makeHarness()
    const { userId, token } = await h.operator(null)
    expect((await get(h, token)).statusCode).toBe(403)
    expect(h.cache.sets).toEqual([
      {
        key: ALLOWLIST_KEY_PREFIX + userId,
        value: "0",
        ttlSeconds: OPERATOR_ALLOWLIST_TTL_SECONDS,
      },
    ])
  })

  it("403s when the session's user row is GONE (a deleted operator with a warm session)", async () => {
    const h = await makeHarness()
    const { userId, token } = await h.operator(ALLOWED)
    h.users.emailOverrides.set(userId, null)
    expect((await get(h, token)).statusCode).toBe(403)
  })

  it("never consults the allowlist cache for an anonymous or citizen caller", async () => {
    const h = await makeHarness()
    expect((await h.app.inject({ method: "GET", url: "/v1/admin/moderation" })).statusCode).toBe(
      401,
    )

    const inner = await h.services.sessions.createSession(
      (await h.services.users.create("citizen@example.com", { displayName: "C" })).id,
      ["citizen"],
    )
    expect((await get(h, inner)).statusCode).toBe(403)

    expect(h.cache.gets).toHaveLength(0)
    expect(h.cache.sets).toHaveLength(0)
    expect(h.users.lookups).toBe(0)
  })
})
