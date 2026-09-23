/**
 * F148 (HIGH, data-integrity): un-reposting must never destroy other people's content.
 *
 * 0051 created posts.reply_to_id / thread_root_id / repost_of_id and media_assets.post_id ON DELETE
 * CASCADE, while unrepost() issued a REAL `DELETE FROM posts`. A repost row is a normal post — third
 * parties can reply to or quote it — so one user's un-repost cascaded away other users' replies, quotes,
 * their media_assets rows (stranding the R2 objects, because media_reap_tombstones is only written by the
 * application delete path), their likes and saves, and left every denormalized counter drifting.
 *
 * Two independent fixes, both asserted here against the real schema (Docker-gated):
 *   1. unrepost is a SOFT delete (deleted_at + a single repost_count decrement), like every other delete
 *      path in the product;
 *   2. the self-FKs are ON DELETE RESTRICT and media_assets.post_id is ON DELETE SET NULL (0072/0073), so
 *      even a stray hard DELETE — a psql session, a future code path — cannot take someone else's post
 *      or strand an R2 object.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import {
  makeDrizzlePostRepository,
  type PostRepository,
} from "../../src/services/post-repository.drizzle.js"

const pg = await withPg()

describe.skipIf(!pg)("F148: un-reposting never destroys other users' content", () => {
  let h: PgHarness
  let repo: PostRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzlePostRepository(h.sql, {
      presignMedia: (r2Key: string) => Promise.resolve({ url: `m://${r2Key}` }),
      presignAvatar: (r2Key: string) => Promise.resolve(`m://${r2Key}`),
    })
  })

  beforeEach(async () => {
    await h.sql`DELETE FROM media_assets`
    await h.sql`DELETE FROM posts`
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

  async function newPost(authorId: string, body: string): Promise<string> {
    const [p] = await h.sql<{ id: string }[]>`
      INSERT INTO posts (author_id, kind, body) VALUES (${authorId}, 'post', ${body}) RETURNING id
    `
    return p!.id
  }

  async function newReplyTo(authorId: string, parentId: string, body: string): Promise<string> {
    const [p] = await h.sql<{ id: string }[]>`
      INSERT INTO posts (author_id, kind, body, reply_to_id, thread_root_id)
      VALUES (${authorId}, 'post', ${body}, ${parentId}, ${parentId})
      RETURNING id
    `
    return p!.id
  }

  async function attachMedia(postId: string): Promise<string> {
    const [m] = await h.sql<{ id: string }[]>`
      INSERT INTO media_assets (upload_id, kind, r2_key, status, purpose, post_id)
      VALUES (${randomUUID()}, 'image', ${`posts/${randomUUID()}.jpg`}, 'ready', 'post', ${postId})
      RETURNING id
    `
    return m!.id
  }

  async function postRow(
    id: string,
  ): Promise<{ deleted_at: Date | null; repost_count: number } | undefined> {
    const rows = await h.sql<{ deleted_at: Date | null; repost_count: number }[]>`
      SELECT deleted_at, repost_count FROM posts WHERE id = ${id}
    `
    return rows[0]
  }

  it("soft-deletes the repost row and leaves a third party's reply + its media intact", async () => {
    const author = await newUser("Author")
    const reposter = await newUser("Reposter")
    const stranger = await newUser("Stranger")

    const original = await newPost(author, "original")
    const { targetId, created } = await repo.repost(original, reposter)
    expect(created).toBe(true)
    expect(targetId).toBe(original)

    const [repostRow] = await h.sql<{ id: string }[]>`
      SELECT id FROM posts WHERE author_id = ${reposter} AND kind = 'repost'
    `
    const repostId = repostRow!.id
    const reply = await newReplyTo(stranger, repostId, "someone else's reply")
    const media = await attachMedia(reply)

    const { removed } = await repo.unrepost(original, reposter)
    expect(removed).toBe(true)

    const shell = await postRow(repostId)
    expect(shell).toBeDefined()
    expect(shell!.deleted_at).not.toBeNull()

    const survivor = await postRow(reply)
    expect(survivor).toBeDefined()
    expect(survivor!.deleted_at).toBeNull()

    const [mediaRow] = await h.sql<{ post_id: string | null }[]>`
      SELECT post_id FROM media_assets WHERE id = ${media}
    `
    expect(mediaRow?.post_id).toBe(reply)
  })

  it("REFUSES a hard delete that would take a reply with it (self-FKs are RESTRICT)", async () => {
    const author = await newUser("Author")
    const stranger = await newUser("Stranger")
    const original = await newPost(author, "original")
    const reply = await newReplyTo(stranger, original, "reply")

    await expect(h.sql`DELETE FROM posts WHERE id = ${original}`).rejects.toMatchObject({
      code: "23503",
    })
    expect(await postRow(reply)).toBeDefined()
  })

  it("DETACHES media on a hard delete instead of deleting the asset row (SET NULL)", async () => {
    const author = await newUser("Author")
    const post = await newPost(author, "with a photo")
    const media = await attachMedia(post)

    await h.sql`DELETE FROM posts WHERE id = ${post}`

    const [row] = await h.sql<{ post_id: string | null }[]>`
      SELECT post_id FROM media_assets WHERE id = ${media}
    `
    expect(row).toBeDefined()
    expect(row!.post_id).toBeNull()
  })

  it("pins the delete actions on every posts self-FK and on media_assets.post_id", async () => {
    const rows = await h.sql<{ conname: string; confdeltype: string }[]>`
      SELECT conname, confdeltype
      FROM pg_constraint
      WHERE contype = 'f'
        AND conname IN (
          'posts_reply_to_id_fk',
          'posts_thread_root_id_fk',
          'posts_repost_of_id_fk',
          'media_assets_post_id_fk'
        )
      ORDER BY conname
    `
    expect(rows.map((r) => `${r.conname}:${r.confdeltype}`)).toEqual([
      "media_assets_post_id_fk:n",
      "posts_reply_to_id_fk:r",
      "posts_repost_of_id_fk:r",
      "posts_thread_root_id_fk:r",
    ])
    const notValid = await h.sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE contype = 'f' AND NOT convalidated
        AND conname IN (
          'posts_reply_to_id_fk',
          'posts_thread_root_id_fk',
          'posts_repost_of_id_fk',
          'media_assets_post_id_fk'
        )
    `
    expect(notValid).toEqual([])
  })
})
