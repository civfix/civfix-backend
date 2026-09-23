import { describe, expect, it } from "vitest"
import type { Sql } from "../../src/db/client.js"
import { makePostService } from "../../src/services/post-service.js"
import type { PostBrief, PostRepository } from "../../src/services/post-repository.drizzle.js"

const AUTHOR = "author"
const STRANGER = "stranger"
const POST_ID = "p1"
const UNKNOWN_ID = "p-unknown"

const unusedSql = (() => {
  throw new Error("sql must not be called in these unit paths")
}) as unknown as Sql

function brief(over: Partial<PostBrief> = {}): PostBrief {
  return {
    id: POST_ID,
    authorId: AUTHOR,
    kind: "post",
    replyToId: null,
    repostOfId: null,
    deletedAt: null,
    visibility: "public",
    ...over,
  }
}

function harness(post: PostBrief, blockedPairs: Array<[string, string]> = []) {
  const deleted: string[] = []
  const repo = {
    getPostBrief: (id: string) => Promise.resolve(id === post.id ? post : null),
    softDeletePost: (id: string) => {
      deleted.push(id)
      return Promise.resolve()
    },
  } as unknown as PostRepository
  const svc = makePostService({
    repo,
    sql: unusedSql,
    isBlockedEitherWay: (a, b) =>
      Promise.resolve(blockedPairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a))),
  })
  return { svc, deleted }
}

async function rejectionOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise
  } catch (err) {
    const { code, message } = err as { code: string; message: string }
    return { code, message }
  }
  throw new Error("expected the call to reject")
}

describe("deletePost does not reveal posts the caller cannot read", () => {
  it("answers a hidden post of someone else exactly like an unknown id", async () => {
    const { svc, deleted } = harness(brief({ visibility: "hidden" }))

    const unknown = await rejectionOf(svc.deletePost(UNKNOWN_ID, STRANGER))
    const hidden = await rejectionOf(svc.deletePost(POST_ID, STRANGER))

    expect(unknown.code).toBe("NOT_FOUND")
    expect(hidden).toEqual(unknown)
    expect(deleted).toEqual([])
  })

  it("answers a post whose author blocked the caller exactly like an unknown id", async () => {
    const { svc, deleted } = harness(brief(), [[AUTHOR, STRANGER]])

    const unknown = await rejectionOf(svc.deletePost(UNKNOWN_ID, STRANGER))
    const blocked = await rejectionOf(svc.deletePost(POST_ID, STRANGER))

    expect(blocked).toEqual(unknown)
    expect(deleted).toEqual([])
  })

  it("keeps 403 for a visible post owned by someone else", async () => {
    const { svc, deleted } = harness(brief())

    await expect(svc.deletePost(POST_ID, STRANGER)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "You can only delete your own post.",
    })
    expect(deleted).toEqual([])
  })

  it("still lets the author delete their own hidden post", async () => {
    const { svc, deleted } = harness(brief({ visibility: "hidden" }), [[AUTHOR, STRANGER]])

    await expect(svc.deletePost(POST_ID, AUTHOR)).resolves.toEqual({ ok: true })
    expect(deleted).toEqual([POST_ID])
  })
})
