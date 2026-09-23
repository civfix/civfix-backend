import { describe, expect, it } from "vitest"
import type { Sql } from "../../src/db/client.js"
import { makePostService } from "../../src/services/post-service.js"
import type { PostBrief, PostRepository } from "../../src/services/post-repository.drizzle.js"

const REPOSTER = "11111111-1111-1111-1111-111111111111"
const AUTHOR = "22222222-2222-2222-2222-222222222222"
const TARGET = "33333333-3333-3333-3333-333333333333"

const throwingSql = (() => {
  throw new Error("sql must not be called in these unit paths")
}) as unknown as Sql

function harness(target: Partial<PostBrief>, blocked = false) {
  const unreposts: Array<{ id: string; userId: string }> = []
  const repo = {
    getPostBrief: () =>
      Promise.resolve({
        id: TARGET,
        authorId: AUTHOR,
        kind: "post",
        replyToId: null,
        repostOfId: null,
        deletedAt: null,
        visibility: "public",
        ...target,
      } satisfies PostBrief),
    unrepost: (id: string, userId: string) => {
      unreposts.push({ id, userId })
      return Promise.resolve({ targetId: id, removed: true })
    },
    getPostDTO: () => Promise.resolve(null),
  } as unknown as PostRepository
  const svc = makePostService({
    repo,
    sql: throwingSql,
    isBlockedEitherWay: () => Promise.resolve(blocked),
  })
  return { svc, unreposts }
}

describe("un-reposting a post the reposter can no longer read", () => {
  it("still removes the repost once the original went hidden", async () => {
    const { svc, unreposts } = harness({ visibility: "hidden" })

    await expect(svc.unrepostPost(TARGET, REPOSTER)).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(unreposts).toEqual([{ id: TARGET, userId: REPOSTER }])
  })

  it("still removes the repost once the original's author blocked the reposter", async () => {
    const { svc, unreposts } = harness({}, true)

    await expect(svc.unrepostPost(TARGET, REPOSTER)).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(unreposts).toEqual([{ id: TARGET, userId: REPOSTER }])
  })
})
