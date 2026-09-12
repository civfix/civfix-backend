/**
 * Posts integration test (Docker-gated). Exercises the REAL transaction path — the Drizzle/PostGIS
 * PostRepository + PostService (+ NotificationService for the fan-out) against a live PostGIS container
 * (via withPg). Driven at the service+repository layer (like reports-pg.test.ts / social-notifications),
 * so it needs no Redis/HTTP: it proves the create→get→like→repost→reply→save→delete round-trip + count
 * denormalization, home-feed follow fan-out, attach-event membership + delete authorization, and the
 * interaction-notification fan-out (like notifies the author not self, blocked → none, @mention).
 *
 * When Docker is unavailable the whole block SKIPS (describe.skipIf) so the local suite stays green.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { FakePushSender } from "@civfix/shared/fakes"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import {
  publishMediaAsReady,
  seedMediaAsset,
  type SeedMediaStatus,
  type SeededMedia,
} from "../helpers/media-pg.js"
import { makeDrizzlePostRepository } from "../../src/services/post-repository.drizzle.js"
import { makePostService, type PostService } from "../../src/services/post-service.js"
import { makeDrizzleNotificationRepository } from "../../src/services/notification-repository.drizzle.js"
import { makeNotificationService } from "../../src/services/notification-service.js"
import { makeDrizzleBlocksRepository } from "../../src/services/blocks-repository.drizzle.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { makeCleanupService } from "../../src/services/cleanup-service.js"

const pg = await withPg()

const echoPresign = (r2Key: string, thumbKey: string | null) =>
  Promise.resolve(thumbKey === null ? { url: `m://${r2Key}` } : { url: `m://${r2Key}`, thumbUrl: `m://${thumbKey}` })
const echoAvatar = (k: string) => Promise.resolve(`m://${k}`)

describe.skipIf(!pg)("posts (integration: real transaction path)", () => {
  let h: PgHarness
  let notifRepo: ReturnType<typeof makeDrizzleNotificationRepository>

  function makeService(): PostService {
    const repo = makeDrizzlePostRepository(h.sql, {
      presignMedia: echoPresign,
      presignAvatar: echoAvatar,
    })
    const notifier = makeNotificationService({ repo: notifRepo, pushSender: new FakePushSender() })
    const blocks = makeDrizzleBlocksRepository(h.sql)
    return makePostService({
      repo,
      sql: h.sql,
      notifier,
      isBlockedEitherWay: (a, b) => blocks.isBlockedEitherWay(a, b),
    })
  }

  beforeAll(() => {
    h = pg as PgHarness
    notifRepo = makeDrizzleNotificationRepository(h.sql)
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string, handle?: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${handle ?? testHandle()}) RETURNING id
    `
    return u!.id
  }

  /**
   * A finalized, unattached media_asset — what media-intake plus the media-checks worker leave behind
   * once the upload validates. `ready` (not `validating`) because loadMedia only renders `ready`
   * assets into the PostDTO, and a `ready` row carries the worker's published served_key, which is
   * the key the DTO presigns (never the client-writable r2_key).
   */
  async function seedMedia(status: SeedMediaStatus = "ready"): Promise<SeededMedia> {
    const uploadId = randomUUID()
    return await seedMediaAsset(h.sql, {
      uploadId,
      r2Key: `uploads/post/${uploadId}`,
      thumbKey: `uploads/post/${uploadId}.thumb`,
      status,
      byteSize: 2048,
      width: 800,
      height: 600,
    })
  }

  it("F087c: a CONCURRENT double repost cannot double-count — the revival UPDATE carries the tombstone predicate itself", async () => {
    const svc = makeService()
    const author = await newUser("Race Author")
    const actor = await newUser("Race Actor")
    const post = await svc.createPost(
      { kind: "post", body: "race me", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    await svc.repostPost(post.id, actor)
    await svc.unrepostPost(post.id, actor)
    expect((await svc.getPost(post.id, author)).counts.reposts).toBe(0)

    // The exact statement repost() runs to revive a tombstoned repost. Two transactions run it against
    // the SAME tombstone with real overlap: T1 takes the row lock and holds it; T2 blocks on that lock
    // and, under READ COMMITTED, re-evaluates its WHERE against the row T1 committed. Because
    // `deleted_at IS NOT NULL` lives IN the UPDATE (not in an unlocked subselect), T2 now matches ZERO
    // rows and skips its `repost_count + 1` — the drift 0074 had to reconcile.
    const revive = (tx: typeof h.sql) => tx<{ id: string }[]>`
      UPDATE posts SET deleted_at = NULL, updated_at = now()
      WHERE author_id = ${actor} AND kind = 'repost' AND repost_of_id = ${post.id}
        AND deleted_at IS NOT NULL
      RETURNING id
    `
    let openTheGate = (): void => {}
    const gate = new Promise<void>((resolve) => {
      openTheGate = resolve
    })
    let firstRows = -1
    let secondRows = -1

    const t1 = h.sql.begin(async (tx) => {
      firstRows = (await revive(tx as unknown as typeof h.sql)).length
      await gate
    })
    await new Promise((r) => setTimeout(r, 150))
    const t2 = h.sql.begin(async (tx) => {
      secondRows = (await revive(tx as unknown as typeof h.sql)).length
    })
    await new Promise((r) => setTimeout(r, 150))
    openTheGate()
    await Promise.all([t1, t2])

    expect(firstRows).toBe(1)
    expect(secondRows).toBe(0)

    // One live repost remains (the partial unique index over live rows would have rejected a second).
    const live = await h.sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM posts
      WHERE author_id = ${actor} AND kind = 'repost' AND repost_of_id = ${post.id}
        AND deleted_at IS NULL
    `
    expect(live[0]!.n).toBe(1)

    // The raw revive above bypassed the service, so the counter was never bumped for the row it made
    // live — and the service stays consistent with that: a repost of an already-live repost is a no-op.
    expect((await svc.repostPost(post.id, actor)).counts.reposts).toBe(0)
  })

  it("F087c: the same race driven through the REAL repostPost path leaves repost_count at exactly 1", async () => {
    const svc = makeService()
    const author = await newUser("Race Path Author")
    const actor = await newUser("Race Path Actor")
    const post = await svc.createPost(
      { kind: "post", body: "double tap me", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )

    // Unlike the statement-level test above, this drives the production repository so a regression that
    // moves the tombstone predicate back into a subselect is caught here. Repeated because the losing
    // transaction has to actually overlap the winner to exercise the re-check.
    for (let round = 0; round < 8; round++) {
      await svc.repostPost(post.id, actor)
      await svc.unrepostPost(post.id, actor)

      const settled = await Promise.allSettled([
        svc.repostPost(post.id, actor),
        svc.repostPost(post.id, actor),
      ])
      for (const outcome of settled) {
        expect(outcome.status, `round ${round}: ${JSON.stringify(outcome)}`).toBe("fulfilled")
      }

      const [counts] = await h.sql<{ repost_count: number }[]>`
        SELECT repost_count FROM posts WHERE id = ${post.id}
      `
      expect(counts!.repost_count, `round ${round}`).toBe(1)
      const live = await h.sql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM posts
        WHERE author_id = ${actor} AND kind = 'repost' AND repost_of_id = ${post.id}
          AND deleted_at IS NULL
      `
      expect(live[0]!.n, `round ${round}`).toBe(1)

      await svc.unrepostPost(post.id, actor)
      expect((await svc.getPost(post.id, author)).counts.reposts).toBe(0)
    }
  })

  it("create → get → like → repost → reply → save → delete round-trip with denormalized counts", async () => {
    const svc = makeService()
    const author = await newUser("Round Author")
    const actor = await newUser("Round Actor")

    const created = await svc.createPost(
      { kind: "post", body: "hello world", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    expect(created.kind).toBe("post")
    expect(created.body).toBe("hello world")
    expect(created.counts).toEqual({ likes: 0, reposts: 0, replies: 0, saves: 0 })

    // get by another viewer
    const fetched = await svc.getPost(created.id, actor)
    expect(fetched.id).toBe(created.id)
    expect(fetched.viewer).toEqual({ liked: false, reposted: false, saved: false })

    // like
    const liked = await svc.likePost(created.id, actor)
    expect(liked.counts.likes).toBe(1)
    expect(liked.viewer.liked).toBe(true)
    // idempotent (second like adds no count)
    expect((await svc.likePost(created.id, actor)).counts.likes).toBe(1)
    // author's view reflects the count but not the viewer flag
    expect((await svc.getPost(created.id, author)).viewer.liked).toBe(false)
    expect((await svc.getPost(created.id, author)).counts.likes).toBe(1)

    // repost (returns the target, patched)
    const reposted = await svc.repostPost(created.id, actor)
    expect(reposted.id).toBe(created.id)
    expect(reposted.counts.reposts).toBe(1)
    expect(reposted.viewer.reposted).toBe(true)
    // idempotent
    expect((await svc.repostPost(created.id, actor)).counts.reposts).toBe(1)

    // reply
    const reply = await svc.createPost(
      { kind: "reply", replyToId: created.id, body: "nice one", mediaUploadIds: [], mentionedUserIds: [] },
      actor,
    )
    expect(reply.kind).toBe("reply")
    expect(reply.replyToId).toBe(created.id)
    // The reply carries a PREVIEW of its parent, not just the id: a reply surfaced in the home feed has
    // to be able to say who it is replying to without a second fetch.
    expect(reply.replyTo?.id).toBe(created.id)
    expect(reply.replyTo?.author?.id).toBe(author)
    expect((await svc.getPost(created.id, author)).counts.replies).toBe(1)
    const replies = await svc.listReplies(created.id, author, {})
    expect(replies.items.map((p) => p.id)).toContain(reply.id)
    // ...and it survives the list projection too, not just the create response.
    expect(replies.items.find((p) => p.id === reply.id)?.replyTo?.id).toBe(created.id)

    // A top-level post has no parent to preview.
    expect((await svc.getPost(created.id, author)).replyTo ?? null).toBeNull()

    // save
    const saved = await svc.savePost(created.id, actor)
    expect(saved.counts.saves).toBe(1)
    expect(saved.viewer.saved).toBe(true)
    const saves = await svc.listSaves(actor, {})
    expect(saves.items.map((p) => p.id)).toContain(created.id)

    // delete (author-only)
    await expect(svc.deletePost(created.id, author)).resolves.toEqual({ ok: true })
    await expect(svc.getPost(created.id, author)).rejects.toMatchObject({ httpStatus: 404 })
  })

  it("CVX-001: a reply with kind defaulted to 'post' still increments the parent's reply_count", async () => {
    const svc = makeService()
    const author = await newUser("Reply Count Author", "rcauthor")
    const replier = await newUser("Reply Count Replier", "rcreplier")

    const parent = await svc.createPost(
      { kind: "post", body: "parent post", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    expect(parent.counts.replies).toBe(0)

    const reply = await svc.createPost(
      { kind: "post", replyToId: parent.id, body: "count me in", mediaUploadIds: [], mentionedUserIds: [] },
      replier,
    )
    expect(reply.replyToId).toBe(parent.id)

    expect((await svc.getPost(parent.id, author)).counts.replies).toBe(1)
    const replies = await svc.listReplies(parent.id, author, {})
    expect(replies.items.map((p) => p.id)).toContain(reply.id)

    const second = await svc.createPost(
      { kind: "post", replyToId: parent.id, body: "me too", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    expect((await svc.getPost(parent.id, author)).counts.replies).toBe(2)

    await svc.deletePost(second.id, author)
    expect((await svc.getPost(parent.id, author)).counts.replies).toBe(1)

    await svc.deletePost(reply.id, replier)
    expect((await svc.getPost(parent.id, author)).counts.replies).toBe(0)
  })

  it("CVX-001: a nested thread reports each post's OWN direct-child count (4-deep)", async () => {
    const svc = makeService()
    const author = await newUser("Nested Author", "nestauth")

    const chain: string[] = []
    let parentId: string | null = null
    for (let depth = 0; depth < 5; depth++) {
      const post = await svc.createPost(
        parentId === null
          ? { kind: "post", body: "root", mediaUploadIds: [], mentionedUserIds: [] }
          : { kind: "post", replyToId: parentId, body: `depth ${depth}`, mediaUploadIds: [], mentionedUserIds: [] },
        author,
      )
      chain.push(post.id)
      parentId = post.id
    }

    for (let depth = 0; depth < 4; depth++) {
      expect((await svc.getPost(chain[depth]!, author)).counts.replies).toBe(1)
    }
    expect((await svc.getPost(chain[4]!, author)).counts.replies).toBe(0)
  })

  it("CVX-001: an explicit kind:'reply' still counts, and cross-author replies count too", async () => {
    const svc = makeService()
    const author = await newUser("Explicit Author", "explauth")
    const other = await newUser("Explicit Other", "explother")

    const parent = await svc.createPost(
      { kind: "post", body: "topic", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )

    await svc.createPost(
      { kind: "reply", replyToId: parent.id, body: "explicit reply", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    await svc.createPost(
      { kind: "reply", replyToId: parent.id, body: "cross-author reply", mediaUploadIds: [], mentionedUserIds: [] },
      other,
    )

    expect((await svc.getPost(parent.id, other)).counts.replies).toBe(2)
    expect((await svc.listReplies(parent.id, other, {})).items).toHaveLength(2)
  })

  it("listReplies inlines the focal author's most recent live answer to each reply on the page", async () => {
    const svc = makeService()
    const author = await newUser("Answering Author")
    const other = await newUser("Answered Other")
    const reply = (replyToId: string, body: string, by: string) =>
      svc.createPost({ kind: "reply", replyToId, body, mediaUploadIds: [], mentionedUserIds: [] }, by)

    const post = await svc.createPost(
      { kind: "post", body: "root", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    const first = await reply(post.id, "first", other)
    const second = await reply(post.id, "second", other)
    await h.sql`UPDATE posts SET created_at = created_at + interval '1 second' WHERE id = ${second.id}`
    const older = await reply(first.id, "older answer", author)
    const latest = await reply(first.id, "latest answer", author)
    await h.sql`UPDATE posts SET created_at = created_at + interval '1 minute' WHERE id = ${latest.id}`
    await reply(second.id, "not the author", other)
    await reply(latest.id, "deeper", author)
    await h.sql`
      UPDATE posts SET created_at = date_trunc('milliseconds', created_at)
      WHERE id IN (${first.id}, ${second.id})
    `

    const page = await svc.listReplies(post.id, other, {})
    expect(page.items.map((p) => p.id)).toEqual([first.id, second.id])
    expect(page.authorReplies.map((p) => p.id)).toEqual([latest.id])
    expect(page.authorReplies[0]?.replyToId).toBe(first.id)
    expect(page.authorReplies[0]?.author.id).toBe(author)

    const head = await svc.listReplies(post.id, other, { limit: 1 })
    expect(head.items.map((p) => p.id)).toEqual([first.id])
    expect(head.authorReplies.map((p) => p.id)).toEqual([latest.id])
    const tail = await svc.listReplies(post.id, other, { limit: 1, cursor: head.nextCursor ?? undefined })
    expect(tail.items.map((p) => p.id)).toEqual([second.id])
    expect(tail.authorReplies).toEqual([])

    await svc.deletePost(latest.id, author)
    expect((await svc.listReplies(post.id, other, {})).authorReplies.map((p) => p.id)).toEqual([older.id])

    const inner = await svc.listReplies(first.id, author, {})
    expect(inner.items.map((p) => p.id)).toEqual([older.id])
    expect(inner.authorReplies).toEqual([])
  })

  // --- post media: the 0054 CHECK bug + the claim predicate --------------------------------------
  // Every createPost in this file used to pass mediaUploadIds: [], so the claim path
  // (`UPDATE media_assets SET post_id = $1, purpose = 'post'`) was NEVER exercised — and it could not
  // succeed: 0051 introduced purpose='post' in the mirror, the shared enum and the claim SQL, but no
  // migration widened the inline CHECK 0016 added (purpose IN ('report','verification')). Every post with
  // a photo raised 23514, aborted the create transaction and 500'd. 0054_media_purpose_post.sql widened
  // the CHECK; these are the tests that keep it widened.
  // (The value-set half of the same class is guarded schema-wide in test/integration/schema.test.ts.)

  it("creates a post WITH media: the asset is claimed (post_id + purpose='post') and renders on the DTO", async () => {
    const svc = makeService()
    const author = await newUser("Media Author", "medauth")
    const reader = await newUser("Media Reader", "medread")
    const media = await seedMedia()

    const created = await svc.createPost(
      { kind: "post", body: "look at this photo", mediaUploadIds: [media.uploadId], mentionedUserIds: [] },
      author,
    )
    expect(created.media).toHaveLength(1)
    expect(created.media[0]!.id).toBe(media.id)
    expect(created.media[0]!.kind).toBe("image")
    expect(created.media[0]!.status).toBe("ready")
    // The repo hands the keys to the service to presign; the echo presigner in this file makes the
    // mapping visible, which also proves the thumb key round-tripped.
    expect(created.media[0]!.url).toBe(`m://${media.servedKey}`)
    expect(created.media[0]!.thumbUrl).toBe(`m://${media.thumbKey}`)

    // The claim landed in the database: bound to THIS post, repurposed, and still unbound to any report.
    const [row] = await h.sql<{ post_id: string | null; purpose: string; report_id: string | null }[]>`
      SELECT post_id, purpose, report_id FROM media_assets WHERE id = ${media.id}
    `
    expect(row!.post_id).toBe(created.id)
    expect(row!.purpose).toBe("post")
    expect(row!.report_id).toBeNull()

    // Another viewer sees the same gallery (media is not viewer-scoped).
    const fetched = await svc.getPost(created.id, reader)
    expect(fetched.media.map((m) => m.id)).toEqual([media.id])
  })

  // A quote card renders the post it quotes. Without the ref carrying its own media, quoting a photo post
  // showed a bare excerpt with the actual subject invisible.
  it("carries the quoted post's OWN media on the ref, and blanks it for a deleted target", async () => {
    const svc = makeService()
    const author = await newUser("Quote Target", "qtarget")
    const quoter = await newUser("Quoter", "qquoter")
    const media = await seedMedia()

    const target = await svc.createPost(
      { kind: "post", body: "the original photo", mediaUploadIds: [media.uploadId], mentionedUserIds: [] },
      author,
    )
    const quote = await svc.createPost(
      { kind: "quote", repostOfId: target.id, body: "look at this", mediaUploadIds: [], mentionedUserIds: [] },
      quoter,
    )

    expect(quote.repostOf?.id).toBe(target.id)
    expect(quote.repostOf?.media.map((m) => m.id)).toEqual([media.id])
    expect(quote.repostOf?.media[0]!.url).toBe(`m://${media.servedKey}`)
    // The quote itself still has none of its own.
    expect(quote.media).toEqual([])

    // It survives the LIST projection too, not just the create response.
    const listed = await svc.listUserPosts(quoter, quoter, {})
    expect(listed.items.find((p) => p.id === quote.id)?.repostOf?.media.map((m) => m.id)).toEqual([media.id])

    // Deleting the target tombstones the ref: no excerpt AND no media. Surfacing a deleted post's photos
    // through a quote card would undo the delete. (`getPost` on the quote 404s instead - `requireReadable`
    // treats a quote of a deleted target as unreadable - so the tombstone is only observable in a list.)
    await svc.deletePost(target.id, author)
    await expect(svc.getPost(quote.id, quoter)).rejects.toThrow(/not found/i)

    const afterDelete = await svc.listUserPosts(quoter, quoter, {})
    const tombstoned = afterDelete.items.find((p) => p.id === quote.id)
    expect(tombstoned?.repostOf?.deleted).toBe(true)
    expect(tombstoned?.repostOf?.excerpt).toBe("")
    expect(tombstoned?.repostOf?.media).toEqual([])
  })

  it("REJECTS (422) a post whose media is already claimed by another post, leaving it on the first", async () => {
    const svc = makeService()
    const author = await newUser("Claim First", "claim1")
    const thief = await newUser("Claim Second", "claim2")
    const media = await seedMedia()

    const first = await svc.createPost(
      { kind: "post", body: "mine", mediaUploadIds: [media.uploadId], mentionedUserIds: [] },
      author,
    )
    await expect(
      svc.createPost(
        { kind: "post", body: "also mine?", mediaUploadIds: [media.uploadId], mentionedUserIds: [] },
        thief,
      ),
    ).rejects.toMatchObject({
      httpStatus: 422,
      code: "VALIDATION",
      fields: { mediaUploadIds: "One or more media uploads are unavailable." },
    })

    const [row] = await h.sql<{ post_id: string | null }[]>`
      SELECT post_id FROM media_assets WHERE id = ${media.id}
    `
    expect(row!.post_id).toBe(first.id)
    // The rejected create rolled back completely — no orphan post row for the thief.
    const posts = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM posts WHERE author_id = ${thief}
    `
    expect(posts[0]!.n).toBe(0)
  })

  it("REJECTS (422) an UNKNOWN upload id and a REJECTED asset, creating no post either way", async () => {
    const svc = makeService()
    const author = await newUser("Bad Media", "badmed")
    const rejected = await seedMedia("rejected")

    for (const uploadId of [randomUUID(), rejected.uploadId]) {
      await expect(
        svc.createPost(
          { kind: "post", body: "nope", mediaUploadIds: [uploadId], mentionedUserIds: [] },
          author,
        ),
      ).rejects.toMatchObject({ httpStatus: 422, code: "VALIDATION" })
    }

    const posts = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM posts WHERE author_id = ${author}
    `
    expect(posts[0]!.n).toBe(0)
    // The rejected asset was not repurposed on the way out.
    const [row] = await h.sql<{ post_id: string | null; purpose: string }[]>`
      SELECT post_id, purpose FROM media_assets WHERE id = ${rejected.id}
    `
    expect(row!.post_id).toBeNull()
    expect(row!.purpose).toBe("report")
  })

  it("F087e: REJECTS (422) a post whose media is VALIDATING but never finalized", async () => {
    const svc = makeService()
    const author = await newUser("Unfinalized Poster", "unfinal")
    const media = await seedMedia("validating")

    // media_assets rows are born 'validating' at PRESIGN time. Claiming one before finalize bound an
    // asset with no bytes and no media.checks job behind it — invisible to the orphan sweep (bound) and
    // to the stuck sweep (no finalized_at watermark), so nothing would ever have reclaimed it.
    await expect(
      svc.createPost(
        { kind: "post", body: "too early", mediaUploadIds: [media.uploadId], mentionedUserIds: [] },
        author,
      ),
    ).rejects.toMatchObject({ httpStatus: 422, code: "VALIDATION" })

    const [unbound] = await h.sql<{ post_id: string | null; purpose: string }[]>`
      SELECT post_id, purpose FROM media_assets WHERE id = ${media.id}
    `
    expect(unbound!.post_id).toBeNull()
    expect(unbound!.purpose).toBe("report")

    // Once finalize stamps the watermark the same still-validating asset claims normally.
    await h.sql`UPDATE media_assets SET finalized_at = now() WHERE id = ${media.id}`
    const created = await svc.createPost(
      { kind: "post", body: "now ok", mediaUploadIds: [media.uploadId], mentionedUserIds: [] },
      author,
    )
    const [bound] = await h.sql<{ post_id: string | null }[]>`
      SELECT post_id FROM media_assets WHERE id = ${media.id}
    `
    expect(bound!.post_id).toBe(created.id)
  })

  it("REJECTS (422) an asset already bound to a REPORT (no cross-publishing into the feed)", async () => {
    const svc = makeService()
    const author = await newUser("Cross Publisher", "crosspub")
    const media = await seedMedia()
    const report = await insertReport(author, "published", "public", "Report with a photo")
    await h.sql`UPDATE media_assets SET report_id = ${report} WHERE id = ${media.id}`

    await expect(
      svc.createPost(
        { kind: "post", body: "recycling a report photo", mediaUploadIds: [media.uploadId], mentionedUserIds: [] },
        author,
      ),
    ).rejects.toMatchObject({ httpStatus: 422, code: "VALIDATION" })

    const [row] = await h.sql<{ report_id: string | null; post_id: string | null; purpose: string }[]>`
      SELECT report_id, post_id, purpose FROM media_assets WHERE id = ${media.id}
    `
    expect(row!.report_id).toBe(report)
    expect(row!.post_id).toBeNull()
    expect(row!.purpose).toBe("report")
  })

  it("attaches MULTIPLE assets in upload order and tolerates a repeated id (deduped, claimed once)", async () => {
    const svc = makeService()
    const author = await newUser("Gallery Author", "gallauth")
    const a = await seedMedia()
    const b = await seedMedia()

    const created = await svc.createPost(
      {
        kind: "post",
        body: "two photos",
        // `a` repeated: the claim compares against the DEDUPED input, so this must NOT 422.
        mediaUploadIds: [a.uploadId, b.uploadId, a.uploadId],
        mentionedUserIds: [],
      },
      author,
    )
    // loadMedia orders by created_at ASC, so the gallery reads in upload order.
    expect(created.media.map((m) => m.id)).toEqual([a.id, b.id])

    const rows = await h.sql<{ id: string; post_id: string | null }[]>`
      SELECT id, post_id FROM media_assets WHERE id = ANY(${[a.id, b.id]}::uuid[])
    `
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.post_id === created.id)).toBe(true)
  })

  it("delete is author-only (403 for a non-author)", async () => {
    const svc = makeService()
    const author = await newUser("Owner")
    const other = await newUser("Intruder")
    const post = await svc.createPost(
      { kind: "post", body: "mine", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    await expect(svc.deletePost(post.id, other)).rejects.toMatchObject({ httpStatus: 403 })
    // still there
    expect((await svc.getPost(post.id, author)).id).toBe(post.id)
  })

  it("home feed fans out from follows + self, excluding non-followed authors", async () => {
    const svc = makeService()
    const viewer = await newUser("Feed Viewer")
    const followed = await newUser("Feed Followed")
    const stranger = await newUser("Feed Stranger")
    await h.sql`INSERT INTO follows_people (follower_id, followee_id) VALUES (${viewer}, ${followed})`

    const mine = await svc.createPost(
      { kind: "post", body: "self", mediaUploadIds: [], mentionedUserIds: [] },
      viewer,
    )
    const theirs = await svc.createPost(
      { kind: "post", body: "followed", mediaUploadIds: [], mentionedUserIds: [] },
      followed,
    )
    const hidden = await svc.createPost(
      { kind: "post", body: "stranger", mediaUploadIds: [], mentionedUserIds: [] },
      stranger,
    )

    const feed = await svc.homeFeed(viewer, { filter: "all" })
    const ids = feed.items.map((p) => p.id)
    expect(ids).toContain(mine.id)
    expect(ids).toContain(theirs.id)
    expect(ids).not.toContain(hidden.id)
  })

  // --- REGRESSION: replies must never reach the timeline -------------------------------------------
  // `homeFeed` shipped WITHOUT the `AND p.reply_to_id IS NULL` term that `publicFeed` has always carried,
  // so a signed-OUT reader got a clean timeline and a signed-IN reader got a reply dump. This is the only
  // suite that executes the changed query (the route tests run against an in-memory fake), and it has to
  // cover BOTH arms of the home-feed OR: the viewer's own reply arrives via `p.author_id = viewerId`, a
  // followed author's via the follows_people subquery, and a test that seeds only one leaves the other
  // unproven — which is exactly how the bug survived the fan-out test above.
  it("home feed is TOP-LEVEL only: a reply never reaches the timeline, only the thread", async () => {
    const svc = makeService()
    const viewer = await newUser("Reply Viewer")
    const author = await newUser("Reply Author")
    await h.sql`INSERT INTO follows_people (follower_id, followee_id) VALUES (${viewer}, ${author})`

    const parent = await svc.createPost(
      { kind: "post", body: "the original thought", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    // Arm 1: an author the viewer FOLLOWS replies.
    const theirReply = await svc.createPost(
      { kind: "reply", replyToId: parent.id, body: "count me in", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    // Arm 2: the VIEWER themself replies (the `p.author_id = viewerId` arm).
    const myReply = await svc.createPost(
      { kind: "reply", replyToId: parent.id, body: "me too", mediaUploadIds: [], mentionedUserIds: [] },
      viewer,
    )
    expect(theirReply.replyToId).toBe(parent.id)
    expect(myReply.replyToId).toBe(parent.id)

    const homeIds = (await svc.homeFeed(viewer, { filter: "all" })).items.map((p) => p.id)
    expect(homeIds).toContain(parent.id)
    expect(homeIds).not.toContain(theirReply.id)
    expect(homeIds).not.toContain(myReply.id)

    // The signed-out feed agrees — the whole point of reusing publicFeed's exact predicate is that the two
    // timelines can no longer disagree about what a timeline row IS.
    const publicIds = (await svc.publicFeed({ filter: "all" })).items.map((p) => p.id)
    expect(publicIds).toContain(parent.id)
    expect(publicIds).not.toContain(theirReply.id)
    expect(publicIds).not.toContain(myReply.id)

    // Nothing was hidden, only relocated: the thread still holds both replies...
    const threadIds = (await svc.listReplies(parent.id, viewer, {})).items.map((p) => p.id)
    expect(threadIds).toContain(theirReply.id)
    expect(threadIds).toContain(myReply.id)
    // ...and a reply is still readable by permalink (notification deep links land here).
    expect((await svc.getPost(theirReply.id, viewer)).id).toBe(theirReply.id)

    // THE DELIBERATE CARVE-OUT: a REPOST of a reply stays in the timeline. The repost's own row is
    // `kind='repost', repost_of_id=<the reply>, reply_to_id=NULL`, so `reply_to_id IS NULL` keeps it —
    // amplifying is a deliberate act by someone the viewer follows, exactly as on Twitter. Pinned here so
    // a future "tighten the predicate" pass has to change this assertion on purpose.
    await svc.repostPost(theirReply.id, viewer)
    const [repostRow] = await h.sql<{ id: string }[]>`
      SELECT id FROM posts
      WHERE author_id = ${viewer} AND kind = 'repost' AND repost_of_id = ${theirReply.id}
    `
    expect(repostRow?.id).toBeTruthy()
    const afterRepost = (await svc.homeFeed(viewer, { filter: "all" })).items.map((p) => p.id)
    expect(afterRepost).toContain(repostRow!.id)
    expect(afterRepost).not.toContain(theirReply.id)
  })

  it("a reply composed WITHOUT kind:'reply' is stored as one, and never reaches the Posts tab", async () => {
    const svc = makeService()
    const author = await newUser("Kindless Author")
    const replier = await newUser("Kindless Replier")

    const parent = await svc.createPost(
      { kind: "post", body: "the original thought", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    const reply = await svc.createPost(
      { kind: "post", replyToId: parent.id, body: "count me in", mediaUploadIds: [], mentionedUserIds: [] },
      replier,
    )

    const [stored] = await h.sql<{ kind: string; reply_to_id: string | null }[]>`
      SELECT kind, reply_to_id FROM posts WHERE id = ${reply.id}
    `
    expect(stored).toEqual({ kind: "reply", reply_to_id: parent.id })
    expect((await svc.getPost(parent.id, author)).counts.replies).toBe(1)

    const profileIds = (await svc.listUserPosts(replier, replier, {})).items.map((p) => p.id)
    expect(profileIds).not.toContain(reply.id)
    const threadIds = (await svc.listReplies(parent.id, replier, {})).items.map((p) => p.id)
    expect(threadIds).toContain(reply.id)

    const [legacy] = await h.sql<{ id: string }[]>`
      INSERT INTO posts (author_id, kind, body, reply_to_id, thread_root_id)
      VALUES (${replier}, 'post', 'pre-normalization row', ${parent.id}, ${parent.id})
      RETURNING id
    `
    const withLegacy = (await svc.listUserPosts(replier, replier, {})).items.map((p) => p.id)
    expect(withLegacy).not.toContain(legacy!.id)
  })

  it("attaching an event requires membership (member ok, non-member 403)", async () => {
    const svc = makeService()
    const cleanupSvc = makeCleanupService({ repo: makeDrizzleCleanupRepository(h.sql) })
    const host = await newUser("Event Host", "evthost")
    const outsider = await newUser("Event Outsider", "evtout")

    const event = await cleanupSvc.createCleanup(
      { title: "Park Sweep", type: "site", eventKind: "cleanup", lat: 34.0, lng: -118.0, scheduledAt: "2025-06-01T10:00:00.000Z" },
      host,
    )

    // host is auto-joined as organizer → can attach
    const withEvent = await svc.createPost(
      { kind: "post", body: "join us", eventId: event.id, mediaUploadIds: [], mentionedUserIds: [] },
      host,
    )
    expect(withEvent.event?.id).toBe(event.id)
    expect(withEvent.event?.title).toBe("Park Sweep")

    // an outsider cannot attach an event they neither host nor attend
    await expect(
      svc.createPost(
        { kind: "post", body: "nope", eventId: event.id, mediaUploadIds: [], mentionedUserIds: [] },
        outsider,
      ),
    ).rejects.toMatchObject({ httpStatus: 403 })
  })

  // --- "announce to the feed": the event auto-link ------------------------------------------------
  // The create-an-event flow files the cleanup and then posts `{ eventId }` on the SAME wire surface a
  // manual composer attachment uses. Two things have to hold for that to work with no server change:
  // the organizer's `cleanup_members` row must exist in the SAME commit as the cleanup (otherwise the
  // immediately-following createPost 403s on isEventMember), and the resulting post must reach the
  // `events` filter, whose predicate is `p.event_id IS NOT NULL`.

  it("ANNOUNCE: the organizer can attach the event they just created, and the post lands in the `events` filter", async () => {
    const svc = makeService()
    const cleanupSvc = makeCleanupService({ repo: makeDrizzleCleanupRepository(h.sql) })
    const host = await newUser("Announce Host", "annhost")
    const viewer = await newUser("Announce Viewer", "annview")
    await h.sql`INSERT INTO follows_people (follower_id, followee_id) VALUES (${viewer}, ${host})`

    const event = await cleanupSvc.createCleanup(
      { title: "Alley Sweep", type: "site", eventKind: "cleanup", lat: 34.05, lng: -118.25, scheduledAt: "2026-08-01T17:00:00.000Z" },
      host,
    )

    // The organizer membership row is written inside createCleanupTx — this is what makes the very next
    // createPost legal with no wait and no retry.
    const [member] = await h.sql<{ role: string }[]>`
      SELECT role FROM cleanup_members WHERE cleanup_id = ${event.id} AND user_id = ${host}
    `
    expect(member?.role).toBe("organizer")

    const announcement = await svc.createPost(
      { kind: "post", body: "come help out", eventId: event.id, mediaUploadIds: [], mentionedUserIds: [] },
      host,
    )
    expect(announcement.event?.id).toBe(event.id)
    expect(announcement.event?.title).toBe("Alley Sweep")

    const plain = await svc.createPost(
      { kind: "post", body: "no event at all", mediaUploadIds: [], mentionedUserIds: [] },
      host,
    )

    const events = await svc.homeFeed(viewer, { filter: "events" })
    const eventIds = events.items.map((p) => p.id)
    expect(eventIds).toContain(announcement.id)
    expect(eventIds).not.toContain(plain.id)

    // Signed-out readers see it too — that is the reach the announcement buys.
    const publicEvents = await svc.publicFeed({ filter: "events" })
    expect(publicEvents.items.map((p) => p.id)).toContain(announcement.id)

    // ...and it is NOT a "fix": the events post has no report.
    expect((await svc.homeFeed(viewer, { filter: "fixes" })).items.map((p) => p.id)).not.toContain(
      announcement.id,
    )
  })

  // --- H8: post report-attachment bypassed the report visibility gate ------------------------------
  // Two independent holes, both now closed by the shared publicReportFilter() fragment:
  //   (a) isReportAttachable checked `visibility` but NOT `status`, so an anonymous submitter could
  //       attach their own HELD (pre-moderation) report and publish its title, exact lat/lng, address
  //       and photo into the SIGNED-OUT public feed before any moderator saw it;
  //   (b) loadReports re-read the row on every render checking NEITHER, so the owner's later `unlist`
  //       was silently ineffective for as long as the post existed.

  async function insertReport(
    reporter: string | null,
    status: string,
    visibility: string,
    title: string,
  ): Promise<string> {
    const [r] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (reporter_user_id, idempotency_key, geom, geom_source, category, status, visibility, h3_cell, title)
      VALUES (
        ${reporter}, gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.35,34.1),4326), 'manual',
        'trash', ${status}, ${visibility}, 'h0', ${title}
      )
      RETURNING id
    `
    return r!.id
  }

  it("H8: a HELD report cannot be attached to a post (status was never checked)", async () => {
    const svc = makeService()
    const author = await newUser("Held Attacher", "heldatt")
    const held = await insertReport(author, "held", "public", "Held report")

    await expect(
      svc.createPost(
        { kind: "post", body: "look at this", reportId: held, mediaUploadIds: [], mentionedUserIds: [] },
        author,
      ),
    ).rejects.toMatchObject({ httpStatus: 404 })
  })

  it("H8: an owner-UNLISTED and a soft-DELETED report are equally unattachable", async () => {
    const svc = makeService()
    const author = await newUser("Unlist Attacher", "unlatt")
    const unlisted = await insertReport(author, "published", "hidden", "Unlisted report")
    const deleted = await insertReport(author, "published", "public", "Deleted report")
    await h.sql`UPDATE reports SET deleted_at = now() WHERE id = ${deleted}`

    for (const id of [unlisted, deleted]) {
      await expect(
        svc.createPost(
          { kind: "post", body: "look", reportId: id, mediaUploadIds: [], mentionedUserIds: [] },
          author,
        ),
      ).rejects.toMatchObject({ httpStatus: 404 })
    }
  })

  it("H8: a later unlist RETROACTIVELY strips the attachment card from the rendered post", async () => {
    const svc = makeService()
    const author = await newUser("Retro Author", "retroauth")
    const reader = await newUser("Retro Reader", "retroread")
    const report = await insertReport(author, "published", "public", "Public report")

    const post = await svc.createPost(
      { kind: "post", body: "my report", reportId: report, mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    expect(post.report?.id).toBe(report)
    expect(post.report?.title).toBe("Public report")

    // The owner unlists it. This USED to change nothing about the rendered post: loadReports re-read the
    // row every render and re-published the title, exact coordinates, address and photo regardless.
    await h.sql`UPDATE reports SET visibility = 'hidden' WHERE id = ${report}`

    const afterUnlist = await svc.getPost(post.id, reader)
    expect(afterUnlist.report).toBeNull()
    // The post itself survives — hydrate degrades it to a body-only post rather than dropping the row.
    expect(afterUnlist.id).toBe(post.id)
    expect(afterUnlist.body).toBe("my report")

    // Same for a moderator pulling it back to `held`, and for a soft delete.
    await h.sql`UPDATE reports SET visibility = 'public', status = 'held' WHERE id = ${report}`
    expect((await svc.getPost(post.id, reader)).report).toBeNull()
    await h.sql`UPDATE reports SET status = 'published' WHERE id = ${report}`
    expect((await svc.getPost(post.id, reader)).report?.id).toBe(report)
    await h.sql`UPDATE reports SET deleted_at = now() WHERE id = ${report}`
    expect((await svc.getPost(post.id, reader)).report).toBeNull()
  })

  // --- "share to the feed": the report auto-link, and the THUMB RACE ------------------------------
  // The report flow files the report and then posts `{ reportId }` 200-400 ms later. At that moment the
  // report's photo has been finalized but the media-checks worker has NOT flipped it to `ready`, and
  // firstReadyStillLateral hard-requires `status = 'ready'`. So the authoritative PostDTO comes back with
  // NO thumbUrl, and only a LATER read (after the worker lands) presigns one. Any client that paints an
  // optimistic thumbnail and then trusts the server row will make the photo appear and then vanish; this
  // test is the pin for that timing, so a client-side local-thumb overlay cannot be "optimized away".

  /** A report-bound media asset in the state finalizeMedia leaves behind: `validating`, not `ready`. */
  async function attachReportMedia(reportId: string, status: SeedMediaStatus): Promise<SeededMedia> {
    const uploadId = randomUUID()
    return await seedMediaAsset(h.sql, {
      reportId,
      uploadId,
      r2Key: `uploads/report/${uploadId}`,
      thumbKey: `uploads/report/${uploadId}.thumb`,
      status,
      purpose: "report",
      byteSize: 4096,
      width: 1200,
      height: 900,
    })
  }

  it("SHARE: a freshly filed report attaches and hydrates, but its still-VALIDATING photo yields NO thumbUrl until the worker lands", async () => {
    const svc = makeService()
    const author = await newUser("Share Author", "shrauth")
    const reader = await newUser("Share Reader", "shrread")
    const reportId = await insertReport(author, "published", "public", "Couch on the sidewalk")
    await h.sql`UPDATE reports SET addr = '123 Main St' WHERE id = ${reportId}`
    // Exactly what media-intake leaves behind when the wizard submits: finalized, checks still queued.
    const asset = await attachReportMedia(reportId, "validating")

    // The caption is optional on the wire: an attachment-only post is legal (PostComposeInputSchema's
    // superRefine is satisfied by hasAttachment), which is what a blank caption ships.
    const post = await svc.createPost(
      { kind: "post", reportId, mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    expect(post.body).toBeNull()
    expect(post.report?.id).toBe(reportId)
    expect(post.report?.title).toBe("Couch on the sidewalk")
    expect(post.report?.addr).toBe("123 Main St")
    expect(post.report?.status).toBe("published")
    expect(post.report?.lat).toBeCloseTo(34.1, 5)
    expect(post.report?.lng).toBeCloseTo(-118.35, 5)
    // THE RACE: the photo exists, is bound to the report, and is still invisible to the feed card.
    expect(post.report?.thumbUrl ?? null).toBeNull()

    // A refetch while the asset is still validating does NOT rescue it — so an "invalidate and refetch"
    // repair on the client is not a fix either.
    expect((await svc.getPost(post.id, reader)).report?.thumbUrl ?? null).toBeNull()

    // Once the media-checks worker flips the asset, the very next read presigns the real thumb, with no
    // write to the post and no cache bust on the server side.
    await publishMediaAsReady(h.sql, asset.id)
    const afterWorker = await svc.getPost(post.id, reader)
    expect(afterWorker.report?.thumbUrl).toBeTruthy()
    expect(afterWorker.report?.thumbUrl).toContain(".thumb")

    // A brand-new report is `published`, so the post is an "all" post, never a "fix" — it migrates into
    // the fixes filter by itself the day the city resolves the report.
    await h.sql`INSERT INTO follows_people (follower_id, followee_id) VALUES (${reader}, ${author})`
    expect((await svc.homeFeed(reader, { filter: "all" })).items.map((p) => p.id)).toContain(post.id)
    expect((await svc.homeFeed(reader, { filter: "fixes" })).items.map((p) => p.id)).not.toContain(
      post.id,
    )
    await h.sql`UPDATE reports SET status = 'resolved' WHERE id = ${reportId}`
    expect((await svc.homeFeed(reader, { filter: "fixes" })).items.map((p) => p.id)).toContain(post.id)
  })

  it("SHARE: a slur in the caption is rejected and NO post row is written", async () => {
    const svc = makeService()
    const author = await newUser("Slur Author", "slurauth")
    const reportId = await insertReport(author, "published", "public", "Broken light")

    await expect(
      svc.createPost(
        { kind: "post", body: "these retards again", reportId, mediaUploadIds: [], mentionedUserIds: [] },
        author,
      ),
    ).rejects.toMatchObject({ httpStatus: 422, code: "VALIDATION" })

    const rows = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM posts WHERE author_id = ${author}
    `
    expect(rows[0]?.n).toBe(0)

    // The same caption without the slur posts fine — the filter is slurs only, not profanity.
    const ok = await svc.createPost(
      { kind: "post", body: "this damn light again", reportId, mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    expect(ok.report?.id).toBe(reportId)
  })

  // --- the `fixes` filter x report-card regression guard (H8-b) -----------------------------------
  // H8's first fix routed BOTH post report paths through publicReportFilter(), whose status set was
  // `status = 'published'` EXACTLY. That made the product's headline surface structurally unrenderable:
  // the feeds' `fixes` filter selects posts whose report is `resolved`, so every post the filter could
  // return was simultaneously stripped of the report card it exists to show — and `isReportAttachable`
  // 404'd any attempt to create one in the first place. PUBLIC_REPORT_STATUSES now widens the predicate
  // to published/acknowledged/in_progress/resolved (a report stays public while the city works it), and
  // these tests are the guard: they FAIL if that set is ever narrowed back to 'published'.

  it("FIXES FILTER: a RESOLVED report is attachable and its post renders the report card", async () => {
    const svc = makeService()
    const author = await newUser("Fix Author", "fixauth")
    const reader = await newUser("Fix Reader", "fixread")
    const resolved = await insertReport(author, "resolved", "public", "Pothole fixed")

    // isReportAttachable must accept `resolved` — this is the create that used to 404.
    const post = await svc.createPost(
      { kind: "post", body: "the city fixed it", reportId: resolved, mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    expect(post.report?.id).toBe(resolved)
    expect(post.report?.title).toBe("Pothole fixed")
    expect(post.report?.status).toBe("resolved")

    // ...and loadReports must still render the card on a later read, for a different viewer.
    const rendered = await svc.getPost(post.id, reader)
    expect(rendered.report?.id).toBe(resolved)
    expect(rendered.report?.status).toBe("resolved")
  })

  it("FIXES FILTER: every mid-lifecycle public status is attachable and renders; pre-publication is not", async () => {
    const svc = makeService()
    const author = await newUser("Lifecycle Author", "lifeauth")

    // The whole public set: a report stays visible while the city works it.
    for (const status of ["published", "acknowledged", "in_progress", "resolved"]) {
      const id = await insertReport(author, status, "public", `Report ${status}`)
      const post = await svc.createPost(
        { kind: "post", body: `status ${status}`, reportId: id, mediaUploadIds: [], mentionedUserIds: [] },
        author,
      )
      expect(post.report?.id, `attach failed for status ${status}`).toBe(id)
      expect((await svc.getPost(post.id, author)).report?.status).toBe(status)
    }

    // The pre-publication + moderator-rejected states stay unattachable (the H8 half must not regress).
    for (const status of ["submitted", "held", "rejected"]) {
      const id = await insertReport(author, status, "public", `Report ${status}`)
      await expect(
        svc.createPost(
          { kind: "post", body: `status ${status}`, reportId: id, mediaUploadIds: [], mentionedUserIds: [] },
          author,
        ),
      ).rejects.toMatchObject({ httpStatus: 404 })
    }
  })

  it("FIXES FILTER: the home + public feeds return the resolved-report post and exclude non-resolved ones", async () => {
    const svc = makeService()
    const author = await newUser("Feed Fix Author", "ffauth")
    const viewer = await newUser("Feed Fix Viewer", "ffview")
    await h.sql`INSERT INTO follows_people (follower_id, followee_id) VALUES (${viewer}, ${author})`

    const resolved = await insertReport(author, "resolved", "public", "Fixed thing")
    const working = await insertReport(author, "in_progress", "public", "Still being worked")

    const fixPost = await svc.createPost(
      { kind: "post", body: "fixed!", reportId: resolved, mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    const wipPost = await svc.createPost(
      { kind: "post", body: "in progress", reportId: working, mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    const plainPost = await svc.createPost(
      { kind: "post", body: "no report at all", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )

    const home = await svc.homeFeed(viewer, { filter: "fixes" })
    const homeIds = home.items.map((p) => p.id)
    expect(homeIds).toContain(fixPost.id)
    expect(homeIds).not.toContain(wipPost.id)
    expect(homeIds).not.toContain(plainPost.id)
    // THE regression the widened predicate exists for: the returned item carries its report card, so the
    // filter and the renderer agree. Under `status = 'published'` this was null on every fixes-filter row.
    expect(home.items.find((p) => p.id === fixPost.id)?.report?.id).toBe(resolved)

    // Same for the signed-out public feed (no viewer, no follow scope).
    const publicFeed = await svc.publicFeed({ filter: "fixes" })
    const publicIds = publicFeed.items.map((p) => p.id)
    expect(publicIds).toContain(fixPost.id)
    expect(publicIds).not.toContain(wipPost.id)
    expect(publicFeed.items.find((p) => p.id === fixPost.id)?.report?.title).toBe("Fixed thing")

    // Unfiltered, all three are in the home feed — so the exclusions above are the filter, not visibility.
    const all = await svc.homeFeed(viewer, { filter: "all" })
    const allIds = all.items.map((p) => p.id)
    expect(allIds).toContain(fixPost.id)
    expect(allIds).toContain(wipPost.id)
    expect(allIds).toContain(plainPost.id)
    // ...and the in_progress report ALSO renders its card (mid-lifecycle is public, just not a "fix").
    expect(all.items.find((p) => p.id === wipPost.id)?.report?.id).toBe(working)
  })

  it("FIXES FILTER: unlisting/soft-deleting the resolved report drops the card but keeps the fixes match", async () => {
    // The filter reads `reports.status` directly while the CARD goes through publicReportFilter, so the two
    // can legitimately disagree once the owner unlists. Pinned so the degraded state is deliberate: the post
    // stays in the fixes feed (its report IS resolved) but publishes nothing about the report.
    const svc = makeService()
    const author = await newUser("Fix Unlist Author", "fuauth")
    const viewer = await newUser("Fix Unlist Viewer", "fuview")
    await h.sql`INSERT INTO follows_people (follower_id, followee_id) VALUES (${viewer}, ${author})`
    const resolved = await insertReport(author, "resolved", "public", "Fixed then hidden")

    const post = await svc.createPost(
      { kind: "post", body: "fixed", reportId: resolved, mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )
    expect(post.report?.id).toBe(resolved)

    await h.sql`UPDATE reports SET visibility = 'hidden' WHERE id = ${resolved}`
    const home = await svc.homeFeed(viewer, { filter: "fixes" })
    const item = home.items.find((p) => p.id === post.id)
    expect(item).toBeDefined()
    expect(item?.report).toBeNull()
    expect(item?.body).toBe("fixed")
  })

  it("like notifies the post author (not self); blocked → none; @mention notifies the mentioned user", async () => {
    const svc = makeService()
    const author = await newUser("Notif Author", "notauth")
    const actor = await newUser("Notif Actor", "notactor")
    const mentioned = await newUser("Notif Mentioned", "notment")

    const post = await svc.createPost(
      { kind: "post", body: "notify me", mediaUploadIds: [], mentionedUserIds: [] },
      author,
    )

    // actor likes → author gets ONE post_like notification
    await svc.likePost(post.id, actor)
    const authorNotifs = await notifRepo.listNotifications(author, null, 50)
    const likeNotifs = authorNotifs.records.filter((n) => n.type === "post_like")
    expect(likeNotifs).toHaveLength(1)

    // self-like → no new notification for the actor
    await svc.likePost(post.id, author)
    const actorNotifs = await notifRepo.listNotifications(author, null, 50)
    // author still has exactly one post_like (their own self-like produced none)
    expect(actorNotifs.records.filter((n) => n.type === "post_like")).toHaveLength(1)

    // blocked either way → the post is hidden and cannot be interacted with
    const blocker = await newUser("Blocker")
    await h.sql`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (${author}, ${blocker})`
    await expect(svc.likePost(post.id, blocker)).rejects.toMatchObject({ code: "NOT_FOUND" })
    const afterBlock = await notifRepo.listNotifications(author, null, 50)
    expect(afterBlock.records.filter((n) => n.type === "post_like")).toHaveLength(1)

    // @mention records a row + notifies the mentioned user
    const mentionPost = await svc.createPost(
      { kind: "post", body: "hey @notment", mediaUploadIds: [], mentionedUserIds: [mentioned] },
      author,
    )
    const mentionRows = await h.sql<{ mentioned_user_id: string }[]>`
      SELECT mentioned_user_id FROM post_mentions WHERE post_id = ${mentionPost.id}
    `
    expect(mentionRows.map((r) => r.mentioned_user_id)).toContain(mentioned)
    const mentionedNotifs = await notifRepo.listNotifications(mentioned, null, 50)
    expect(mentionedNotifs.records.filter((n) => n.type === "post_mention")).toHaveLength(1)
  })
})
