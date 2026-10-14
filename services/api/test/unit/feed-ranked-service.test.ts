import { describe, expect, it } from "vitest"
import { DEFAULT_FEED_RANKING, formatFeedScoreCursor, parseFeedScoreCursor } from "@civfix/shared"
import type { FeedRankingConfig, PostDTO, UserSignal } from "@civfix/shared"
import type { UserChannel } from "@civfix/shared/interfaces"
import type { Sql } from "../../src/db/client.js"
import { makePostService, type PostService } from "../../src/services/post-service.js"
import { makeFeedPresence } from "../../src/services/feed-presence.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { NIL_VIEWER_ID } from "../../src/services/post-repository.drizzle.js"
import type {
  FeedCandidateRow,
  PostBrief,
  PostRepository,
} from "../../src/services/post-repository.js"

const VIEWER = "11111111-1111-1111-1111-111111111111"
const AUTHOR = "22222222-2222-2222-2222-222222222222"
const POST = "33333333-3333-3333-3333-333333333333"
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0)

const NO_JITTER: FeedRankingConfig = { ...DEFAULT_FEED_RANKING, jitterAmount: 0 }

const throwingSql = (() => {
  throw new Error("sql must not be called in these unit paths")
}) as unknown as Sql

function uuidAt(index: number): string {
  return `${String(index).padStart(8, "0")}-0000-0000-0000-000000000000`
}

function candidateRow(index: number, over: Partial<FeedCandidateRow> = {}): FeedCandidateRow {
  return {
    id: uuidAt(index),
    author_id: `author-${index}`,
    created_at: new Date(NOW - index * 3_600_000),
    like_count: index,
    reply_count: 0,
    repost_count: 0,
    has_report: false,
    has_live_event: false,
    has_media: false,
    author_followed: true,
    author_is_viewer: false,
    viewer_mentioned: false,
    author_org_verified: false,
    distance_km: null,
    ...over,
  }
}

function dto(id: string): PostDTO {
  return {
    id,
    author: {
      id: AUTHOR,
      name: "Author",
      handle: "author",
      bio: null,
      avatar: ["#000000", "#111111"],
      followers: 0,
      following: 0,
      isFollowing: false,
    },
    kind: "post",
    body: "hi",
    createdAt: new Date(NOW).toISOString(),
    editedAt: null,
    counts: { likes: 0, reposts: 0, replies: 0, saves: 0 },
    viewer: { liked: false, reposted: false, saved: false },
    media: [],
    mentions: [],
    event: null,
    report: null,
    repostOf: null,
    replyToId: null,
    threadRootId: null,
  }
}

function brief(over: Partial<PostBrief> = {}): PostBrief {
  return {
    id: POST,
    authorId: AUTHOR,
    kind: "post",
    replyToId: null,
    repostOfId: null,
    deletedAt: null,
    visibility: "public",
    ...over,
  }
}

function repoOver(over: Partial<PostRepository>): PostRepository {
  return {
    getPostBrief: () => Promise.resolve(brief()),
    actorNameOf: () => Promise.resolve("Actor"),
    canPostAsOrganization: () => Promise.resolve(true),
    isEventMember: () => Promise.resolve(true),
    isReportAttachable: () => Promise.resolve(true),
    createPost: () => Promise.resolve(POST),
    softDeletePost: () => Promise.resolve(),
    like: () => Promise.resolve(true),
    unlike: () => Promise.resolve(true),
    save: () => Promise.resolve(true),
    unsave: () => Promise.resolve(true),
    repost: (id: string) => Promise.resolve({ targetId: id, created: true }),
    unrepost: (id: string) => Promise.resolve({ targetId: id, removed: true }),
    getPostDTO: (id: string) => Promise.resolve(dto(id)),
    homeFeedChronological: () => Promise.resolve({ items: [], nextCursor: null }),
    publicFeed: () => Promise.resolve({ items: [], nextCursor: null }),
    feedCandidates: () => Promise.resolve([]),
    hydrateByIds: (ids: readonly string[]) => Promise.resolve(ids.map(dto)),
    followerIdsOf: () => Promise.resolve([]),
    readableCounts: () => Promise.resolve([]),
    listReplies: () => Promise.resolve({ items: [], nextCursor: null, authorReplies: [] }),
    listUserPosts: () => Promise.resolve({ items: [], nextCursor: null }),
    listSaves: () => Promise.resolve({ items: [], nextCursor: null }),
    ...over,
  }
}

function recordingChannel(): {
  channel: UserChannel
  sent: Array<{ users: string[]; signal: UserSignal }>
} {
  const sent: Array<{ users: string[]; signal: UserSignal }> = []
  const channel = {
    subscribeUser: () => Promise.resolve(() => Promise.resolve()),
    publishToUser: (userId: string, signal: UserSignal) => {
      sent.push({ users: [userId], signal })
      return Promise.resolve()
    },
    publishToUsers: (userIds: readonly string[], signal: UserSignal) => {
      sent.push({ users: [...userIds], signal })
      return Promise.resolve()
    },
  } as unknown as UserChannel
  return { channel, sent }
}

describe("ranked feed: cursor continuation covers every item exactly once", () => {
  const rows = Array.from({ length: 60 }, (_, i) => candidateRow(i + 1))

  function service(): PostService {
    const cache = new InMemoryCacheClient(() => Date.now())
    return makePostService({
      repo: repoOver({ feedCandidates: () => Promise.resolve(rows) }),
      sql: throwingSql,
      feedPresence: makeFeedPresence({ cache, config: DEFAULT_FEED_RANKING }),
      now: () => NOW,
    })
  }

  it("pages 1 -> 2 -> 3 with no duplicates and no gaps", async () => {
    const svc = service()
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0

    for (;;) {
      const page = await svc.homeFeed(VIEWER, {
        filter: "all",
        limit: 20,
        ...(cursor === undefined ? {} : { cursor }),
      })
      seen.push(...page.items.map((item) => item.id))
      pages += 1
      if (page.nextCursor === null) break
      cursor = page.nextCursor
      expect(pages).toBeLessThan(10)
    }

    expect(pages).toBe(3)
    expect(seen).toHaveLength(60)
    expect(new Set(seen).size).toBe(60)
  })

  it("emits a parseable score cursor whose score matches the last served item", async () => {
    const svc = service()
    const page = await svc.homeFeed(VIEWER, { filter: "all", limit: 20 })
    const cursor = parseFeedScoreCursor(page.nextCursor)
    expect(cursor).not.toBeNull()
    expect(cursor!.postId).toBe(page.items[page.items.length - 1]!.id)
  })

  it("returns nextCursor null once the ranked set is exhausted", async () => {
    const svc = service()
    let cursor: string | undefined
    let last: string | null = "seed"
    for (let i = 0; i < 3; i += 1) {
      const page: { items: PostDTO[]; nextCursor: string | null } = await svc.homeFeed(VIEWER, {
        filter: "all",
        limit: 20,
        ...(cursor === undefined ? {} : { cursor }),
      })
      last = page.nextCursor
      if (page.nextCursor !== null) cursor = page.nextCursor
    }
    expect(last).toBeNull()
  })

  it("keeps the continuation strictly after the cursor under the repository ordering", async () => {
    const svc = service()
    const first = await svc.homeFeed(VIEWER, { filter: "all", limit: 20 })
    const second = await svc.homeFeed(VIEWER, {
      filter: "all",
      limit: 20,
      cursor: first.nextCursor!,
    })
    const firstIds = new Set(first.items.map((item) => item.id))
    expect(second.items.some((item) => firstIds.has(item.id))).toBe(false)
  })
})

describe("ranked feed: a cursor is hex, and hex has no case", () => {
  const rows = Array.from({ length: 60 }, (_, i) =>
    candidateRow(i + 1, {
      id: `ab0000${String(i + 1).padStart(2, "0")}-0000-0000-0000-000000000000`,
      author_id: `author-${i}`,
      like_count: 0,
      created_at: new Date(NOW),
    }),
  )

  function service(): PostService {
    const cache = new InMemoryCacheClient(() => Date.now())
    return makePostService({
      repo: repoOver({ feedCandidates: () => Promise.resolve(rows) }),
      sql: throwingSql,
      feedPresence: makeFeedPresence({ cache, config: NO_JITTER }),
      feedRanking: NO_JITTER,
      now: () => NOW,
    })
  }

  it("resolves an upper-cased cursor against the lower-cased snapshot ids", async () => {
    const svc = service()
    const first = await svc.homeFeed(VIEWER, { filter: "all", limit: 20 })
    const parsed = parseFeedScoreCursor(first.nextCursor)!
    expect(parsed.postId.toUpperCase()).not.toBe(parsed.postId)

    const shouted = formatFeedScoreCursor({
      score: parsed.score,
      postId: parsed.postId.toUpperCase(),
    })
    const second = await svc.homeFeed(VIEWER, { filter: "all", limit: 20, cursor: shouted })
    const exact = await svc.homeFeed(VIEWER, {
      filter: "all",
      limit: 20,
      cursor: first.nextCursor!,
    })

    expect(second.items).toHaveLength(20)
    expect(second.items.map((item) => item.id)).toEqual(exact.items.map((item) => item.id))
  })
})

describe("ranked feed: warm snapshot continues a cursor without re-ranking", () => {
  const rows = Array.from({ length: 60 }, (_, i) => candidateRow(i + 1))

  function harness(config: FeedRankingConfig = DEFAULT_FEED_RANKING) {
    const cache = new InMemoryCacheClient(() => Date.now())
    const presence = makeFeedPresence({ cache, config })
    let candidateQueries = 0
    const svc = makePostService({
      repo: repoOver({
        feedCandidates: () => {
          candidateQueries += 1
          return Promise.resolve(rows)
        },
      }),
      sql: throwingSql,
      feedPresence: presence,
      feedRanking: config,
      now: () => NOW,
    })
    return { svc, presence, candidateQueries: () => candidateQueries }
  }

  it("re-ranks on page 1 and slices the snapshot on page 2", async () => {
    const { svc, candidateQueries } = harness()
    const first = await svc.homeFeed(VIEWER, { filter: "all", limit: 20 })
    expect(candidateQueries()).toBe(1)

    const second = await svc.homeFeed(VIEWER, {
      filter: "all",
      limit: 20,
      cursor: first.nextCursor!,
    })
    expect(candidateQueries()).toBe(1)
    expect(second.items).toHaveLength(20)

    const firstIds = new Set(first.items.map((item) => item.id))
    expect(second.items.some((item) => firstIds.has(item.id))).toBe(false)
  })

  it("re-ranks rather than ending the feed when the snapshot has expired under a dwelling reader", async () => {
    const { svc } = harness(NO_JITTER)
    const first = await svc.homeFeed(VIEWER, { filter: "all", limit: 20 })

    const expired = makePostService({
      repo: repoOver({ feedCandidates: () => Promise.resolve(rows) }),
      sql: throwingSql,
      feedPresence: makeFeedPresence({
        cache: new InMemoryCacheClient(() => Date.now()),
        config: NO_JITTER,
      }),
      feedRanking: NO_JITTER,
      now: () => NOW,
    })
    const page = await expired.homeFeed(VIEWER, {
      filter: "all",
      limit: 20,
      cursor: first.nextCursor!,
    })

    const firstIds = new Set(first.items.map((item) => item.id))
    expect(page.items).toHaveLength(20)
    expect(page.items.some((item) => firstIds.has(item.id))).toBe(false)
    expect(page.nextCursor).not.toBeNull()
  })

  it("rebuilds the snapshot on the re-ranked continuation so the next page is served from cache", async () => {
    const { svc } = harness(NO_JITTER)
    const first = await svc.homeFeed(VIEWER, { filter: "all", limit: 20 })

    const cache = new InMemoryCacheClient(() => Date.now())
    const presence = makeFeedPresence({ cache, config: NO_JITTER })
    let candidateQueries = 0
    const expired = makePostService({
      repo: repoOver({
        feedCandidates: () => {
          candidateQueries += 1
          return Promise.resolve(rows)
        },
      }),
      sql: throwingSql,
      feedPresence: presence,
      feedRanking: NO_JITTER,
      now: () => NOW,
    })

    const second = await expired.homeFeed(VIEWER, {
      filter: "all",
      limit: 20,
      cursor: first.nextCursor!,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const third = await expired.homeFeed(VIEWER, {
      filter: "all",
      limit: 20,
      cursor: second.nextCursor!,
    })

    expect(candidateQueries).toBe(1)
    expect(third.items).toHaveLength(20)
  })

  it("re-ranking a moved clock never re-serves a page-1 item", async () => {
    const { svc } = harness(NO_JITTER)
    const first = await svc.homeFeed(VIEWER, { filter: "all", limit: 20 })

    const later = makePostService({
      repo: repoOver({ feedCandidates: () => Promise.resolve(rows) }),
      sql: throwingSql,
      feedPresence: makeFeedPresence({
        cache: new InMemoryCacheClient(() => Date.now()),
        config: NO_JITTER,
      }),
      feedRanking: NO_JITTER,
      now: () => NOW + 10 * 60_000,
    })
    const page = await later.homeFeed(VIEWER, {
      filter: "all",
      limit: 20,
      cursor: first.nextCursor!,
    })

    const firstIds = new Set(first.items.map((item) => item.id))
    expect(page.items.some((item) => firstIds.has(item.id))).toBe(false)
  })

  it("keys the snapshot per filter, so the events tab re-ranks instead of slicing the all tab's page", async () => {
    const filters: string[] = []
    const cache = new InMemoryCacheClient(() => Date.now())
    const svc = makePostService({
      repo: repoOver({
        feedCandidates: (feedArgs: { filter: string }) => {
          filters.push(feedArgs.filter)
          return Promise.resolve(rows)
        },
      }),
      sql: throwingSql,
      feedPresence: makeFeedPresence({ cache, config: DEFAULT_FEED_RANKING }),
      now: () => NOW,
    })

    const first = await svc.homeFeed(VIEWER, { filter: "all", limit: 20 })
    await svc.homeFeed(VIEWER, { filter: "events", limit: 20, cursor: first.nextCursor! })

    expect(filters).toEqual(["all", "events"])
  })

  it("keeps an active scroll alive by refreshing the snapshot TTL", async () => {
    const touched: string[] = []
    const cache = new InMemoryCacheClient(() => Date.now())
    const presence = makeFeedPresence({ cache, config: DEFAULT_FEED_RANKING })
    const spied = {
      ...presence,
      touchSnapshot: (userId: string, filter: string) => {
        touched.push(`${userId}:${filter}`)
        return presence.touchSnapshot(userId, filter)
      },
    }
    const svc = makePostService({
      repo: repoOver({ feedCandidates: () => Promise.resolve(rows) }),
      sql: throwingSql,
      feedPresence: spied,
      now: () => NOW,
    })
    const first = await svc.homeFeed(VIEWER, { filter: "all", limit: 20 })
    await svc.homeFeed(VIEWER, { filter: "all", limit: 20, cursor: first.nextCursor! })
    expect(touched).toEqual([`${VIEWER}:all`])
  })
})

describe("ranked feed: no Redis is a slower feed, not a one-page feed", () => {
  const rows = Array.from({ length: 60 }, (_, i) => candidateRow(i + 1))

  it.each([
    ["no cache wired at all", makeFeedPresence({ config: DEFAULT_FEED_RANKING })],
    [
      "snapshots switched off by the TTL knob",
      makeFeedPresence({
        cache: new InMemoryCacheClient(() => Date.now()),
        config: { ...DEFAULT_FEED_RANKING, snapshotTtlSeconds: 0 },
      }),
    ],
  ])("pages an authenticated feed past page 1 with %s", async (_label, presence) => {
    expect(presence.snapshotsAvailable).toBe(false)
    const svc = makePostService({
      repo: repoOver({ feedCandidates: () => Promise.resolve(rows) }),
      sql: throwingSql,
      feedPresence: presence,
      now: () => NOW,
    })

    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 5; page += 1) {
      const result = await svc.homeFeed(VIEWER, {
        filter: "all",
        limit: 20,
        ...(cursor === undefined ? {} : { cursor }),
      })
      seen.push(...result.items.map((item) => item.id))
      if (result.nextCursor === null) break
      cursor = result.nextCursor
    }

    expect(seen).toHaveLength(60)
    expect(new Set(seen).size).toBe(60)
  })
})

describe("ranked feed: a signed-out reader keeps scrolling", () => {
  const rows = Array.from({ length: 60 }, (_, i) => candidateRow(i + 1, { author_followed: false }))

  function guestService(
    presence?: ReturnType<typeof makeFeedPresence>,
    config: FeedRankingConfig = DEFAULT_FEED_RANKING,
  ): PostService {
    return makePostService({
      repo: repoOver({ feedCandidates: () => Promise.resolve(rows) }),
      sql: throwingSql,
      ...(presence === undefined ? {} : { feedPresence: presence }),
      feedRanking: config,
      now: () => NOW,
    })
  }

  it("pages the anonymous feed past page 1 and terminates without duplicates", async () => {
    const svc = guestService()
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0

    for (;;) {
      const page = await svc.publicFeed({
        filter: "all",
        limit: 20,
        ...(cursor === undefined ? {} : { cursor }),
      })
      seen.push(...page.items.map((item) => item.id))
      pages += 1
      if (page.nextCursor === null) break
      cursor = page.nextCursor
      expect(pages).toBeLessThan(10)
    }

    expect(pages).toBeGreaterThan(1)
    expect(seen.length).toBeGreaterThan(20)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it("keeps a guest continuation stable across a clock bucket boundary", async () => {
    const first = await guestService(undefined, NO_JITTER).publicFeed({ filter: "all", limit: 20 })
    const later = makePostService({
      repo: repoOver({ feedCandidates: () => Promise.resolve(rows) }),
      sql: throwingSql,
      feedRanking: NO_JITTER,
      now: () => NOW + 5 * 60_000,
    })
    const second = await later.publicFeed({ filter: "all", limit: 20, cursor: first.nextCursor! })

    const firstIds = new Set(first.items.map((item) => item.id))
    expect(second.items.length).toBeGreaterThan(0)
    expect(second.items.some((item) => firstIds.has(item.id))).toBe(false)
  })

  it("keys the guest shuffle to the shared public bucket, not to a viewer id", async () => {
    const first = await guestService().publicFeed({ filter: "all", limit: 20 })
    const again = await guestService().publicFeed({ filter: "all", limit: 20 })
    expect(again.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id))

    const seen: string[] = []
    let cursor: string | undefined = first.nextCursor ?? undefined
    seen.push(...first.items.map((item) => item.id))
    while (cursor !== undefined) {
      const page: { items: PostDTO[]; nextCursor: string | null } = await guestService().publicFeed(
        {
          filter: "all",
          limit: 20,
          cursor,
        },
      )
      seen.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor ?? undefined
    }
    expect(new Set(seen).size).toBe(seen.length)
  })

  it("never writes a guest into the shared presence keys", async () => {
    const cache = new InMemoryCacheClient(() => Date.now())
    const presence = makeFeedPresence({ cache, config: DEFAULT_FEED_RANKING })
    const page = await guestService(presence).publicFeed({ filter: "all", limit: 20 })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(page.items).toHaveLength(20)
    expect(await presence.readSnapshot(NIL_VIEWER_ID, "all")).toBeNull()
    expect(await presence.viewersOf(page.items[0]!.id)).toEqual([])
  })
})

describe("ranked feed: the cold-start leniency pages to exhaustion, it does not dead-end", () => {
  const rows = Array.from({ length: 40 }, (_, i) =>
    candidateRow(i + 1, { author_followed: false, like_count: 0, created_at: new Date(NOW) }),
  )

  function service(): { svc: PostService; presence: ReturnType<typeof makeFeedPresence> } {
    const cache = new InMemoryCacheClient(() => Date.now())
    const presence = makeFeedPresence({ cache, config: NO_JITTER })
    const svc = makePostService({
      repo: repoOver({ feedCandidates: () => Promise.resolve(rows) }),
      sql: throwingSql,
      feedPresence: presence,
      feedRanking: NO_JITTER,
      now: () => NOW,
    })
    return { svc, presence }
  }

  it("snapshots the same lenient list it served, so the page-1 cursor resolves", async () => {
    const { svc, presence } = service()
    const first = await svc.homeFeed(VIEWER, { filter: "all", limit: 20 })

    expect(first.items).toHaveLength(20)
    const snapshot = await presence.readSnapshot(VIEWER, "all")
    expect(snapshot).toHaveLength(40)

    const cursor = parseFeedScoreCursor(first.nextCursor)
    expect(cursor).not.toBeNull()
    expect(snapshot!.some((entry) => entry.id === cursor!.postId)).toBe(true)
  })

  it("pages every lenient item exactly once instead of ending at page 1", async () => {
    const { svc } = service()
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0

    for (;;) {
      const page = await svc.homeFeed(VIEWER, {
        filter: "all",
        limit: 20,
        ...(cursor === undefined ? {} : { cursor }),
      })
      seen.push(...page.items.map((item) => item.id))
      pages += 1
      if (page.nextCursor === null) break
      cursor = page.nextCursor
      expect(pages).toBeLessThan(10)
    }

    expect(pages).toBe(2)
    expect(seen).toHaveLength(40)
    expect(new Set(seen).size).toBe(40)
  })

  it("keeps the re-ranked continuation lenient too, so an expired snapshot still pages", async () => {
    const first = await service().svc.homeFeed(VIEWER, { filter: "all", limit: 20 })

    const expired = makePostService({
      repo: repoOver({ feedCandidates: () => Promise.resolve(rows) }),
      sql: throwingSql,
      feedPresence: makeFeedPresence({
        cache: new InMemoryCacheClient(() => Date.now()),
        config: NO_JITTER,
      }),
      feedRanking: NO_JITTER,
      now: () => NOW,
    })
    const second = await expired.homeFeed(VIEWER, {
      filter: "all",
      limit: 20,
      cursor: first.nextCursor!,
    })

    expect(second.items).toHaveLength(20)
  })
})

describe("ranked feed: a page-1 snapshot that cannot be stored is served reproducibly", () => {
  const rows = Array.from({ length: 60 }, (_, i) =>
    candidateRow(i + 1, { like_count: 0, created_at: new Date(NOW), author_id: `author-${i}` }),
  )

  function bucketOrderService(): PostService {
    return makePostService({
      repo: repoOver({ feedCandidates: () => Promise.resolve(rows) }),
      sql: throwingSql,
      feedPresence: makeFeedPresence({ config: DEFAULT_FEED_RANKING }),
      now: () => NOW,
    })
  }

  function failingSnapshotService(warnings: unknown[]): PostService {
    const base = makeFeedPresence({
      cache: new InMemoryCacheClient(() => Date.now()),
      config: DEFAULT_FEED_RANKING,
    })
    return makePostService({
      repo: repoOver({ feedCandidates: () => Promise.resolve(rows) }),
      sql: throwingSql,
      feedPresence: { ...base, writeSnapshot: () => Promise.reject(new Error("redis down")) },
      feedRanking: DEFAULT_FEED_RANKING,
      now: () => NOW,
      feedSeed: () => 4242,
      logger: { warn: (obj) => warnings.push(obj) },
    })
  }

  it("serves the order a later fallback recompute reproduces in the same bucket", async () => {
    const warnings: unknown[] = []
    const served = await failingSnapshotService(warnings).homeFeed(VIEWER, {
      filter: "all",
      limit: 20,
    })
    const fallback = await bucketOrderService().homeFeed(VIEWER, { filter: "all", limit: 20 })

    expect(served.items.map((item) => item.id)).toEqual(fallback.items.map((item) => item.id))
    expect(warnings).toHaveLength(1)
  })

  it("still serves the minted shuffle when the snapshot write succeeds", async () => {
    const svc = makePostService({
      repo: repoOver({ feedCandidates: () => Promise.resolve(rows) }),
      sql: throwingSql,
      feedPresence: makeFeedPresence({
        cache: new InMemoryCacheClient(() => Date.now()),
        config: DEFAULT_FEED_RANKING,
      }),
      now: () => NOW,
      feedSeed: () => 4242,
    })
    const minted = await svc.homeFeed(VIEWER, { filter: "all", limit: 20 })
    const fallback = await bucketOrderService().homeFeed(VIEWER, { filter: "all", limit: 20 })

    expect(minted.items.map((item) => item.id)).not.toEqual(fallback.items.map((item) => item.id))
  })

  it("continues the fallback page from its own cursor without repeating an item", async () => {
    const first = await failingSnapshotService([]).homeFeed(VIEWER, { filter: "all", limit: 20 })
    const second = await bucketOrderService().homeFeed(VIEWER, {
      filter: "all",
      limit: 20,
      cursor: first.nextCursor!,
    })

    const firstIds = new Set(first.items.map((item) => item.id))
    expect(second.items).toHaveLength(20)
    expect(second.items.some((item) => firstIds.has(item.id))).toBe(false)
  })
})

describe("ranked feed: served set feeds the seen discount", () => {
  it("records the served page so the next refresh demotes what was already read", async () => {
    const cache = new InMemoryCacheClient(() => Date.now())
    const presence = makeFeedPresence({ cache, config: DEFAULT_FEED_RANKING })
    const rows = Array.from({ length: 5 }, (_, i) => candidateRow(i + 1))
    const svc = makePostService({
      repo: repoOver({ feedCandidates: () => Promise.resolve(rows) }),
      sql: throwingSql,
      feedPresence: presence,
      now: () => NOW,
    })

    const page = await svc.homeFeed(VIEWER, { filter: "all", limit: 20 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const served = await presence.seenBy(
      VIEWER,
      rows.map((r) => r.id),
    )
    expect(served.size).toBe(page.items.length)
  })

  it("never applies the discount to a re-ranked continuation, which would reshuffle the cursor", async () => {
    const cache = new InMemoryCacheClient(() => Date.now())
    const base = makeFeedPresence({
      cache,
      config: { ...DEFAULT_FEED_RANKING, snapshotTtlSeconds: 0 },
    })
    const lookups: string[] = []
    const presence = {
      ...base,
      seenBy: (userId: string, postIds: readonly string[]) => {
        lookups.push(userId)
        return base.seenBy(userId, postIds)
      },
    }
    const rows = Array.from({ length: 60 }, (_, i) => candidateRow(i + 1))
    const svc = makePostService({
      repo: repoOver({ feedCandidates: () => Promise.resolve(rows) }),
      sql: throwingSql,
      feedPresence: presence,
      now: () => NOW,
    })

    const first = await svc.homeFeed(VIEWER, { filter: "all", limit: 20 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await svc.homeFeed(VIEWER, { filter: "all", limit: 20, cursor: first.nextCursor! })

    expect(lookups).toEqual([VIEWER])
  })
})

describe("ranked feed: a refresh reshuffles the near-ties, a cursor page never does", () => {
  const rows = Array.from({ length: 60 }, (_, i) =>
    candidateRow(i + 1, { like_count: 0, created_at: new Date(NOW), author_id: `author-${i}` }),
  )

  function seededService(seed: number) {
    const cache = new InMemoryCacheClient(() => Date.now())
    const presence = makeFeedPresence({ cache, config: DEFAULT_FEED_RANKING })
    const svc = makePostService({
      repo: repoOver({ feedCandidates: () => Promise.resolve(rows) }),
      sql: throwingSql,
      feedPresence: presence,
      now: () => NOW,
      feedSeed: () => seed,
    })
    return { svc, presence }
  }

  it("hands two refreshes with different seeds two different orders", async () => {
    const a = await seededService(11).svc.homeFeed(VIEWER, { filter: "all", limit: 20 })
    const b = await seededService(22).svc.homeFeed(VIEWER, { filter: "all", limit: 20 })

    expect(a.items.map((item) => item.id)).not.toEqual(b.items.map((item) => item.id))
    expect(a.items).toHaveLength(20)
    expect(b.items).toHaveLength(20)
  })

  it("reproduces the same first page for the same minted seed", async () => {
    const a = await seededService(11).svc.homeFeed(VIEWER, { filter: "all", limit: 20 })
    const b = await seededService(11).svc.homeFeed(VIEWER, { filter: "all", limit: 20 })
    expect(a.items.map((item) => item.id)).toEqual(b.items.map((item) => item.id))
  })

  it("mints the seed once per first-page request, never per candidate", async () => {
    let mints = 0
    const cache = new InMemoryCacheClient(() => Date.now())
    const svc = makePostService({
      repo: repoOver({ feedCandidates: () => Promise.resolve(rows) }),
      sql: throwingSql,
      feedPresence: makeFeedPresence({ cache, config: DEFAULT_FEED_RANKING }),
      now: () => NOW,
      feedSeed: () => {
        mints += 1
        return 7
      },
    })

    const first = await svc.homeFeed(VIEWER, { filter: "all", limit: 20 })
    expect(mints).toBe(1)

    await svc.homeFeed(VIEWER, { filter: "all", limit: 20, cursor: first.nextCursor! })
    expect(mints).toBe(1)
  })

  it("pages a jittered snapshot end to end with no duplicates and no holes", async () => {
    const { svc } = seededService(99)
    const seen: string[] = []
    let cursor: string | undefined

    for (let page = 0; page < 6; page += 1) {
      const result = await svc.homeFeed(VIEWER, {
        filter: "all",
        limit: 20,
        ...(cursor === undefined ? {} : { cursor }),
      })
      seen.push(...result.items.map((item) => item.id))
      if (result.nextCursor === null) break
      cursor = result.nextCursor
    }

    expect(seen).toHaveLength(60)
    expect(new Set(seen).size).toBe(60)
  })

  it("falls back to a deterministic seed when no snapshot can carry the minted one", async () => {
    let mints = 0
    function noSnapshotService() {
      return makePostService({
        repo: repoOver({ feedCandidates: () => Promise.resolve(rows) }),
        sql: throwingSql,
        feedPresence: makeFeedPresence({ config: DEFAULT_FEED_RANKING }),
        now: () => NOW,
        feedSeed: () => {
          mints += 1
          return mints
        },
      })
    }

    const first = await noSnapshotService().homeFeed(VIEWER, { filter: "all", limit: 20 })
    const again = await noSnapshotService().homeFeed(VIEWER, { filter: "all", limit: 20 })

    expect(mints).toBe(0)
    expect(again.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id))
  })

  it("agrees between two fallback recomputations inside the same clock bucket", async () => {
    function fallbackService(atMs: number) {
      return makePostService({
        repo: repoOver({ feedCandidates: () => Promise.resolve(rows) }),
        sql: throwingSql,
        feedPresence: makeFeedPresence({ config: DEFAULT_FEED_RANKING }),
        now: () => atMs,
      })
    }

    const first = await fallbackService(NOW + 1_000).homeFeed(VIEWER, { filter: "all", limit: 20 })
    const second = await fallbackService(NOW + 55_000).homeFeed(VIEWER, {
      filter: "all",
      limit: 20,
      cursor: first.nextCursor!,
    })
    const third = await fallbackService(NOW + 30_000).homeFeed(VIEWER, {
      filter: "all",
      limit: 20,
      cursor: first.nextCursor!,
    })

    expect(second.items.map((item) => item.id)).toEqual(third.items.map((item) => item.id))
    const firstIds = new Set(first.items.map((item) => item.id))
    expect(second.items.some((item) => firstIds.has(item.id))).toBe(false)
  })

  it("gives two viewers different shuffles of the same candidate set", async () => {
    const other = "99999999-9999-9999-9999-999999999999"
    const svc = makePostService({
      repo: repoOver({ feedCandidates: () => Promise.resolve(rows) }),
      sql: throwingSql,
      feedPresence: makeFeedPresence({ config: DEFAULT_FEED_RANKING }),
      now: () => NOW,
    })

    const mine = await svc.homeFeed(VIEWER, { filter: "all", limit: 20 })
    const theirs = await svc.homeFeed(other, { filter: "all", limit: 20 })
    expect(mine.items.map((item) => item.id)).not.toEqual(theirs.items.map((item) => item.id))
  })
})

describe("ranked feed: realtime fanout never blocks the request path", () => {
  it("publishes topic feed to the author's followers on a new top-level post", async () => {
    const { channel, sent } = recordingChannel()
    const svc = makePostService({
      repo: repoOver({ followerIdsOf: () => Promise.resolve(["f1", "f2"]) }),
      sql: throwingSql,
      userChannel: channel,
    })
    await svc.createPost(
      { kind: "post", body: "hello", mediaUploadIds: [], mentionedUserIds: [] } as never,
      AUTHOR,
    )
    expect(sent.flatMap((s) => s.users)).toEqual(["f1", "f2"])
    expect(sent.every((s) => s.signal.topic === "feed" && s.signal.id === POST)).toBe(true)
  })

  it("publishes topic feed_counts to the post's live viewers on a like", async () => {
    const { channel, sent } = recordingChannel()
    const cache = new InMemoryCacheClient(() => Date.now())
    const presence = makeFeedPresence({ cache, config: DEFAULT_FEED_RANKING })
    await presence.recordServed("reader-1", [POST])
    await presence.recordServed("reader-2", [POST])

    const svc = makePostService({
      repo: repoOver({}),
      sql: throwingSql,
      userChannel: channel,
      feedPresence: presence,
    })
    await svc.likePost(POST, VIEWER)

    expect(sent.every((s) => s.signal.topic === "feed_counts" && s.signal.id === POST)).toBe(true)
    expect(sent.flatMap((s) => s.users).sort()).toEqual(["reader-1", "reader-2"])
  })

  it("excludes the acting user, whose own client already patched optimistically", async () => {
    const { channel, sent } = recordingChannel()
    const cache = new InMemoryCacheClient(() => Date.now())
    const presence = makeFeedPresence({ cache, config: DEFAULT_FEED_RANKING })
    await presence.recordServed(VIEWER, [POST])
    await presence.recordServed("reader-1", [POST])

    const svc = makePostService({
      repo: repoOver({}),
      sql: throwingSql,
      userChannel: channel,
      feedPresence: presence,
    })
    await svc.likePost(POST, VIEWER)

    expect(sent.flatMap((s) => s.users)).toEqual(["reader-1"])
  })

  it("publishes feed_counts on an unlike and an unrepost, so decrements reach viewers", async () => {
    const { channel, sent } = recordingChannel()
    const cache = new InMemoryCacheClient(() => Date.now())
    const presence = makeFeedPresence({ cache, config: DEFAULT_FEED_RANKING })
    await presence.recordServed("reader-1", [POST])

    const svc = makePostService({
      repo: repoOver({}),
      sql: throwingSql,
      userChannel: channel,
      feedPresence: presence,
    })
    await svc.unlikePost(POST, VIEWER)
    await svc.unrepostPost(POST, VIEWER)

    expect(sent).toHaveLength(2)
    expect(sent.every((s) => s.signal.topic === "feed_counts" && s.signal.id === POST)).toBe(true)
  })

  it("does not publish an unlike that removed nothing", async () => {
    const { channel, sent } = recordingChannel()
    const cache = new InMemoryCacheClient(() => Date.now())
    const presence = makeFeedPresence({ cache, config: DEFAULT_FEED_RANKING })
    await presence.recordServed("reader-1", [POST])

    const svc = makePostService({
      repo: repoOver({ unlike: () => Promise.resolve(false) }),
      sql: throwingSql,
      userChannel: channel,
      feedPresence: presence,
    })
    await svc.unlikePost(POST, VIEWER)
    expect(sent).toHaveLength(0)
  })

  it("announces the reply count against the resolved parent, not the repost that was replied to", async () => {
    const { channel, sent } = recordingChannel()
    const ORIGINAL = "44444444-4444-4444-4444-444444444444"
    const REPOST = "55555555-5555-5555-5555-555555555555"
    const cache = new InMemoryCacheClient(() => Date.now())
    const presence = makeFeedPresence({ cache, config: DEFAULT_FEED_RANKING })
    await presence.recordServed("reader-1", [ORIGINAL, REPOST])

    const svc = makePostService({
      repo: repoOver({
        getPostBrief: (id: string) =>
          Promise.resolve(
            id === REPOST
              ? brief({ id: REPOST, kind: "repost", repostOfId: ORIGINAL })
              : brief({ id: ORIGINAL }),
          ),
      }),
      sql: throwingSql,
      userChannel: channel,
      feedPresence: presence,
    })

    await svc.createPost(
      {
        kind: "post",
        body: "reply",
        replyToId: REPOST,
        mediaUploadIds: [],
        mentionedUserIds: [],
      } as never,
      VIEWER,
    )

    expect(sent.map((s) => s.signal.id)).toEqual([ORIGINAL])
  })

  it("does not publish when the interaction was a no-op (double like)", async () => {
    const { channel, sent } = recordingChannel()
    const cache = new InMemoryCacheClient(() => Date.now())
    const presence = makeFeedPresence({ cache, config: DEFAULT_FEED_RANKING })
    await presence.recordServed("reader-1", [POST])

    const svc = makePostService({
      repo: repoOver({ like: () => Promise.resolve(false) }),
      sql: throwingSql,
      userChannel: channel,
      feedPresence: presence,
    })
    await svc.likePost(POST, VIEWER)
    expect(sent).toHaveLength(0)
  })

  it("a rejecting channel does not fail likePost", async () => {
    const warnings: unknown[] = []
    const cache = new InMemoryCacheClient(() => Date.now())
    const presence = makeFeedPresence({ cache, config: DEFAULT_FEED_RANKING })
    await presence.recordServed("reader-1", [POST])
    const channel = {
      subscribeUser: () => Promise.resolve(() => Promise.resolve()),
      publishToUser: () => Promise.reject(new Error("redis down")),
      publishToUsers: () => Promise.reject(new Error("redis down")),
    } as unknown as UserChannel

    const svc = makePostService({
      repo: repoOver({}),
      sql: throwingSql,
      userChannel: channel,
      feedPresence: presence,
      logger: { warn: (obj) => warnings.push(obj) },
    })

    await expect(svc.likePost(POST, VIEWER)).resolves.toMatchObject({ id: POST })
    await Promise.resolve()
    expect(warnings.length).toBeGreaterThan(0)
  })

  it("a throwing follower lookup does not fail createPost", async () => {
    const { channel, sent } = recordingChannel()
    const svc = makePostService({
      repo: repoOver({ followerIdsOf: () => Promise.reject(new Error("db down")) }),
      sql: throwingSql,
      userChannel: channel,
      logger: { warn: () => {} },
    })
    await expect(
      svc.createPost(
        { kind: "post", body: "hello", mediaUploadIds: [], mentionedUserIds: [] } as never,
        AUTHOR,
      ),
    ).resolves.toMatchObject({ id: POST })
    expect(sent).toHaveLength(0)
  })

  it("publishes nothing at all in fake mode (no user channel wired)", async () => {
    const cache = new InMemoryCacheClient(() => Date.now())
    const presence = makeFeedPresence({ cache, config: DEFAULT_FEED_RANKING })
    await presence.recordServed("reader-1", [POST])
    let followerLookups = 0
    const svc = makePostService({
      repo: repoOver({
        followerIdsOf: () => {
          followerLookups += 1
          return Promise.resolve(["f1"])
        },
      }),
      sql: throwingSql,
      feedPresence: presence,
    })
    await svc.likePost(POST, VIEWER)
    await svc.createPost(
      { kind: "post", body: "hello", mediaUploadIds: [], mentionedUserIds: [] } as never,
      AUTHOR,
    )
    expect(followerLookups).toBe(0)
  })
})
