import { describe, it, expect } from "vitest"
import type { Db } from "../../src/db/client.js"
import {
  MultiPushSender,
  groupByPlatform,
  type ActiveToken,
  type PlatformDispatcher,
  type PushDispatchers,
} from "../../src/adapters/push-sender.js"
import type { PushPayload, PushPlatform } from "@civfix/shared/interfaces"

/**
 * Offline unit tests for the REAL MultiPushSender's token-SELECTION + platform-ROUTING + invalid-token
 * PRUNING logic, with the vendor dispatchers INJECTED (so no node-apn/firebase-admin/web-push call is
 * made). A tiny fake Db mimics the Drizzle query-builder chain used by the adapter:
 *   - select({...}).from(table).where(cond)  -> resolves to the seeded active-token rows
 *   - update(table).set({...}).where(cond)   -> captures the prune (revoke) call
 *
 * The real per-platform dispatchers (which DO touch the SDKs) are exercised only when creds + the flag are
 * set in a real deployment; their SDK wiring lives behind lazy dynamic import in the adapter. Here we prove
 * the routing: ios -> the ios dispatcher, android -> fcm, web -> webpush; an absent dispatcher (no creds)
 * is skipped; and the tokens a dispatcher reports invalid are pruned.
 */

/** A recording dispatcher: captures what it was asked to send and reports a fixed invalid set. */
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

/** A row as the adapter's SELECT projects it. */
interface TokenRow {
  userId: string
  platform: PushPlatform
  token: string
}

/** Capture of a prune update. */
interface PruneCapture {
  set?: { revokedAt?: Date }
}

/**
 * Build a fake Db that returns `rows` for the select chain and records the update (prune) chain. Only the
 * methods the adapter actually calls are implemented.
 */
function fakeDb(rows: TokenRow[], prune: PruneCapture): Db {
  const selectChain = {
    from() {
      return this
    },
    where() {
      // Resolve to the seeded rows when awaited.
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

// ---------------------------------------------------------------------------
// Pure: groupByPlatform
// ---------------------------------------------------------------------------

describe("groupByPlatform", () => {
  it("groups tokens by platform and de-duplicates within a platform", () => {
    const tokens: ActiveToken[] = [
      { userId: "u", platform: "ios", token: "a" },
      { userId: "u", platform: "ios", token: "a" }, // dup
      { userId: "u", platform: "android", token: "b" },
      { userId: "u", platform: "web", token: "c" },
    ]
    expect(groupByPlatform(tokens)).toEqual({ ios: ["a"], android: ["b"], web: ["c"] })
  })

  it("returns empty arrays for platforms with no tokens", () => {
    expect(groupByPlatform([])).toEqual({ ios: [], android: [], web: [] })
  })
})

// ---------------------------------------------------------------------------
// send: platform routing
// ---------------------------------------------------------------------------

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
    // Nothing reported invalid -> no prune.
    expect(prune.set).toBeUndefined()
  })

  it("SKIPS a platform that has tokens but no configured dispatcher (absent creds); others still send", async () => {
    const rows: TokenRow[] = [
      { userId: "u", platform: "ios", token: "ios-tok" },
      { userId: "u", platform: "web", token: "web-tok" },
    ]
    const web = recordingDispatcher()
    // No ios dispatcher -> ios creds absent -> ios is skipped, web still delivered.
    const dispatchers: PushDispatchers = { web: web.fn }
    const prune: PruneCapture = {}

    const sender = new MultiPushSender({ db: fakeDb(rows, prune), config: {}, dispatchers })
    await sender.send("u", PAYLOAD)

    expect(web.calls).toHaveLength(1)
    expect(web.calls[0]!.tokens).toEqual(["web-tok"])
    // The adapter did not throw; ios was simply skipped.
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
    // The ios dispatcher reports the token invalid.
    const ios = recordingDispatcher(["dead-tok"])
    const dispatchers: PushDispatchers = { ios: ios.fn }
    const prune: PruneCapture = {}

    const sender = new MultiPushSender({ db: fakeDb(rows, prune), config: {}, dispatchers })
    await sender.send("u", PAYLOAD)

    // The prune update ran (revoked_at set to a Date).
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
    // Must resolve (not reject) even though ios threw.
    await expect(sender.send("u", PAYLOAD)).resolves.toBeUndefined()
    // Web still delivered.
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

    // Empty list short-circuits (no dispatcher call).
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

// ---------------------------------------------------------------------------
// send: Expo-token routing (issue #71). The mobile app registers ExponentPushToken[...] tokens, which
// can ONLY be delivered through the Expo push service - never the raw APNs/FCM dispatchers.
// ---------------------------------------------------------------------------

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
    // The raw APNs/FCM dispatchers must NOT receive Expo tokens.
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
