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
import { FakePushSender } from "@civfix/shared/fakes"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
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
    expect((await svc.getPost(created.id, author)).counts.replies).toBe(1)
    const replies = await svc.listReplies(created.id, author, {})
    expect(replies.items.map((p) => p.id)).toContain(reply.id)

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
