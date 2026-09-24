import { describe, expect, it } from "vitest"
import { DEFAULT_FEED_RANKING } from "@civfix/shared"
import type { FeedRankingConfig, PostDTO, UserSignal } from "@civfix/shared"
import type { UserChannel } from "@civfix/shared/interfaces"
import type { Sql } from "../../src/db/client.js"
import { makePostService } from "../../src/services/post-service.js"
import { makeFeedPresence } from "../../src/services/feed-presence.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import type {
  FeedCandidateRow,
  PostBrief,
  PostRepository,
} from "../../src/services/post-repository.drizzle.js"

const VIEWER = "11111111-1111-1111-1111-111111111111"
const LIKER = "22222222-2222-2222-2222-222222222222"
const AUTHOR = "33333333-3333-3333-3333-333333333333"
const SHELL = "44444444-4444-4444-4444-444444444444"
const TARGET = "55555555-5555-5555-5555-555555555555"
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0)
const NO_JITTER: FeedRankingConfig = { ...DEFAULT_FEED_RANKING, jitterAmount: 0 }

const throwingSql = (() => {
  throw new Error("sql must not be called in these unit paths")
}) as unknown as Sql

function shellRow(): FeedCandidateRow {
  return {
    id: SHELL,
    author_id: AUTHOR,
    created_at: new Date(NOW - 60_000),
    like_count: 0,
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
  }
}

function postDto(id: string, over: Partial<PostDTO> = {}): PostDTO {
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
    ...over,
  }
}

function targetBrief(): PostBrief {
  return {
    id: TARGET,
    authorId: AUTHOR,
    kind: "post",
    replyToId: null,
    repostOfId: null,
    deletedAt: null,
    visibility: "public",
  }
}

describe("a viewer who saw a post only through a repost card still gets its count updates", () => {
  it("signals feed_counts for the ORIGINAL to a viewer served the repost shell", async () => {
    const sent: Array<{ userId: string; signal: UserSignal }> = []
    const channel = {
      subscribeUser: () => Promise.resolve(() => Promise.resolve()),
      publishToUser: (userId: string, signal: UserSignal) => {
        sent.push({ userId, signal })
        return Promise.resolve()
      },
      publishToUsers: () => Promise.resolve(),
    } as unknown as UserChannel
    const repo = {
      getPostBrief: () => Promise.resolve(targetBrief()),
      actorNameOf: () => Promise.resolve("Liker"),
      like: () => Promise.resolve(true),
      getPostDTO: (id: string) => Promise.resolve(postDto(id)),
      feedCandidates: () => Promise.resolve([shellRow()]),
      hydrateByIds: () =>
        Promise.resolve([
          postDto(SHELL, {
            kind: "repost",
            repostOf: { id: TARGET } as unknown as PostDTO["repostOf"],
          }),
        ]),
    } as unknown as PostRepository
    const svc = makePostService({
      repo,
      sql: throwingSql,
      feedPresence: makeFeedPresence({
        cache: new InMemoryCacheClient(() => Date.now()),
        config: NO_JITTER,
      }),
      feedRanking: NO_JITTER,
      userChannel: channel,
      now: () => NOW,
    })

    await svc.homeFeed(VIEWER, { filter: "all", limit: 20 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await svc.likePost(TARGET, LIKER)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sent).toContainEqual({ userId: VIEWER, signal: { topic: "feed_counts", id: TARGET } })
  })
})
