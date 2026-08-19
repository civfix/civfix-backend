
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { makeDrizzlePostRepository } from "../../src/services/post-repository.drizzle.js"
import { makePostService, type PostService } from "../../src/services/post-service.js"

const pg = await withPg()

const echoPresign = (r2Key: string, thumbKey: string | null) =>
  Promise.resolve(thumbKey === null ? { url: `m://${r2Key}` } : { url: `m://${r2Key}`, thumbUrl: `m://${thumbKey}` })
const echoAvatar = (k: string) => Promise.resolve(`m://${k}`)

describe.skipIf(!pg)("posts: repost lifecycle + public feed (integration)", () => {
  let h: PgHarness

  function makeService(): PostService {
    const repo = makeDrizzlePostRepository(h.sql, {
      presignMedia: echoPresign,
      presignAvatar: echoAvatar,
    })
    return makePostService({ repo, sql: h.sql })
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

  async function repostRowId(actorId: string, targetId: string): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      SELECT id FROM posts WHERE author_id = ${actorId} AND kind = 'repost' AND repost_of_id = ${targetId}
    `
    return row!.id
  }

  it("F003: a repost DELETED from the user's own timeline can be reposted again", async () => {
    const svc = makeService()
    const author = await newUser("Revive Author")
    const actor = await newUser("Revive Actor")
    const post = await svc.createPost(
      { kind: "post", body: "repost me", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )

    expect((await svc.repostPost(post.id, actor)).counts.reposts).toBe(1)
    const shellId = await repostRowId(actor, post.id)
    await svc.deletePost(shellId, actor)
    expect((await svc.getPost(post.id, actor)).counts.reposts).toBe(0)
    expect((await svc.getPost(post.id, actor)).viewer.reposted).toBe(false)

    const again = await svc.repostPost(post.id, actor)
    expect(again.counts.reposts).toBe(1)
    expect(again.viewer.reposted).toBe(true)
    const live = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM posts
      WHERE author_id = ${actor} AND kind = 'repost' AND repost_of_id = ${post.id} AND deleted_at IS NULL
    `
    expect(live[0]!.n).toBe(1)
  })

  it("F054: deleting a repost then un-reposting decrements repost_count exactly ONCE", async () => {
    const svc = makeService()
    const author = await newUser("Count Author")
    const actor = await newUser("Count Actor")
    const other = await newUser("Count Other")
    const post = await svc.createPost(
      { kind: "post", body: "count me", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )

    await svc.repostPost(post.id, actor)
    await svc.repostPost(post.id, other)
    expect((await svc.getPost(post.id, author)).counts.reposts).toBe(2)

    const shellId = await repostRowId(actor, post.id)
    await svc.deletePost(shellId, actor)
    expect((await svc.getPost(post.id, author)).counts.reposts).toBe(1)

    await svc.unrepostPost(post.id, actor)
    expect((await svc.getPost(post.id, author)).counts.reposts).toBe(1)
  })

  it("F013: publicFeed returns only public-visibility posts", async () => {
    const svc = makeService()
    const author = await newUser("Feed Author")
    const shown = await svc.createPost(
      { kind: "post", body: "public row", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    const hidden = await svc.createPost(
      { kind: "post", body: "hidden row", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    await h.sql`UPDATE posts SET visibility = 'hidden' WHERE id = ${hidden.id}`

    const feed = await svc.publicFeed({ filter: "all" })
    const ids = feed.items.map((p) => p.id)
    expect(ids).toContain(shown.id)
    expect(ids).not.toContain(hidden.id)
  })
})
