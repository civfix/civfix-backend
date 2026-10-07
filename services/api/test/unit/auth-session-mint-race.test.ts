import { describe, it, expect } from "vitest"
import type { Role } from "@civfix/shared"
import { InMemoryCacheClient, type CacheClient } from "../../src/auth/cache.js"
import {
  InMemorySessionStore,
  type AccountStatus,
  type SessionInsert,
} from "../../src/auth/stores.js"
import { SessionService } from "../../src/auth/session-service.js"
import { sha256Hex } from "../../src/auth/crypto.js"

const USER = "22222222-2222-2222-2222-222222222222"
const START_MS = 1_700_000_000_000

class StatusLookup {
  status: AccountStatus = "active"
  accountStatus(): Promise<AccountStatus> {
    return Promise.resolve(this.status)
  }
  findById(): Promise<{ role: Role } | null> {
    return Promise.resolve({ role: "citizen" })
  }
}

class RacingSessionStore extends InMemorySessionStore {
  beforeInsert: (() => Promise<void>) | undefined

  override async insert(row: SessionInsert): Promise<void> {
    const hook = this.beforeInsert
    this.beforeInsert = undefined
    if (hook) await hook()
    return super.insert(row)
  }
}

function makeRacingService() {
  const now = (): number => START_MS
  const store = new RacingSessionStore()
  const cache = new InMemoryCacheClient(now)
  const users = new StatusLookup()
  const service = new SessionService({ store, cache, users, now })
  return { service, store, users }
}

describe("createSession against a suspension that lands between the status read and the insert", () => {
  it("does not leave a durable session for the suspended user", async () => {
    const { service, store, users } = makeRacingService()
    store.beforeInsert = async () => {
      users.status = "suspended"
      store.setAccountStatus(USER, "suspended")
      await service.applyAccountStatus(USER, "suspended")
    }

    await expect(service.createSession(USER, ["citizen"])).rejects.toMatchObject({
      httpStatus: 403,
    })
    expect(store.count()).toBe(0)
  })

  it("keeps the new session when only a logout-everywhere raced the login", async () => {
    const { service, store } = makeRacingService()
    store.beforeInsert = async () => {
      await service.revokeAllForUser(USER)
    }

    const token = await service.createSession(USER, ["citizen"])
    const resolved = await service.resolveSession(token)
    expect(resolved?.userId).toBe(USER)
    expect(resolved?.source).toBe("cache")
    expect(await store.findById(await sha256Hex(token))).not.toBeNull()
  })
})

class FailingDelCache extends InMemoryCacheClient {
  override del(): Promise<void> {
    return Promise.reject(new Error("redis del down"))
  }
}

describe("session cache eviction failures are logged, not dropped", () => {
  it("logs when a rejected cached projection cannot be evicted", async () => {
    let clock = START_MS
    const now = (): number => clock
    const store = new InMemorySessionStore()
    const cache: CacheClient = new FailingDelCache(now)
    const errors: unknown[] = []
    const service = new SessionService({
      store,
      cache,
      now,
      ttlSeconds: 60,
      logger: { error: (obj) => errors.push(obj) },
    })
    const token = await service.createSession(USER, ["citizen"])
    const hash = await sha256Hex(token)
    await service.bumpEpoch(USER)

    expect(await service.resolveSession(token)).not.toBeNull()
    expect(errors).toContainEqual(expect.objectContaining({ hash }))

    errors.length = 0
    clock += 61_000
    await store.insert({
      id: hash,
      userId: USER,
      roles: ["citizen"],
      expiresAt: new Date(clock - 1),
      lastSeenAt: new Date(START_MS),
      userAgent: null,
      ip: null,
    })
    expect(await service.resolveSession(token)).toBeNull()
    expect(errors).toContainEqual(expect.objectContaining({ hash }))
  })
})
