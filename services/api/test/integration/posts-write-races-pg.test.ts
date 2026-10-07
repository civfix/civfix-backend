import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { makeDrizzlePostRepository } from "../../src/services/post-repository.drizzle.js"

const pg = await withPg()

describe.skipIf(!pg)("posts: revival dating and vanished targets (integration)", () => {
  let h: PgHarness

  function repo() {
    return makeDrizzlePostRepository(h.sql, {
      presignMedia: (r2Key: string) => Promise.resolve({ url: `m://${r2Key}` }),
      presignAvatar: (k: string) => Promise.resolve(`m://${k}`),
    })
  }

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${testHandle()}) RETURNING id
    `
    return u!.id
  }

  async function newPost(authorId: string): Promise<string> {
    return repo().createPost({
      authorId,
      kind: "post",
      body: "original",
      replyToId: null,
      repostOfId: null,
      eventId: null,
      reportId: null,
      mediaUploadIds: [],
      mentionedUserIds: [],
      organizationId: null,
    })
  }

  it("a revived repost is dated at the revival and is not marked edited", async () => {
    const author = await newUser("Revival Author")
    const actor = await newUser("Revival Actor")
    const target = await newPost(author)

    await repo().repost(target, actor)
    await h.sql`
      UPDATE posts SET created_at = created_at - interval '3 days', updated_at = updated_at - interval '3 days'
      WHERE author_id = ${actor} AND kind = 'repost'
    `
    await repo().unrepost(target, actor)
    await repo().repost(target, actor)

    const [row] = await h.sql<{ age_s: number; edited: boolean }[]>`
      SELECT extract(epoch FROM now() - created_at)::float8 AS age_s,
             updated_at > created_at AS edited
      FROM posts WHERE author_id = ${actor} AND kind = 'repost' AND deleted_at IS NULL
    `
    expect(row!.age_s).toBeLessThan(60)
    expect(row!.edited).toBe(false)
  })

  it("a reply to a parent deleted after the service check is refused and counts nothing", async () => {
    const author = await newUser("Gone Author")
    const replier = await newUser("Gone Replier")
    const parent = await newPost(author)
    await h.sql`UPDATE posts SET deleted_at = now() WHERE id = ${parent}`

    await expect(
      repo().createPost({
        authorId: replier,
        kind: "reply",
        body: "hello?",
        replyToId: parent,
        repostOfId: null,
        eventId: null,
        reportId: null,
        mediaUploadIds: [],
        mentionedUserIds: [],
        organizationId: null,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })

    const [row] = await h.sql<{ reply_count: number; replies: number }[]>`
      SELECT p.reply_count::int AS reply_count,
             (SELECT count(*)::int FROM posts r WHERE r.reply_to_id = p.id) AS replies
      FROM posts p WHERE p.id = ${parent}
    `
    expect(row).toEqual({ reply_count: 0, replies: 0 })
  })
})
