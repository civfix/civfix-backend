import { describe, expect, it } from "vitest"
import { DEFAULT_FEED_RANKING, quantizeFeedScore } from "@civfix/contract"
import type { FeedRankingConfig, PostDTO } from "@civfix/contract"
import type { Sql } from "../../src/db/client.js"
import {
  applyCutoff,
  diversityMultiplier,
  rankCandidates,
  type FeedAuthorBoosts,
  type FeedCandidate,
} from "../../src/services/feed-ranking.js"
import { makePostService, type PostService } from "../../src/services/post-service.js"
import type {
  FeedCandidateRow,
  FeedFilter,
  PostRepository,
} from "../../src/services/post-repository.js"

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const P1 = "00000000-0000-4000-8000-000000000001"
const P2 = "00000000-0000-4000-8000-000000000002"
const ORIGINAL = "00000000-0000-4000-8000-000000000003"
const EVENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0)
const SEED = 0

const cfg: FeedRankingConfig = { ...DEFAULT_FEED_RANKING, jitterAmount: 0 }
const NONE: FeedAuthorBoosts = new Map()

function candidate(id: string, authorId: string, over: Partial<FeedCandidate> = {}): FeedCandidate {
  return {
    id,
    authorId,
    createdAtMs: NOW,
    likeCount: 0,
    replyCount: 0,
    repostCount: 0,
    hasMedia: false,
    hasReport: false,
    hasLiveEvent: false,
    authorFollowed: false,
    authorIsViewer: false,
    viewerMentioned: false,
    authorOrgVerified: false,
    distanceKm: null,
    alreadySeen: false,
    ...over,
  }
}

function unboostedScore(): number {
  const ranked = rankCandidates([candidate(P1, A), candidate(P2, B)], cfg, NOW, SEED, NONE)
  return ranked[0]!.score
}

describe("feed author boosts: ranking", () => {
  it("T10: two identical candidates without boosts tie on score and break on id", () => {
    const ranked = rankCandidates([candidate(P1, A), candidate(P2, B)], cfg, NOW, SEED, NONE)
    expect(ranked.map((entry) => entry.id)).toEqual([P2, P1])
    expect(ranked[0]!.score).toBe(ranked[1]!.score)
  })

  it("T11: a boosted author's post is multiplied by the boost and outranks its twin", () => {
    const s = unboostedScore()
    const ranked = rankCandidates(
      [candidate(P1, A), candidate(P2, B)],
      cfg,
      NOW,
      SEED,
      new Map([[A, 1.5]]),
    )
    expect(ranked.map((entry) => entry.id)).toEqual([P1, P2])
    expect(ranked[0]!.score).toBe(quantizeFeedScore(1.5 * s))
    expect(ranked[1]!.score).toBe(s)
  })

  it("T12: author diversity decay still applies after the boost", () => {
    const s = unboostedScore()
    const ranked = rankCandidates(
      [candidate(P1, A), candidate(P2, A)],
      cfg,
      NOW,
      SEED,
      new Map([[A, 2]]),
    )
    const first = quantizeFeedScore(2 * s)
    expect(ranked[0]!.score).toBe(first)
    expect(ranked[1]!.score).toBe(quantizeFeedScore(first * diversityMultiplier(1, cfg)))
  })

  it("T13: the minScore cutoff applies to the boosted score", () => {
    const s = unboostedScore()
    const cutoffCfg: FeedRankingConfig = { ...cfg, minScore: quantizeFeedScore(1.5 * s) }
    expect(s).toBeLessThan(cutoffCfg.minScore)
    const others = Array.from({ length: cutoffCfg.minPageItems }, (_, i) =>
      candidate(`00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`, `other-${i}`, {
        authorFollowed: true,
      }),
    )
    const kept = applyCutoff(
      rankCandidates(
        [candidate(P1, A), candidate(P2, B), ...others],
        cutoffCfg,
        NOW,
        SEED,
        new Map([[A, 1.5]]),
      ),
      cutoffCfg,
    ).map((entry) => entry.id)
    expect(kept).toContain(P1)
    expect(kept).not.toContain(P2)
  })
})

const throwingSql = (() => {
  throw new Error("sql must not be called in these unit paths")
}) as unknown as Sql

interface MemoryPost {
  row: FeedCandidateRow
  dto: PostDTO
  eventId: string | null
}

function dto(id: string, authorId: string, over: Partial<PostDTO> = {}): PostDTO {
  return {
    id,
    author: {
      id: authorId,
      name: "Author",
      handle: `author-${authorId.slice(0, 4)}`,
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
    ...over,
  }
}

function post(
  id: string,
  authorId: string,
  over: { eventId?: string; dto?: Partial<PostDTO> } = {},
): MemoryPost {
  const eventId = over.eventId ?? null
  return {
    row: {
      id,
      author_id: authorId,
      created_at: new Date(NOW),
      like_count: 0,
      reply_count: 0,
      repost_count: 0,
      has_report: false,
      has_live_event: eventId !== null,
      has_media: false,
      author_followed: false,
      author_is_viewer: false,
      viewer_mentioned: false,
      author_org_verified: false,
      distance_km: null,
    },
    dto: dto(id, authorId, over.dto),
    eventId,
  }
}

function memoryRepo(posts: readonly MemoryPost[]): PostRepository {
  const byId = new Map(posts.map((p) => [p.dto.id, p.dto]))
  const inFilter = (p: MemoryPost, filter: FeedFilter): boolean =>
    filter === "events" ? p.eventId !== null : filter === "fixes" ? false : true
  const unused = (): never => {
    throw new Error("not used by the ranked feed")
  }
  return {
    getPostBrief: unused,
    actorNameOf: unused,
    canPostAsOrganization: unused,
    isEventMember: unused,
    isReportAttachable: unused,
    createPost: unused,
    softDeletePost: unused,
    like: unused,
    unlike: unused,
    save: unused,
    unsave: unused,
    repost: unused,
    unrepost: unused,
    getPostDTO: unused,
    homeFeedChronological: unused,
    publicFeed: unused,
    feedCandidates: (args) =>
      Promise.resolve(posts.filter((p) => inFilter(p, args.filter)).map((p) => p.row)),
    hydrateByIds: (ids) => Promise.resolve(ids.map((id) => byId.get(id)!)),
    followerIdsOf: unused,
    readableCounts: unused,
    listReplies: unused,
    listUserPosts: unused,
    listSaves: unused,
  }
}

function service(posts: readonly MemoryPost[], boosts?: FeedAuthorBoosts): PostService {
  return makePostService({
    repo: memoryRepo(posts),
    sql: throwingSql,
    feedRanking: cfg,
    ...(boosts === undefined ? {} : { feedAuthorBoosts: boosts }),
    now: () => NOW,
  })
}

const twins = (): MemoryPost[] => [post(P1, A), post(P2, B)]
const boostA: FeedAuthorBoosts = new Map([[A, 1.5]])

describe("feed author boosts: home feed", () => {
  it("T14: a signed-in viewer sees the boosted author's post first", async () => {
    const page = await service(twins(), boostA).homeFeed(C, { filter: "all" })
    expect(page.items.map((item) => item.id)).toEqual([P1, P2])
  })

  it("T15: a guest sees the boosted author's post first", async () => {
    const page = await service(twins(), boostA).publicFeed({ filter: "all" })
    expect(page.items.map((item) => item.id)).toEqual([P1, P2])
  })

  it("T16: the events filter ranks the boosted author's post first", async () => {
    const posts = [post(P1, A, { eventId: EVENT }), post(P2, B, { eventId: EVENT })]
    const page = await service(posts, boostA).homeFeed(C, { filter: "events" })
    expect(page.items.map((item) => item.id)).toEqual([P1, P2])
  })

  it("T17: a boosted author's repost outranks an identical original by someone else", async () => {
    const posts = [
      post(P1, A, { dto: { kind: "repost", repostOf: { ...dto(ORIGINAL, C), excerpt: "hi" } } }),
      post(P2, B),
    ]
    const page = await service(posts, boostA).homeFeed(C, { filter: "all" })
    const ids = page.items.map((item) => item.id)
    expect(page.items.find((item) => item.id === P1)!.kind).toBe("repost")
    expect(ids.indexOf(P1)).toBeLessThan(ids.indexOf(P2))
  })

  it("T18: without boosts the order is unchanged", async () => {
    const page = await service(twins()).homeFeed(C, { filter: "all" })
    expect(page.items.map((item) => item.id)).toEqual([P2, P1])
  })
})
