import { describe, expect, it } from "vitest"
import { DEFAULT_FEED_RANKING } from "@civfix/shared"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import {
  makeFeedPresence,
  servedKey,
  snapshotKey,
  viewersKey,
  type FeedPresenceCache,
} from "../../src/services/feed-presence.js"

const VIEWER = "11111111-1111-1111-1111-111111111111"
const OTHER = "22222222-2222-2222-2222-222222222222"
const POST = "33333333-3333-3333-3333-333333333333"

const CFG = DEFAULT_FEED_RANKING

function present(over: Partial<typeof DEFAULT_FEED_RANKING> = {}) {
  const cache = new InMemoryCacheClient(() => Date.now())
  return {
    cache,
    presence: makeFeedPresence({ cache, config: { ...CFG, ...over } }),
  }
}

describe("feed presence: key convention", () => {
  it("namespaces every key with the house lowercase colon :v1 prefix", () => {
    expect(snapshotKey(VIEWER, "all")).toBe(`feed:rank:v1:${VIEWER}:all`)
    expect(servedKey(VIEWER)).toBe(`feed:served:v1:${VIEWER}`)
    expect(viewersKey(POST)).toBe(`feed:viewers:v1:${POST}`)
  })

  it("keys the snapshot per filter, so the events tab cannot serve the all tab's page", () => {
    expect(snapshotKey(VIEWER, "events")).not.toBe(snapshotKey(VIEWER, "all"))
  })
})

describe("feed presence: snapshot", () => {
  it("round-trips a ranked set", async () => {
    const { presence } = present()
    await presence.writeSnapshot(VIEWER, "all", [
      { id: POST, authorId: "a", score: 115.9 },
      { id: OTHER, authorId: "b", score: 13.125 },
    ])
    expect(await presence.readSnapshot(VIEWER, "all")).toEqual([
      { id: POST, score: 115.9 },
      { id: OTHER, score: 13.125 },
    ])
  })

  it("caps the stored snapshot at candidateCap", async () => {
    const { cache, presence } = present({ candidateCap: 50 })
    const ranked = Array.from({ length: 400 }, (_, i) => ({
      id: `${i}`,
      authorId: "a",
      score: 400 - i,
    }))
    await presence.writeSnapshot(VIEWER, "all", ranked)
    const raw = await cache.get(snapshotKey(VIEWER, "all"))
    expect(JSON.parse(raw!)).toHaveLength(50)
  })

  it("returns null rather than throwing on a corrupt payload", async () => {
    const { cache, presence } = present()
    await cache.set(snapshotKey(VIEWER, "all"), "{not json", 60)
    expect(await presence.readSnapshot(VIEWER, "all")).toBeNull()
  })

  it("returns null on a well-formed but wrongly-shaped payload", async () => {
    const { cache, presence } = present()
    await cache.set(snapshotKey(VIEWER, "all"), JSON.stringify([["id", "not-a-number"]]), 60)
    expect(await presence.readSnapshot(VIEWER, "all")).toBeNull()
  })

  it("advertises snapshots only when a cache is wired and the TTL knob is positive", () => {
    expect(present().presence.snapshotsAvailable).toBe(true)
    expect(present({ snapshotTtlSeconds: 0 }).presence.snapshotsAvailable).toBe(false)
    expect(makeFeedPresence({ config: CFG }).snapshotsAvailable).toBe(false)
  })

  it("writes nothing when the TTL knob is zero", async () => {
    const { cache, presence } = present({ snapshotTtlSeconds: 0 })
    await presence.writeSnapshot(VIEWER, "all", [{ id: POST, authorId: "a", score: 1 }])
    expect(await cache.get(snapshotKey(VIEWER, "all"))).toBeNull()
  })
})

describe("feed presence: served set and the seen signal", () => {
  it("reports only the ids this viewer was actually served", async () => {
    const { presence } = present()
    await presence.recordServed(VIEWER, [POST])
    const seen = await presence.seenBy(VIEWER, [POST, OTHER])
    expect([...seen]).toEqual([POST])
  })

  it("keeps served sets per viewer", async () => {
    const { presence } = present()
    await presence.recordServed(VIEWER, [POST])
    expect([...(await presence.seenBy(OTHER, [POST]))]).toEqual([])
  })

  function recordingCache(): { cache: FeedPresenceCache; expiries: Array<[string, number]> } {
    const expiries: Array<[string, number]> = []
    const inner = new InMemoryCacheClient(() => Date.now())
    return {
      expiries,
      cache: {
        get: (k) => inner.get(k),
        set: (k, v, ttl) => inner.set(k, v, ttl),
        sadd: (k, ...m) => inner.sadd(k, ...m),
        smembers: (k) => inner.smembers(k),
        smismember: (k, m) => inner.smismember(k, m),
        scard: (k) => inner.scard(k),
        expire: (k, ttl) => inner.expire(k, ttl),
        expireNx: (k, ttl) => {
          expiries.push([k, ttl])
          return inner.expireNx(k, ttl)
        },
      },
    }
  }

  it("puts a TTL on both the served set and the viewer index (no unbounded growth)", async () => {
    const { cache, expiries } = recordingCache()
    const presence = makeFeedPresence({ cache, config: CFG })
    await presence.recordServed(VIEWER, [POST, OTHER])

    expect(expiries).toEqual([
      [servedKey(VIEWER), CFG.servedTtlSeconds],
      [viewersKey(POST), CFG.servedTtlSeconds],
      [viewersKey(OTHER), CFG.servedTtlSeconds],
    ])
  })

  it("never refreshes the served-set TTL, so an active reader's key still expires", async () => {
    const clock = { now: 1_000_000 }
    const cache = new InMemoryCacheClient(() => clock.now)
    const presence = makeFeedPresence({ cache, config: CFG })

    await presence.recordServed(VIEWER, [POST])
    clock.now += (CFG.servedTtlSeconds - 1) * 1000
    await presence.recordServed(VIEWER, [OTHER])
    clock.now += 2000

    expect(await cache.scard(servedKey(VIEWER))).toBe(0)
    expect(await cache.scard(viewersKey(POST))).toBe(0)
  })

  it("reads the seen signal with a membership probe over the candidate ids, not a full set read", async () => {
    let smembersCalls = 0
    const inner = new InMemoryCacheClient(() => Date.now())
    const cache: FeedPresenceCache = {
      get: (k) => inner.get(k),
      set: (k, v, ttl) => inner.set(k, v, ttl),
      sadd: (k, ...m) => inner.sadd(k, ...m),
      smembers: (k) => {
        smembersCalls += 1
        return inner.smembers(k)
      },
      smismember: (k, m) => inner.smismember(k, m),
      scard: (k) => inner.scard(k),
      expire: (k, ttl) => inner.expire(k, ttl),
      expireNx: (k, ttl) => inner.expireNx(k, ttl),
    }
    const presence = makeFeedPresence({ cache, config: CFG })
    await presence.recordServed(VIEWER, [POST])

    expect([...(await presence.seenBy(VIEWER, [POST, OTHER]))]).toEqual([POST])
    expect(smembersCalls).toBe(0)
  })

  it("is a no-op for an empty page", async () => {
    const { cache, presence } = present()
    await presence.recordServed(VIEWER, [])
    expect(await cache.scard(servedKey(VIEWER))).toBe(0)
  })
})

describe("feed presence: viewer reverse index is bounded", () => {
  it("lists the viewers currently served a post", async () => {
    const { presence } = present()
    await presence.recordServed(VIEWER, [POST])
    await presence.recordServed(OTHER, [POST])
    expect((await presence.viewersOf(POST)).sort()).toEqual([VIEWER, OTHER].sort())
  })

  it("stops adding viewers once the cap is reached", async () => {
    const { cache, presence } = present({ viewerFanoutMax: 3 })
    for (let i = 0; i < 10; i += 1) {
      await presence.recordServed(`viewer-${i}`, [POST])
    }
    expect(await cache.scard(viewersKey(POST))).toBe(3)
  })

  it("returns nothing for a post with no live viewers", async () => {
    const { presence } = present()
    expect(await presence.viewersOf(POST)).toEqual([])
  })

  it("skips the fanout entirely when the set is over the cap, without reading it", async () => {
    let smembersCalls = 0
    const cache: FeedPresenceCache = {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      sadd: () => Promise.resolve(1),
      smembers: () => {
        smembersCalls += 1
        return Promise.resolve([])
      },
      smismember: () => Promise.resolve([]),
      scard: () => Promise.resolve(50_000),
      expire: () => Promise.resolve(),
      expireNx: () => Promise.resolve(),
    }
    const presence = makeFeedPresence({ cache, config: { ...CFG, viewerFanoutMax: 500 } })
    expect(await presence.viewersOf(POST)).toEqual([])
    expect(smembersCalls).toBe(0)
  })
})

describe("feed presence: degrades instead of failing the request", () => {
  const exploding: FeedPresenceCache = {
    get: () => Promise.reject(new Error("redis down")),
    set: () => Promise.reject(new Error("redis down")),
    sadd: () => Promise.reject(new Error("redis down")),
    smembers: () => Promise.reject(new Error("redis down")),
    smismember: () => Promise.reject(new Error("redis down")),
    scard: () => Promise.reject(new Error("redis down")),
    expire: () => Promise.reject(new Error("redis down")),
    expireNx: () => Promise.reject(new Error("redis down")),
  }

  it("swallows every Redis failure and returns the safe fallback", async () => {
    const warnings: unknown[] = []
    const presence = makeFeedPresence({
      cache: exploding,
      config: CFG,
      logger: { warn: (obj) => warnings.push(obj) },
    })
    expect(await presence.readSnapshot(VIEWER, "all")).toBeNull()
    await expect(
      presence.writeSnapshot(VIEWER, "all", [{ id: POST, authorId: "a", score: 1 }]),
    ).resolves.toBe(false)
    expect([...(await presence.seenBy(VIEWER, [POST]))]).toEqual([])
    await expect(presence.recordServed(VIEWER, [POST])).resolves.toBeUndefined()
    expect(await presence.viewersOf(POST)).toEqual([])
    expect(warnings.length).toBeGreaterThan(0)
  })

  it("is inert with no cache at all (fake/no-Redis mode)", async () => {
    const presence = makeFeedPresence({ config: CFG })
    expect(await presence.readSnapshot(VIEWER, "all")).toBeNull()
    expect([...(await presence.seenBy(VIEWER, [POST]))]).toEqual([])
    expect(await presence.viewersOf(POST)).toEqual([])
    await expect(presence.recordServed(VIEWER, [POST])).resolves.toBeUndefined()
  })
})
