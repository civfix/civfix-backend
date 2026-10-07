import { describe, expect, it } from "vitest"
import type { PostDTO } from "@civfix/shared"
import type { Sql } from "../../src/db/client.js"
import { makePostService } from "../../src/services/post-service.js"
import { NIL_VIEWER_ID } from "../../src/services/post-repository.drizzle.js"
import type { PostBrief, PostRepository } from "../../src/services/post-repository.js"
import type { PostNotifier } from "../../src/services/notification-service.js"
import { makeDrizzleBlocksRepository } from "../../src/services/blocks-repository.drizzle.js"
import { InMemoryBlocksRepository } from "../../src/services/dm-repository.memory.js"
import { makeFakeSql } from "../helpers/fake-sql.js"

const AUTHOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const MENTIONED = Array.from(
  { length: 20 },
  (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
)
const BLOCKED = MENTIONED[7]!

const brief: PostBrief = {
  id: "p1",
  authorId: AUTHOR,
  kind: "post",
  replyToId: null,
  repostOfId: null,
  deletedAt: null,
  visibility: "public",
}

function repoStub(): PostRepository {
  return {
    getPostBrief: (id: string) => Promise.resolve(id === brief.id ? brief : null),
    getPostDTO: (id: string) => Promise.resolve({ id } as PostDTO),
    actorNameOf: () => Promise.resolve("Actor Zed"),
    createPost: () => Promise.resolve("new-post-id"),
    listUserPosts: () => Promise.resolve({ items: [], nextCursor: null }),
  } as unknown as PostRepository
}

function mentionSql() {
  return makeFakeSql([
    {
      match: /FROM users u[\s\S]*u\.id IN/,
      rows: MENTIONED.map((id) => ({ id, handle: `h${id.slice(-2)}`, display_name: "Someone" })),
    },
  ])
}

function trackingNotifier() {
  const mentions: string[] = []
  let inFlight = 0
  let peak = 0
  const notifier = {
    onPostMention: async ({ recipientId }: { recipientId: string }) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      mentions.push(recipientId)
      inFlight -= 1
    },
  } as unknown as PostNotifier
  return { notifier, mentions, peak: () => peak }
}

describe("post mentions: one block lookup, bounded bell fan-out", () => {
  it("looks up blocks once for every mention and bells the unblocked ones at most 4 at a time", async () => {
    const fake = mentionSql()
    const lookups: { actorId: string; ids: string[] }[] = []
    const singles: string[] = []
    const spy = trackingNotifier()
    const svc = makePostService({
      repo: repoStub(),
      sql: fake.sql as unknown as Sql,
      notifier: spy.notifier,
      isBlockedEitherWay: (_a, b) => {
        singles.push(b)
        return Promise.resolve(false)
      },
      blockedIdsAmong: (actorId, ids) => {
        lookups.push({ actorId, ids: [...ids] })
        return Promise.resolve(new Set([BLOCKED]))
      },
    })

    await svc.createPost(
      { kind: "post", body: "hi all", mediaUploadIds: [], mentionedUserIds: MENTIONED },
      AUTHOR,
    )

    expect(lookups).toEqual([{ actorId: AUTHOR, ids: MENTIONED }])
    expect(singles).toEqual([])
    expect([...spy.mentions].sort()).toEqual(MENTIONED.filter((id) => id !== BLOCKED).sort())
    expect(spy.peak()).toBeLessThanOrEqual(4)
    expect(spy.peak()).toBeGreaterThan(1)
  })

  it("makes no block lookup when the post mentions nobody", async () => {
    let lookups = 0
    const svc = makePostService({
      repo: repoStub(),
      sql: mentionSql().sql as unknown as Sql,
      notifier: trackingNotifier().notifier,
      blockedIdsAmong: () => {
        lookups += 1
        return Promise.resolve(new Set<string>())
      },
    })
    await svc.createPost(
      { kind: "post", body: "hi", mediaUploadIds: [], mentionedUserIds: [] },
      AUTHOR,
    )
    expect(lookups).toBe(0)
  })

  it("falls back to the per-pair block check when no batch lookup is wired, never to 'nobody blocked'", async () => {
    const spy = trackingNotifier()
    const svc = makePostService({
      repo: repoStub(),
      sql: mentionSql().sql as unknown as Sql,
      notifier: spy.notifier,
      isBlockedEitherWay: (_a, b) => Promise.resolve(b === BLOCKED),
    })
    await svc.createPost(
      { kind: "post", body: "hi all", mediaUploadIds: [], mentionedUserIds: MENTIONED },
      AUTHOR,
    )
    expect([...spy.mentions].sort()).toEqual(MENTIONED.filter((id) => id !== BLOCKED).sort())
  })

  it("propagates a failed block lookup without ringing any bell", async () => {
    const spy = trackingNotifier()
    const svc = makePostService({
      repo: repoStub(),
      sql: mentionSql().sql as unknown as Sql,
      notifier: spy.notifier,
      blockedIdsAmong: () => Promise.reject(new Error("blocks down")),
    })
    await expect(
      svc.createPost(
        { kind: "post", body: "hi", mediaUploadIds: [], mentionedUserIds: MENTIONED },
        AUTHOR,
      ),
    ).rejects.toThrow("blocks down")
    expect(spy.mentions).toEqual([])
  })
})

describe("post reads by the anonymous viewer skip the block gate", () => {
  function countingService() {
    const calls: [string, string][] = []
    const svc = makePostService({
      repo: repoStub(),
      sql: mentionSql().sql as unknown as Sql,
      isBlockedEitherWay: (a, b) => {
        calls.push([a, b])
        return Promise.resolve(false)
      },
    })
    return { svc, calls }
  }

  it("getPost for the nil viewer makes no block call", async () => {
    const { svc, calls } = countingService()
    await expect(svc.getPost("p1", NIL_VIEWER_ID)).resolves.toMatchObject({ id: "p1" })
    expect(calls).toEqual([])
  })

  it("listUserPosts for the nil viewer makes no block call", async () => {
    const { svc, calls } = countingService()
    await svc.listUserPosts(AUTHOR, NIL_VIEWER_ID, {})
    expect(calls).toEqual([])
  })

  it("a signed-in viewer still goes through the block gate", async () => {
    const { svc, calls } = countingService()
    await svc.getPost("p1", MENTIONED[0]!)
    expect(calls).toEqual([[MENTIONED[0], AUTHOR]])
  })
})

describe("blockedIdsAmong", () => {
  it("binds the candidates as one uuid array per side, not one parameter per id", async () => {
    const fake = makeFakeSql([{ match: /FROM user_blocks b/, rows: [{ other_id: BLOCKED }] }])
    const repo = makeDrizzleBlocksRepository(fake.sql as unknown as Sql)
    const ids = MENTIONED.slice(0, 5)

    const blocked = await repo.blockedIdsAmong(AUTHOR, ids)

    expect(blocked).toEqual(new Set([BLOCKED]))
    expect(fake.statements).toHaveLength(1)
    expect(fake.statements[0]!.sql).toMatch(/b\.blocked_id = ANY\(\?::uuid\[\]\)/)
    expect(fake.statements[0]!.sql).toMatch(/b\.blocker_id = ANY\(\?::uuid\[\]\)/)
    expect(fake.statements[0]!.values).toEqual([AUTHOR, AUTHOR, ids, AUTHOR, ids])
  })

  it("runs no statement for an empty candidate list", async () => {
    const fake = makeFakeSql()
    const repo = makeDrizzleBlocksRepository(fake.sql as unknown as Sql)
    expect(await repo.blockedIdsAmong(AUTHOR, [])).toEqual(new Set())
    expect(fake.statements).toHaveLength(0)
  })

  it("in memory, returns the candidates blocked in either direction", async () => {
    const repo = new InMemoryBlocksRepository()
    const [byActor, ofActor, clear] = MENTIONED as [string, string, string]
    await repo.block(AUTHOR, byActor)
    await repo.block(ofActor, AUTHOR)
    expect(await repo.blockedIdsAmong(AUTHOR, [byActor, ofActor, clear])).toEqual(
      new Set([byActor, ofActor]),
    )
  })
})
