import { describe, expect, it } from "vitest"
import type { Sql } from "../../src/db/client.js"
import { makePostService } from "../../src/services/post-service.js"
import type { FeedCountsRow, PostRepository } from "../../src/services/post-repository.drizzle.js"

const VIEWER = "11111111-1111-1111-1111-111111111111"
const PUBLIC_POST = "22222222-2222-2222-2222-222222222222"
const HIDDEN_POST = "33333333-3333-3333-3333-333333333333"
const BLOCKED_POST = "44444444-4444-4444-4444-444444444444"

const throwingSql = (() => {
  throw new Error("sql must not be called in these unit paths")
}) as unknown as Sql

function countsRepo(readable: Set<string>): {
  repo: PostRepository
  calls: Array<{ postIds: readonly string[]; viewerId: string }>
} {
  const calls: Array<{ postIds: readonly string[]; viewerId: string }> = []
  const repo = {
    readableCounts: (postIds: readonly string[], viewerId: string): Promise<FeedCountsRow[]> => {
      calls.push({ postIds, viewerId })
      return Promise.resolve(
        postIds
          .filter((id) => readable.has(id))
          .map((id) => ({
            id,
            like_count: 3,
            repost_count: 2,
            reply_count: 1,
            save_count: 4,
          })),
      )
    },
  } as unknown as PostRepository
  return { repo, calls }
}

describe("getFeedCounts", () => {
  it("returns counts for a post the caller may read", async () => {
    const { repo } = countsRepo(new Set([PUBLIC_POST]))
    const svc = makePostService({ repo, sql: throwingSql })
    const result = await svc.getFeedCounts([PUBLIC_POST], VIEWER)
    expect(result).toEqual({
      items: [{ id: PUBLIC_POST, counts: { likes: 3, reposts: 2, replies: 1, saves: 4 } }],
    })
  })

  it("omits a hidden or deleted post rather than erroring, so it cannot probe existence", async () => {
    const { repo } = countsRepo(new Set([PUBLIC_POST]))
    const svc = makePostService({ repo, sql: throwingSql })
    const result = await svc.getFeedCounts([PUBLIC_POST, HIDDEN_POST], VIEWER)
    expect(result.items.map((item) => item.id)).toEqual([PUBLIC_POST])
  })

  it("omits a post whose author blocks the caller (no IDOR either direction)", async () => {
    const { repo } = countsRepo(new Set([PUBLIC_POST]))
    const svc = makePostService({ repo, sql: throwingSql })
    const result = await svc.getFeedCounts([BLOCKED_POST, PUBLIC_POST], VIEWER)
    expect(result.items.map((item) => item.id)).toEqual([PUBLIC_POST])
  })

  it("returns an empty list for entirely unreadable ids, never a 404", async () => {
    const { repo } = countsRepo(new Set())
    const svc = makePostService({ repo, sql: throwingSql })
    await expect(svc.getFeedCounts([HIDDEN_POST], VIEWER)).resolves.toEqual({ items: [] })
  })

  it("scopes the read to the calling viewer, never an id from the body", async () => {
    const { repo, calls } = countsRepo(new Set([PUBLIC_POST]))
    const svc = makePostService({ repo, sql: throwingSql })
    await svc.getFeedCounts([PUBLIC_POST], VIEWER)
    expect(calls).toEqual([{ postIds: [PUBLIC_POST], viewerId: VIEWER }])
  })

  it("deduplicates ids so a repeated id cannot multiply the query cost", async () => {
    const { repo, calls } = countsRepo(new Set([PUBLIC_POST]))
    const svc = makePostService({ repo, sql: throwingSql })
    await svc.getFeedCounts([PUBLIC_POST, PUBLIC_POST, PUBLIC_POST], VIEWER)
    expect(calls[0]!.postIds).toEqual([PUBLIC_POST])
  })

  it("issues exactly one repository read (no N+1)", async () => {
    const { repo, calls } = countsRepo(new Set([PUBLIC_POST, HIDDEN_POST, BLOCKED_POST]))
    const svc = makePostService({ repo, sql: throwingSql })
    await svc.getFeedCounts([PUBLIC_POST, HIDDEN_POST, BLOCKED_POST], VIEWER)
    expect(calls).toHaveLength(1)
  })

  it("short-circuits an empty request without touching the repository", async () => {
    const { repo, calls } = countsRepo(new Set())
    const svc = makePostService({ repo, sql: throwingSql })
    await expect(svc.getFeedCounts([], VIEWER)).resolves.toEqual({ items: [] })
    expect(calls).toHaveLength(0)
  })
})
