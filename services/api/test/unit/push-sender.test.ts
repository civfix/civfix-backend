import { describe, it, expect } from "vitest"
import type { Db } from "../../src/db/client.js"
import {
  MultiPushSender,
  groupByPlatform,
  isSafePushEndpoint,
  resolveSafePushTarget,
  type ActiveToken,
  type PlatformDispatcher,
  type PushDispatchers,
} from "../../src/adapters/push-sender.js"
import { PUSH_MAX_PER_USER_PER_MINUTE, allowedByPushRate } from "../../src/adapters/push-sender.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import type { PushPayload, PushPlatform } from "@civfix/shared/interfaces"

function recordingDispatcher(invalid: string[] = []): {
  calls: Array<{ tokens: string[]; payload: PushPayload }>
  fn: PlatformDispatcher
} {
  const calls: Array<{ tokens: string[]; payload: PushPayload }> = []
  const fn: PlatformDispatcher = (tokens, payload) => {
    calls.push({ tokens, payload })
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

describe("groupByPlatform", () => {
  it("groups tokens by platform and de-duplicates within a platform", () => {
    const tokens: ActiveToken[] = [
      { userId: "u", platform: "ios", token: "a" },
      { userId: "u", platform: "ios", token: "a" },
      { userId: "u", platform: "android", token: "b" },
      { userId: "u", platform: "web", token: "c" },
    ]
    expect(groupByPlatform(tokens)).toEqual({ ios: ["a"], android: ["b"], web: ["c"] })
  })

  it("returns empty arrays for platforms with no tokens", () => {
    expect(groupByPlatform([])).toEqual({ ios: [], android: [], web: [] })
  })
})

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

describe("MultiPushSender.sendMany", () => {
  it("delivers to multiple users' tokens and is a no-op for an empty user list", async () => {
    const rows: TokenRow[] = [
      { userId: "u1", platform: "ios", token: "t1" },
      { userId: "u2", platform: "ios", token: "t2" },
    ]
    const ios = recordingDispatcher()
    const dispatchers: PushDispatchers = { ios: ios.fn }
    const prune: PruneCapture = {}
    const sender = new MultiPushSender({ db: fakeDb(rows, prune), config: {}, dispatchers })

    await sender.sendMany(["u1", "u2"], PAYLOAD)
    expect(ios.calls).toHaveLength(1)
    expect(ios.calls[0]!.tokens.sort()).toEqual(["t1", "t2"])

    ios.calls.length = 0
    await sender.sendMany([], PAYLOAD)
    expect(ios.calls).toHaveLength(0)
  })
})

describe("MultiPushSender.registerToken", () => {
  it("is a no-op (persistence is owned by the notification service) and resolves", async () => {
    const prune: PruneCapture = {}
    const sender = new MultiPushSender({ db: fakeDb([], prune), config: {}, dispatchers: {} })
    await expect(sender.registerToken("u", "tok", "ios", "dev")).resolves.toBeUndefined()
  })
})

describe("MultiPushSender.send Expo routing", () => {
  const expoTok = "ExponentPushToken[aaa]"
  const expoTok2 = "ExponentPushToken[bbb]"

  it("routes Expo-format tokens to the expo dispatcher (not APNs/FCM), across ios + android in one call", async () => {
    const rows: TokenRow[] = [
      { userId: "u", platform: "ios", token: expoTok },
      { userId: "u", platform: "android", token: expoTok2 },
    ]
    const ios = recordingDispatcher()
    const android = recordingDispatcher()
    const expo = recordingDispatcher()
    const dispatchers: PushDispatchers = { ios: ios.fn, android: android.fn, expo: expo.fn }
    const prune: PruneCapture = {}

    const sender = new MultiPushSender({ db: fakeDb(rows, prune), config: {}, dispatchers })
    await sender.send("u", PAYLOAD)

    expect(expo.calls).toHaveLength(1)
    expect(expo.calls[0]!.tokens.slice().sort()).toEqual([expoTok, expoTok2].slice().sort())
    expect(ios.calls).toHaveLength(0)
    expect(android.calls).toHaveLength(0)
  })

  it("splits Expo tokens (-> expo) from raw device tokens (-> per-platform) in one send", async () => {
    const rows: TokenRow[] = [
      { userId: "u", platform: "ios", token: expoTok },
      { userId: "u", platform: "web", token: "web-tok" },
    ]
    const expo = recordingDispatcher()
    const web = recordingDispatcher()
    const dispatchers: PushDispatchers = { expo: expo.fn, web: web.fn }
    const prune: PruneCapture = {}

    const sender = new MultiPushSender({ db: fakeDb(rows, prune), config: {}, dispatchers })
    await sender.send("u", PAYLOAD)

    expect(expo.calls[0]!.tokens).toEqual([expoTok])
    expect(web.calls[0]!.tokens).toEqual(["web-tok"])
  })

  it("prunes Expo tokens the expo dispatcher reports invalid", async () => {
    const rows: TokenRow[] = [{ userId: "u", platform: "ios", token: expoTok }]
    const expo = recordingDispatcher([expoTok])
    const dispatchers: PushDispatchers = { expo: expo.fn }
    const prune: PruneCapture = {}

    const sender = new MultiPushSender({ db: fakeDb(rows, prune), config: {}, dispatchers })
    await sender.send("u", PAYLOAD)

    expect(prune.set).toBeDefined()
    expect(prune.set!.revokedAt).toBeInstanceOf(Date)
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
    await sender.sendMany(["hot"], PAYLOAD)
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
