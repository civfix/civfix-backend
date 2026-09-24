import { describe, expect, it } from "vitest"
import { RepostResponseSchema, type PostDTO } from "@civfix/shared"
import type { Sql } from "../../src/db/client.js"
import { makePostService } from "../../src/services/post-service.js"
import type { PostBrief, PostRepository } from "../../src/services/post-repository.drizzle.js"

const REPOSTER = "11111111-1111-1111-1111-111111111111"
const AUTHOR = "22222222-2222-2222-2222-222222222222"
const TARGET = "33333333-3333-3333-3333-333333333333"
const SECRET_BODY = "the original's current text"
const NOW = Date.parse("2026-09-01T10:00:00.000Z")

const throwingSql = (() => {
  throw new Error("sql must not be called in these unit paths")
}) as unknown as Sql

function hydrated(): PostDTO {
  return {
    id: TARGET,
    author: { id: AUTHOR, name: "Ana", followers: 3, following: 1, isFollowing: false },
    kind: "post",
    body: SECRET_BODY,
    createdAt: "2026-08-01T10:00:00.000Z",
    counts: { likes: 4, reposts: 1, replies: 0, saves: 0 },
    viewer: { liked: false, reposted: false, saved: false },
    media: [],
    mentions: [],
  } as unknown as PostDTO
}

function harness(opts: { target?: Partial<PostBrief>; blocked?: boolean; removed?: boolean } = {}) {
  const unreposts: Array<{ id: string; userId: string }> = []
  const brief: PostBrief = {
    id: TARGET,
    authorId: AUTHOR,
    kind: "post",
    replyToId: null,
    repostOfId: null,
    deletedAt: null,
    visibility: "public",
    ...opts.target,
  }
  const repo = {
    getPostBrief: () => Promise.resolve(brief),
    unrepost: (id: string, userId: string) => {
      unreposts.push({ id, userId })
      return Promise.resolve({ targetId: id, removed: opts.removed ?? true })
    },
    // Mirrors the Postgres read, which filters visibility but not blocks.
    getPostDTO: () =>
      Promise.resolve(
        brief.visibility === "public" && brief.deletedAt === null ? hydrated() : null,
      ),
  } as unknown as PostRepository
  const svc = makePostService({
    repo,
    sql: throwingSql,
    isBlockedEitherWay: () => Promise.resolve(opts.blocked ?? false),
    now: () => NOW,
  })
  return { svc, unreposts }
}

describe("un-reposting a post the reposter can no longer read", () => {
  it("removes the repost once the original went hidden and answers success without its content", async () => {
    const { svc, unreposts } = harness({ target: { visibility: "hidden" } })

    const dto = await svc.unrepostPost(TARGET, REPOSTER)

    expect(unreposts).toEqual([{ id: TARGET, userId: REPOSTER }])
    expect(RepostResponseSchema.safeParse(dto).success).toBe(true)
    expect(dto).toMatchObject({
      id: TARGET,
      body: null,
      viewer: { reposted: false, liked: false, saved: false },
      counts: { likes: 0, reposts: 0, replies: 0, saves: 0 },
    })
  })

  it("removes the repost once the original's author blocked the reposter, and never returns the post", async () => {
    const { svc, unreposts } = harness({ blocked: true })

    const dto = await svc.unrepostPost(TARGET, REPOSTER)

    expect(unreposts).toEqual([{ id: TARGET, userId: REPOSTER }])
    expect(dto.viewer.reposted).toBe(false)
    expect(JSON.stringify(dto)).not.toContain(SECRET_BODY)
    expect(dto.author.name).not.toBe("Ana")
  })

  it("answers 404 for an unreadable post when there was no repost to take back", async () => {
    const { svc } = harness({ blocked: true, removed: false })

    await expect(svc.unrepostPost(TARGET, REPOSTER)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("answers the hydrated post when the reposter can still read it", async () => {
    const { svc } = harness()

    await expect(svc.unrepostPost(TARGET, REPOSTER)).resolves.toMatchObject({ body: SECRET_BODY })
  })
})
