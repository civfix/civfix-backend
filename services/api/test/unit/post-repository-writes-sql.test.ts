import { describe, expect, it } from "vitest"
import { makeFakeSql, type SqlHandler } from "../helpers/fake-sql.js"
import type { Sql } from "../../src/db/client.js"
import { makeDrizzlePostRepository } from "../../src/services/post-repository.drizzle.js"
import type { CreatePostArgs } from "../../src/services/post-repository.js"

const AUTHOR = "11111111-1111-1111-1111-111111111111"
const TARGET = "22222222-2222-2222-2222-222222222222"
const NEW_POST = "33333333-3333-3333-3333-333333333333"

function repoOver(handlers: SqlHandler[]) {
  const fake = makeFakeSql(handlers)
  const repo = makeDrizzlePostRepository(fake.sql as unknown as Sql, {
    presignMedia: () => Promise.resolve({ url: "u" }),
    presignAvatar: () => Promise.resolve("a"),
  })
  return { fake, repo }
}

const LIVE_TARGET: SqlHandler = {
  match: /SELECT id, kind, repost_of_id FROM posts/,
  rows: [{ id: TARGET, kind: "post", repost_of_id: null }],
}
const INSERTED: SqlHandler = { match: /INSERT INTO posts/, rows: [{ id: NEW_POST }] }

function replyArgs(over: Partial<CreatePostArgs> = {}): CreatePostArgs {
  return {
    authorId: AUTHOR,
    kind: "reply",
    body: "me too",
    replyToId: TARGET,
    repostOfId: null,
    eventId: null,
    reportId: null,
    mediaUploadIds: [],
    mentionedUserIds: [],
    organizationId: null,
    ...over,
  }
}

describe("reviving an un-reposted repost", () => {
  it("dates the revived repost now, so it is neither backdated nor marked edited", async () => {
    const { fake, repo } = repoOver([
      LIVE_TARGET,
      { match: /UPDATE posts SET deleted_at = NULL/, rows: [{ id: NEW_POST }] },
    ])

    await repo.repost(TARGET, AUTHOR)

    const revive = fake.statements.find((s) => /SET deleted_at = NULL/.test(s.sql))
    expect(revive?.sql).toMatch(/created_at = now\(\)/)
    expect(revive?.sql).toMatch(/updated_at = now\(\)/)
  })
})

describe("creating a reply or quote whose target vanished after the service checked it", () => {
  it("refuses a reply to a parent that is gone, writing nothing", async () => {
    const { fake, repo } = repoOver([INSERTED])

    await expect(repo.createPost(replyArgs())).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(fake.statements.some((s) => /INSERT INTO posts/.test(s.sql))).toBe(false)
  })

  it("refuses a quote of a target that is gone, writing nothing", async () => {
    const { fake, repo } = repoOver([INSERTED])

    await expect(
      repo.createPost(replyArgs({ kind: "quote", replyToId: null, repostOfId: TARGET })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(fake.statements.some((s) => /INSERT INTO posts/.test(s.sql))).toBe(false)
  })

  it("rolls back when the parent is tombstoned between the lookup and the reply-count bump", async () => {
    const { repo } = repoOver([LIVE_TARGET, INSERTED])

    await expect(repo.createPost(replyArgs())).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("bumps the reply count only on a parent that is still live", async () => {
    const { fake, repo } = repoOver([
      LIVE_TARGET,
      INSERTED,
      { match: /SET reply_count = reply_count \+ 1/, rows: [{ id: TARGET }] },
    ])

    await expect(repo.createPost(replyArgs())).resolves.toBe(NEW_POST)
    const bump = fake.statements.find((s) => /reply_count = reply_count \+ 1/.test(s.sql))
    expect(bump?.sql).toMatch(/deleted_at IS NULL/)
  })
})
