import { describe, it, expect } from "vitest"
import type { Db } from "../../src/db/client.js"
import {
  MultiPushSender,
  isSafePushEndpoint,
  resolveSafePushTarget,
  type PlatformDispatcher,
  type PushDelivery,
  type PushDispatchers,
} from "../../src/adapters/push-sender.js"
import { PUSH_MAX_PER_USER_PER_MINUTE, allowedByPushRate } from "../../src/adapters/push-sender.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import type { PushPayload } from "@civfix/seams"
import type { PushPlatform } from "@civfix/contract"
import { fakePushDb } from "../helpers/push-db.js"
import { N, N1, N2, P } from "../helpers/push-fixtures.js"

interface DispatchCall {
  tokens: string[]
  payload: PushPayload | undefined
  deliveries: PushDelivery[]
}

function recordingDispatcher(invalid: string[] = []): {
  calls: DispatchCall[]
  fn: PlatformDispatcher
} {
  const calls: DispatchCall[] = []
  const fn: PlatformDispatcher = (deliveries) => {
    const first = deliveries[0]?.message
    calls.push({
      tokens: deliveries.map((d) => d.token),
      payload: first?.kind === "notification" ? first.payload : undefined,
      deliveries,
    })
    return Promise.resolve({ invalidTokens: invalid })
  }
  return { calls, fn }
}

interface TokenRow {
  userId: string
  platform: PushPlatform
  token: string
}

interface PruneCapture {
  set?: { revokedAt?: Date }
}

function fakeDb(rows: TokenRow[], prune: PruneCapture): Db {
  const selectChain = {
    from() {
      return this
    },
    where() {
      return this
    },
    orderBy() {
      return this
    },
    limit() {
      return Promise.resolve(rows)
    },
  }
  const updateChain = {
    set(values: { revokedAt?: Date }) {
      prune.set = values
      return this
    },
    where() {
      return Promise.resolve(undefined)
    },
  }
  const db = {
    select() {
      return selectChain
    },
    update() {
      return updateChain
    },
  }
  return db as unknown as Db
}

const PAYLOAD: PushPayload = { title: "Hi", body: "there", link: "/x", data: { k: "v" } }

describe("MultiPushSender.send routing", () => {
  it("routes each platform's tokens to the matching dispatcher (ios->ios, android->fcm, web->webpush)", async () => {
    const rows: TokenRow[] = [
      { userId: "u", platform: "ios", token: "ios-tok" },
      { userId: "u", platform: "android", token: "and-tok" },
      { userId: "u", platform: "web", token: "web-tok" },
    ]
    const ios = recordingDispatcher()
    const android = recordingDispatcher()
    const web = recordingDispatcher()
    const dispatchers: PushDispatchers = { ios: ios.fn, android: android.fn, web: web.fn }
    const prune: PruneCapture = {}

    const sender = new MultiPushSender({ db: fakeDb(rows, prune), config: {}, dispatchers })
    await sender.send("u", PAYLOAD)

    expect(ios.calls).toHaveLength(1)
    expect(ios.calls[0]!.tokens).toEqual(["ios-tok"])
    expect(ios.calls[0]!.payload).toEqual(PAYLOAD)
    expect(android.calls[0]!.tokens).toEqual(["and-tok"])
    expect(web.calls[0]!.tokens).toEqual(["web-tok"])
    expect(prune.set).toBeUndefined()
  })

  it("SKIPS a platform that has tokens but no configured dispatcher (absent creds); others still send", async () => {
    const rows: TokenRow[] = [
      { userId: "u", platform: "ios", token: "ios-tok" },
      { userId: "u", platform: "web", token: "web-tok" },
    ]
    const web = recordingDispatcher()
    const dispatchers: PushDispatchers = { web: web.fn }
    const prune: PruneCapture = {}

    const sender = new MultiPushSender({ db: fakeDb(rows, prune), config: {}, dispatchers })
    await sender.send("u", PAYLOAD)

    expect(web.calls).toHaveLength(1)
    expect(web.calls[0]!.tokens).toEqual(["web-tok"])
  })

  it("does nothing when the user has no active tokens", async () => {
    const ios = recordingDispatcher()
    const dispatchers: PushDispatchers = { ios: ios.fn }
    const prune: PruneCapture = {}
    const sender = new MultiPushSender({ db: fakeDb([], prune), config: {}, dispatchers })
    await sender.send("u", PAYLOAD)
    expect(ios.calls).toHaveLength(0)
    expect(prune.set).toBeUndefined()
  })

  it("prunes (revokes) tokens a dispatcher reports invalid", async () => {
    const rows: TokenRow[] = [{ userId: "u", platform: "ios", token: "dead-tok" }]
    const ios = recordingDispatcher(["dead-tok"])
    const dispatchers: PushDispatchers = { ios: ios.fn }
    const prune: PruneCapture = {}

    const sender = new MultiPushSender({ db: fakeDb(rows, prune), config: {}, dispatchers })
    await sender.send("u", PAYLOAD)

    expect(prune.set).toBeDefined()
    expect(prune.set!.revokedAt).toBeInstanceOf(Date)
  })

  it("a dispatcher that throws does not break the request or the other platforms", async () => {
    const rows: TokenRow[] = [
      { userId: "u", platform: "ios", token: "ios-tok" },
      { userId: "u", platform: "web", token: "web-tok" },
    ]
    const throwing: PlatformDispatcher = () => Promise.reject(new Error("apns down"))
    const web = recordingDispatcher()
    const dispatchers: PushDispatchers = { ios: throwing, web: web.fn }
    const prune: PruneCapture = {}

    const sender = new MultiPushSender({ db: fakeDb(rows, prune), config: {}, dispatchers })
    await expect(sender.send("u", PAYLOAD)).resolves.toBeUndefined()
    expect(web.calls).toHaveLength(1)
  })
})

describe("MultiPushSender.sendEach", () => {
  it("delivers to multiple users' tokens and is a no-op for an empty item list", async () => {
    const rows: TokenRow[] = [
      { userId: "u1", platform: "ios", token: "t1" },
      { userId: "u2", platform: "ios", token: "t2" },
    ]
    const ios = recordingDispatcher()
    const dispatchers: PushDispatchers = { ios: ios.fn }
    const prune: PruneCapture = {}
    const sender = new MultiPushSender({ db: fakeDb(rows, prune), config: {}, dispatchers })

    await sender.sendEach([
      { userId: "u1", payload: PAYLOAD },
      { userId: "u2", payload: PAYLOAD },
    ])
    expect(ios.calls).toHaveLength(1)
    expect(ios.calls[0]!.tokens.sort()).toEqual(["t1", "t2"])

    ios.calls.length = 0
    await sender.sendEach([])
    expect(ios.calls).toHaveLength(0)
  })

  it("T6: 1200 recipients load their tokens in selects of 500, 500 and 200 user ids", async () => {
    const fake = fakePushDb([])
    const sender = new MultiPushSender({ db: fake.db, config: {}, dispatchers: {} })
    const items = Array.from({ length: 1200 }, (_, i) => ({ userId: `user-${i}`, payload: P(N(i + 1), null) }))

    await sender.sendEach(items)

    expect(fake.selects.map((params) => params.length)).toEqual([500, 500, 200])
    expect(fake.selects.flat()).toEqual(items.map((item) => item.userId))
  })

  it("T7: a recipient at the 60-a-minute cap is skipped while the others in the call still get theirs", async () => {
    const counters = new InMemoryCounterStore(() => 1_000)
    for (let i = 0; i < 60; i++) await counters.incr("push:rate:u1", 60)
    const fake = fakePushDb([
      { userId: "u1", platform: "android", token: "a-u1" },
      { userId: "u2", platform: "android", token: "a-u2" },
    ])
    const android = recordingDispatcher()
    const sender = new MultiPushSender({
      db: fake.db,
      config: {},
      dispatchers: { android: android.fn },
      counters,
      logger: { warn: () => {}, error: () => {} },
    })

    await sender.sendEach([
      { userId: "u1", payload: P(N1, null) },
      { userId: "u2", payload: P(N2, null) },
    ])

    expect(android.calls.flatMap((c) => c.tokens)).toEqual(["a-u2"])
  })

  it("T26: a stored Expo token is revoked and reaches no dispatcher, the APNs token is delivered", async () => {
    const expo = "ExponentPushToken[x]"
    const i1 = "ab".repeat(32)
    const fake = fakePushDb([
      { userId: "u1", platform: "ios", token: expo },
      { userId: "u1", platform: "ios", token: i1 },
    ])
    const ios = recordingDispatcher()
    const android = recordingDispatcher()
    const web = recordingDispatcher()
    const sender = new MultiPushSender({
      db: fake.db,
      config: {},
      dispatchers: { ios: ios.fn, android: android.fn, web: web.fn },
    })

    await sender.sendEach([{ userId: "u1", payload: P(N1, null) }])

    expect(fake.rows.find((r) => r.token === expo)!.revokedAt).toBeInstanceOf(Date)
    expect(fake.rows.find((r) => r.token === i1)!.revokedAt).toBeUndefined()
    const dispatched = [...ios.calls, ...android.calls, ...web.calls].flatMap((c) => c.tokens)
    expect(dispatched).toEqual([i1])
  })
})

describe("MultiPushSender.registerToken", () => {
  it("is a no-op (persistence is owned by the notification service) and resolves", async () => {
    const prune: PruneCapture = {}
    const sender = new MultiPushSender({ db: fakeDb([], prune), config: {}, dispatchers: {} })
    await expect(sender.registerToken("u", "tok", "ios", "dev")).resolves.toBeUndefined()
  })
})

describe("isSafePushEndpoint (SSRF guard, IP-literal paths)", () => {
  const UNSAFE = [
    "https://[::ffff:127.0.0.1]/x",
    "https://[::ffff:169.254.169.254]/latest/meta-data/",
    "https://[::ffff:10.0.0.5]/x",
    "https://[::ffff:192.168.1.1]/x",
    "https://[::ffff:7f00:1]/x",
    "https://[::ffff:a9fe:a9fe]/x",
    "https://[::1]/x",
    "https://[::]/x",
    "https://[64:ff9b::7f00:1]/x",
    "https://[64:ff9b::a9fe:a9fe]/x",
    "https://[fe80::1]/x",
    "https://[fd00::1]/x",
    "https://[fc00::1]/x",
    "https://127.0.0.1/x",
    "https://169.254.169.254/x",
    "https://10.1.2.3/x",
    "https://192.168.0.1/x",
    "https://100.64.0.1/x",
    "http://[2606:4700:4700::1111]/x",
    "https://[::a.b.c.d]/x",
  ]
  const SAFE = [
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://8.8.8.8/x",
    "https://[2606:4700:4700::1111]/x",
    "https://[2001:4860:4860::8888]/x",
  ]

  for (const e of UNSAFE) {
    it(`rejects ${e}`, async () => {
      expect(await isSafePushEndpoint(e)).toBe(false)
      expect(await resolveSafePushTarget(e)).toBeNull()
    })
  }
  for (const e of SAFE.filter((e) => !e.includes("mozilla"))) {
    it(`accepts literal ${e}`, async () => {
      expect(await isSafePushEndpoint(e)).toBe(true)
    })
  }
})

describe("per-user push rate cap (H15)", () => {
  const rateRows = (userId: string): TokenRow[] => [
    { userId, platform: "ios", token: `${userId}-tok` },
  ]

  it("stops dispatching to a recipient past the per-minute cap and keeps the window per user", async () => {
    const ios = recordingDispatcher()
    const counters = new InMemoryCounterStore(() => 1_000)
    const sender = new MultiPushSender({
      db: fakeDb(rateRows("victim"), {}),
      config: {},
      dispatchers: { ios: ios.fn },
      counters,
    })

    for (let i = 0; i < PUSH_MAX_PER_USER_PER_MINUTE + 25; i++) {
      await sender.send("victim", PAYLOAD)
    }
    expect(ios.calls).toHaveLength(PUSH_MAX_PER_USER_PER_MINUTE)

    const other = recordingDispatcher()
    const senderB = new MultiPushSender({
      db: fakeDb(rateRows("bystander"), {}),
      config: {},
      dispatchers: { ios: other.fn },
      counters,
    })
    await senderB.send("bystander", PAYLOAD)
    expect(other.calls).toHaveLength(1)
  })

  it("drops only the over-cap recipients out of a fan-out batch", async () => {
    const counters = new InMemoryCounterStore(() => 1_000)
    for (let i = 0; i < PUSH_MAX_PER_USER_PER_MINUTE; i++) {
      await counters.incr("push:rate:hot", 60)
    }
    const allowed = await allowedByPushRate(["hot", "cool"], counters, {
      warn: () => {},
      error: () => {},
    })
    expect(allowed).toEqual(["cool"])
  })

  it("skips the token query entirely when every recipient is over the cap", async () => {
    const ios = recordingDispatcher()
    const counters = new InMemoryCounterStore(() => 1_000)
    for (let i = 0; i < PUSH_MAX_PER_USER_PER_MINUTE; i++) {
      await counters.incr("push:rate:hot", 60)
    }
    const sender = new MultiPushSender({
      db: fakeDb([{ userId: "hot", platform: "ios", token: "hot-tok" }], {}),
      config: {},
      dispatchers: { ios: ios.fn },
      counters,
      logger: { warn: () => {}, error: () => {} },
    })
    await sender.sendEach([{ userId: "hot", payload: PAYLOAD }])
    expect(ios.calls).toHaveLength(0)
  })

  it("fails OPEN when the counter store is unavailable (a Redis blip must not mute notifications)", async () => {
    const ios = recordingDispatcher()
    const sender = new MultiPushSender({
      db: fakeDb(rateRows("u"), {}),
      config: {},
      dispatchers: { ios: ios.fn },
      counters: {
        incr: () => Promise.reject(new Error("redis down")),
        incrBy: () => Promise.reject(new Error("redis down")),
        decrBy: () => Promise.reject(new Error("redis down")),
      },
      logger: { warn: () => {}, error: () => {} },
    })
    await sender.send("u", PAYLOAD)
    expect(ios.calls).toHaveLength(1)
  })
})
