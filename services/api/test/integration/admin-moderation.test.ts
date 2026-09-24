import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import {
  insertModerationItem,
  makeDrizzleModerationRepository,
} from "../../src/services/admin/moderation-repository.drizzle.js"
import type { ModerationRepository } from "../../src/services/admin/moderation-service.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()

const GEOID = LA_CITY.geoid

async function insertReport(
  h: PgHarness,
  opts: { category?: string; status?: string; reporterUserId?: string },
): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO reports (idempotency_key, geom, geom_source, category, status, h3_cell, jurisdiction_geoid, reporter_user_id)
    VALUES (
      gen_random_uuid(),
      ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326),
      'manual',
      ${opts.category ?? "trash"},
      ${opts.status ?? "held"},
      'h0',
      ${GEOID},
      ${opts.reporterUserId ?? null}
    )
    RETURNING id
  `
  return rows[0]!.id
}

async function insertUser(h: PgHarness, handle: string): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO users (display_name, handle) VALUES (${`User ${handle}`}, ${handle}) RETURNING id
  `
  return rows[0]!.id
}

async function insertGroup(h: PgHarness, ownerId: string): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO chat_groups (name, owner_id, visibility)
    VALUES ('Neighbors', ${ownerId}, 'private')
    RETURNING id
  `
  return rows[0]!.id
}

async function insertGroupMessage(
  h: PgHarness,
  groupId: string,
  senderId: string,
): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO chat_messages (group_id, sender_id, body, kind)
    VALUES (${groupId}, ${senderId}, 'reported content', 'text')
    RETURNING id
  `
  return rows[0]!.id
}

async function insertDmMessage(h: PgHarness, senderId: string, peerId: string): Promise<string> {
  const thread = await h.sql<{ id: string }[]>`
    INSERT INTO dm_threads (user_lo, user_hi)
    VALUES (
      LEAST(${senderId}::uuid, ${peerId}::uuid),
      GREATEST(${senderId}::uuid, ${peerId}::uuid)
    )
    RETURNING id
  `
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO dm_messages (thread_id, sender_id, body, kind)
    VALUES (${thread[0]!.id}, ${senderId}, 'reported dm', 'text')
    RETURNING id
  `
  return rows[0]!.id
}

async function insertMedia(
  h: PgHarness,
  binding: { reportId?: string; postId?: string; chatMessageId?: string },
): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO media_assets (
      upload_id, kind, r2_key, status, purpose, report_id, post_id, chat_message_id
    )
    VALUES (
      ${randomUUID()}, 'image', ${`m/${randomUUID()}.jpg`}, 'ready', 'report',
      ${binding.reportId ?? null}, ${binding.postId ?? null}, ${binding.chatMessageId ?? null}
    )
    RETURNING id
  `
  return rows[0]!.id
}

async function messageDeletedAt(
  h: PgHarness,
  table: "chat_messages" | "dm_messages",
  messageId: string,
): Promise<Date | null> {
  const rows =
    table === "chat_messages"
      ? await h.sql<{ deleted_at: Date | null }[]>`
          SELECT deleted_at FROM chat_messages WHERE id = ${messageId}
        `
      : await h.sql<{ deleted_at: Date | null }[]>`
          SELECT deleted_at FROM dm_messages WHERE id = ${messageId}
        `
  return rows[0]!.deleted_at
}

describe.skipIf(!pg)("admin moderation repository (integration: real schema)", () => {
  let h: PgHarness
  let repo: ModerationRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleModerationRepository(h.sql)
  })

  beforeEach(async () => {
    await h.sql`TRUNCATE moderation_items, report_timeline, media_assets, abuse_flags, reports RESTART IDENTITY CASCADE`
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("createItem inserts an open item that listOpen returns", async () => {
    const reportId = await insertReport(h, { status: "held" })
    const id = await repo.createItem({
      kind: "image",
      subjectType: "report",
      subjectId: reportId,
      flag: "Held report",
      reason: "Awaiting automated review",
      category: "trash",
      reporter: "Anonymous",
      desc: "a held photo",
    })
    expect(id).not.toBeNull()

    const page = await repo.listOpen({ q: null, filter: "all", cursor: null, limit: 25 })
    expect(page.records).toHaveLength(1)
    expect(page.records[0]?.flag).toBe("Held report")
    expect(page.records[0]?.reporter).toBe("Anonymous")

    const detail = await repo.getItem(id!)
    expect(detail?.desc).toBe("a held photo")
    expect(detail?.category).toBe("trash")
  })

  it("dedupeOpen prevents a second open item for the same subject", async () => {
    const reportId = await insertReport(h, { status: "held" })
    const first = await repo.createItem({
      kind: "image",
      subjectType: "report",
      subjectId: reportId,
      dedupeOpen: true,
    })
    const second = await repo.createItem({
      kind: "image",
      subjectType: "report",
      subjectId: reportId,
      dedupeOpen: true,
    })
    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })

  it("approve publishes the held report and clears the item from the queue", async () => {
    const reportId = await insertReport(h, { status: "held" })
    const id = (await repo.createItem({
      kind: "image",
      subjectType: "report",
      subjectId: reportId,
    }))!

    const result = await repo.approve(id, { actorId: null, note: "ok" })
    expect(result).not.toBeNull()

    const [report] = await h.sql<{ status: string; published_at: Date | null }[]>`
      SELECT status, published_at FROM reports WHERE id = ${reportId}
    `
    expect(report?.status).toBe("published")
    expect(report?.published_at).not.toBeNull()

    const page = await repo.listOpen({ q: null, filter: "all", cursor: null, limit: 25 })
    expect(page.records).toHaveLength(0)

    const [tl] = await h.sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM report_timeline WHERE report_id = ${reportId} AND status = 'published'
    `
    expect(Number(tl?.count)).toBe(1)
  })

  it("remove rejects + soft-deletes the report and clears the item", async () => {
    const reportId = await insertReport(h, { status: "held" })
    const id = (await repo.createItem({
      kind: "image",
      subjectType: "report",
      subjectId: reportId,
    }))!

    await repo.remove(id, { actorId: null, reason: "spam" })

    const [report] = await h.sql<{ status: string; deleted_at: Date | null }[]>`
      SELECT status, deleted_at FROM reports WHERE id = ${reportId}
    `
    expect(report?.status).toBe("rejected")
    expect(report?.deleted_at).not.toBeNull()
    const page = await repo.listOpen({ q: null, filter: "all", cursor: null, limit: 25 })
    expect(page.records).toHaveLength(0)
  })

  it("removes a reported post: soft-deletes it and strikes its author", async () => {
    const authorId = await insertUser(h, "postauthor")
    const [post] = await h.sql<{ id: string }[]>`
      INSERT INTO posts (author_id, kind, body) VALUES (${authorId}, 'post', 'reported content')
      RETURNING id
    `
    const postId = post!.id

    const id = (await repo.createItem({
      kind: "user_report",
      subjectType: "post",
      subjectId: postId,
      flag: "User report",
      reason: "harassment",
    }))!

    const detail = await repo.getItem(id)
    expect(detail?.user?.handle).toBe("postauthor")

    await repo.remove(id, { actorId: null, reason: "harassment" })

    const [row] = await h.sql<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM posts WHERE id = ${postId}
    `
    expect(row?.deleted_at).not.toBeNull()

    const [um] = await h.sql<{ strikes: number; removals: number }[]>`
      SELECT strikes, removals FROM user_moderation WHERE user_id = ${authorId}
    `

    expect(um?.strikes).toBe(1)
    expect(um?.removals).toBe(1)
  })

  it("removing a reported reply decrements its parent's reply_count", async () => {
    const authorId = await insertUser(h, "replyauthor")
    const [parent] = await h.sql<{ id: string }[]>`
      INSERT INTO posts (author_id, kind, body, reply_count)
      VALUES (${authorId}, 'post', 'the parent', 1)
      RETURNING id
    `
    const parentId = parent!.id
    const [reply] = await h.sql<{ id: string }[]>`
      INSERT INTO posts (author_id, kind, body, reply_to_id, thread_root_id)
      VALUES (${authorId}, 'reply', 'reported reply', ${parentId}, ${parentId})
      RETURNING id
    `

    const id = (await repo.createItem({
      kind: "user_report",
      subjectType: "post",
      subjectId: reply!.id,
      flag: "User report",
      reason: "harassment",
    }))!
    await repo.remove(id, { actorId: null, reason: "harassment" })

    const [counted] = await h.sql<{ reply_count: number }[]>`
      SELECT reply_count FROM posts WHERE id = ${parentId}
    `
    expect(counted?.reply_count).toBe(0)
  })

  it("remove strikes the reporter and createItem captures a real user snapshot", async () => {
    const userId = await insertUser(h, "rmreporter")
    const reportId = await insertReport(h, { status: "held", reporterUserId: userId })
    const id = (await repo.createItem({
      kind: "image",
      subjectType: "report",
      subjectId: reportId,
    }))!

    const detail = await repo.getItem(id)
    expect(detail?.user?.handle).toBe("rmreporter")
    expect(detail?.user?.strikes).toBe(0)

    await repo.remove(id, { actorId: null, reason: "spam" })
    const [um] = await h.sql<{ strikes: number; removals: number }[]>`
      SELECT strikes, removals FROM user_moderation WHERE user_id = ${userId}
    `
    expect(um?.strikes).toBe(1)
    expect(um?.removals).toBe(1)
  })

  describe("owner takedown strikes", () => {
    async function strikesFor(userId: string): Promise<number> {
      const rows = await h.sql<{ strikes: number }[]>`
        SELECT strikes FROM user_moderation WHERE user_id = ${userId}
      `
      return rows[0]?.strikes ?? 0
    }

    function ownerRequest(reportId: string, reporterUserId: string) {
      return {
        kind: "user_report" as const,
        subjectType: "report" as const,
        subjectId: reportId,
        flag: "Owner takedown request",
        reason: "please remove",
        reporter: "@owner",
        reporterUserId,
        priority: "high" as const,
        dedupeOpen: true,
      }
    }

    it("a pure owner takedown skips the strike", async () => {
      const owner = await insertUser(h, testHandle())
      const reportId = await insertReport(h, { status: "published", reporterUserId: owner })
      const id = (await repo.createItem(ownerRequest(reportId, owner)))!
      await repo.remove(id, { actorId: null, reason: null })
      expect(await strikesFor(owner)).toBe(0)
    })

    it("an owner request folded into a pipeline hold still strikes", async () => {
      const owner = await insertUser(h, testHandle())
      const reportId = await insertReport(h, { status: "held", reporterUserId: owner })
      const id = await insertModerationItem(h.sql, {
        kind: "image",
        subjectType: "report",
        subjectId: reportId,
        flag: "Held media (NSFW)",
        priority: "high",
      })
      await expect(repo.createItem(ownerRequest(reportId, owner))).resolves.toBeNull()
      await repo.remove(id, { actorId: null, reason: null })
      expect(await strikesFor(owner)).toBe(1)
    })

    it("a third-party report folded into an owner's item still strikes", async () => {
      const owner = await insertUser(h, testHandle())
      const other = await insertUser(h, testHandle())
      const reportId = await insertReport(h, { status: "published", reporterUserId: owner })
      const id = (await repo.createItem(ownerRequest(reportId, owner)))!
      await repo.createItem({
        ...ownerRequest(reportId, other),
        flag: "User report",
        priority: "med",
      })
      await repo.remove(id, { actorId: null, reason: null })
      expect(await strikesFor(owner)).toBe(1)
    })
  })

  it("hold extends the hold (report stays held; item leaves the queue)", async () => {
    const reportId = await insertReport(h, { status: "held" })
    const id = (await repo.createItem({
      kind: "image",
      subjectType: "report",
      subjectId: reportId,
    }))!

    await repo.hold(id, { actorId: null, note: "need info" })

    const [report] = await h.sql<{ status: string }[]>`
      SELECT status FROM reports WHERE id = ${reportId}
    `
    expect(report?.status).toBe("held")
    const item = await repo.getItem(id)
    expect(item?.status).toBe("held")
    const page = await repo.listOpen({ q: null, filter: "all", cursor: null, limit: 25 })
    expect(page.records).toHaveLength(0)
  })

  it("decideAppeal overturn resolves the open chat abuse_flag (lifts the suspension)", async () => {
    const chatId = (await h.sql<{ id: string }[]>`SELECT gen_random_uuid() AS id`)[0]!.id
    await h.sql`
      INSERT INTO abuse_flags (subject_type, subject_id, reason, source)
      VALUES ('chat', ${chatId}, 'manual', 'api')
    `
    const id = await insertModerationItem(h.sql, {
      kind: "appeal",
      subjectType: "chat",
      subjectId: chatId,
      flag: "Suspension appeal",
      reason: "User requests review",
    })

    await repo.decideAppeal(id, { decision: "overturn", actorId: null, note: null })

    const [flag] = await h.sql<{ resolved_at: Date | null }[]>`
      SELECT resolved_at FROM abuse_flags WHERE subject_type = 'chat' AND subject_id = ${chatId}
    `
    expect(flag?.resolved_at).not.toBeNull()
    const item = await repo.getItem(id)
    expect(item?.status).toBe("approved")
  })

  it("decideAppeal overturn lifts the real suspension it appeals; uphold leaves it standing (F115)", async () => {
    const suspended = await insertUser(h, `appeal_ov_${Date.now().toString(36)}`)
    const kept = await insertUser(h, `appeal_up_${Date.now().toString(36)}`)

    for (const userId of [suspended, kept]) {
      const modId = await insertModerationItem(h.sql, {
        kind: "user_report",
        subjectType: "user",
        subjectId: userId,
        flag: "Abusive chat",
        reason: "Reported by members",
      })
      await repo.remove(modId, { actorId: null, reason: "abuse" })
    }
    await h.sql`
      INSERT INTO abuse_flags (subject_type, subject_id, reason, source)
      VALUES ('user', ${suspended}, 'manual', 'api')
    `

    const statusOf = async (userId: string): Promise<{ status: string; flagged: boolean }> => {
      const [row] = await h.sql<{ account_status: string; flagged: boolean }[]>`
        SELECT account_status, flagged FROM user_moderation WHERE user_id = ${userId}
      `
      return { status: row!.account_status, flagged: row!.flagged }
    }
    expect(await statusOf(suspended)).toEqual({ status: "suspended", flagged: true })
    expect(await statusOf(kept)).toEqual({ status: "suspended", flagged: true })

    const overturnId = await insertModerationItem(h.sql, {
      kind: "appeal",
      subjectType: "user",
      subjectId: suspended,
      flag: "Suspension appeal",
      reason: "User requests review",
    })
    const upholdId = await insertModerationItem(h.sql, {
      kind: "appeal",
      subjectType: "user",
      subjectId: kept,
      flag: "Suspension appeal",
      reason: "User requests review",
    })

    await repo.decideAppeal(overturnId, { decision: "overturn", actorId: null, note: null })
    await repo.decideAppeal(upholdId, { decision: "uphold", actorId: null, note: null })

    expect(await statusOf(suspended)).toEqual({ status: "active", flagged: false })
    expect(await statusOf(kept)).toEqual({ status: "suspended", flagged: true })

    const [flag] = await h.sql<{ resolved_at: Date | null }[]>`
      SELECT resolved_at FROM abuse_flags WHERE subject_type = 'user' AND subject_id = ${suspended}
    `
    expect(flag?.resolved_at).not.toBeNull()

    expect((await repo.getItem(overturnId))?.status).toBe("approved")
    expect((await repo.getItem(upholdId))?.status).toBe("approved")
  })

  it("decideAppeal overturn never re-activates a TOMBSTONED account, and reports no restored user", async () => {
    const deleted = await insertUser(h, `appeal_del_${Date.now().toString(36)}`)
    const modId = await insertModerationItem(h.sql, {
      kind: "user_report",
      subjectType: "user",
      subjectId: deleted,
      flag: "Abusive chat",
      reason: "Reported by members",
    })
    await repo.remove(modId, { actorId: null, reason: "abuse" })

    // The account is erased after the suspension (softDeleteAndAnonymize). An overturn that upserted
    // account_status='active' unconditionally would resurrect it in the operator console as a live,
    // unflagged account and, with the session hook wired, lift its ban marker too.
    await h.sql`UPDATE users SET deleted_at = now() WHERE id = ${deleted}`

    const appealId = await insertModerationItem(h.sql, {
      kind: "appeal",
      subjectType: "user",
      subjectId: deleted,
      flag: "Suspension appeal",
      reason: "User requests review",
    })
    const record = await repo.decideAppeal(appealId, {
      decision: "overturn",
      actorId: null,
      note: null,
    })

    expect(record?.status).toBe("approved")
    expect(record?.restoredUserId).toBeUndefined()
    const [row] = await h.sql<{ account_status: string; flagged: boolean }[]>`
      SELECT account_status, flagged FROM user_moderation WHERE user_id = ${deleted}
    `
    expect(row!.account_status).toBe("suspended")
    expect(row!.flagged).toBe(true)

    // The audit row records that nothing was restored, so the decision is still legible after the fact.
    const [audit] = await h.sql<{ meta: { restored: boolean } }[]>`
      SELECT meta FROM audit_log
      WHERE action = 'moderation.appeal_decided' AND target = ${`moderation:${appealId}`}
      ORDER BY created_at DESC LIMIT 1
    `
    expect(audit!.meta.restored).toBe(false)
  })

  it("decideAppeal overturn on a live account reports the restored user id (the ban-marker hook)", async () => {
    const userId = await insertUser(h, `appeal_live_${Date.now().toString(36)}`)
    const modId = await insertModerationItem(h.sql, {
      kind: "user_report",
      subjectType: "user",
      subjectId: userId,
      flag: "Abusive chat",
      reason: "Reported by members",
    })
    await repo.remove(modId, { actorId: null, reason: "abuse" })
    const appealId = await insertModerationItem(h.sql, {
      kind: "appeal",
      subjectType: "user",
      subjectId: userId,
      flag: "Suspension appeal",
      reason: "User requests review",
    })

    const record = await repo.decideAppeal(appealId, {
      decision: "overturn",
      actorId: null,
      note: null,
    })
    expect(record?.restoredUserId).toBe(userId)
  })

  async function photoAuthorId(mediaId: string): Promise<string | null> {
    const id = (await repo.createItem({
      kind: "image",
      subjectType: "photo",
      subjectId: mediaId,
      flag: "User report",
      reason: "nsfw",
    }))!
    const record = await repo.getItem(id)
    return record?.user?.id ?? null
  }

  it("W7: a reported GROUP chat message resolves its sender and Remove tombstones chat_messages", async () => {
    const sender = await insertUser(h, testHandle())
    const groupId = await insertGroup(h, sender)
    const messageId = await insertGroupMessage(h, groupId, sender)

    const id = (await repo.createItem({
      kind: "user_report",
      subjectType: "message",
      subjectId: messageId,
      flag: "User report",
      reason: "harassment",
    }))!

    expect((await repo.getItem(id))?.user?.id).toBe(sender)

    await repo.remove(id, { actorId: null, reason: "harassment" })

    expect(await messageDeletedAt(h, "chat_messages", messageId)).not.toBeNull()

    const [um] = await h.sql<{ strikes: number; removals: number }[]>`
      SELECT strikes, removals FROM user_moderation WHERE user_id = ${sender}
    `
    expect(um?.strikes).toBe(1)
    expect(um?.removals).toBe(1)
  })

  it("W7: a reported DM still resolves its sender and Remove tombstones dm_messages", async () => {
    const sender = await insertUser(h, testHandle())
    const peer = await insertUser(h, testHandle())
    const messageId = await insertDmMessage(h, sender, peer)

    const id = (await repo.createItem({
      kind: "user_report",
      subjectType: "message",
      subjectId: messageId,
      flag: "User report",
      reason: "harassment",
    }))!

    expect((await repo.getItem(id))?.user?.id).toBe(sender)

    await repo.remove(id, { actorId: null, reason: "harassment" })

    expect(await messageDeletedAt(h, "dm_messages", messageId)).not.toBeNull()
  })

  it("W7: an appeal overturn restores a tombstoned GROUP chat message", async () => {
    const sender = await insertUser(h, testHandle())
    const groupId = await insertGroup(h, sender)
    const messageId = await insertGroupMessage(h, groupId, sender)

    const removalId = (await repo.createItem({
      kind: "user_report",
      subjectType: "message",
      subjectId: messageId,
      flag: "User report",
      reason: "harassment",
    }))!
    await repo.remove(removalId, { actorId: null, reason: "harassment" })
    expect(await messageDeletedAt(h, "chat_messages", messageId)).not.toBeNull()

    const appealId = await insertModerationItem(h.sql, {
      kind: "appeal",
      subjectType: "message",
      subjectId: messageId,
      flag: "Removal appeal",
      reason: "User requests review",
    })
    await repo.decideAppeal(appealId, { decision: "overturn", actorId: null, note: null })

    expect(await messageDeletedAt(h, "chat_messages", messageId)).toBeNull()
  })

  it("W7: a reported photo resolves the author of every binding that identifies its uploader", async () => {
    const postAuthor = await insertUser(h, testHandle())
    const [post] = await h.sql<{ id: string }[]>`
      INSERT INTO posts (author_id, kind, body) VALUES (${postAuthor}, 'post', 'with photo')
      RETURNING id
    `
    const postPhoto = await insertMedia(h, { postId: post!.id })

    const chatSender = await insertUser(h, testHandle())
    const groupId = await insertGroup(h, chatSender)
    const chatPhoto = await insertMedia(h, {
      chatMessageId: await insertGroupMessage(h, groupId, chatSender),
    })

    const dmSender = await insertUser(h, testHandle())
    const dmPeer = await insertUser(h, testHandle())
    const dmPhoto = await insertMedia(h, {
      chatMessageId: await insertDmMessage(h, dmSender, dmPeer),
    })

    const reporter = await insertUser(h, testHandle())
    const reportPhoto = await insertMedia(h, {
      reportId: await insertReport(h, { status: "published", reporterUserId: reporter }),
    })

    const avatarOwner = await insertUser(h, testHandle())
    const avatarPhoto = await insertMedia(h, {})
    await h.sql`UPDATE users SET avatar_media_id = ${avatarPhoto} WHERE id = ${avatarOwner}`

    const bindings: Array<[string, string]> = [
      [postPhoto, postAuthor],
      [chatPhoto, chatSender],
      [dmPhoto, dmSender],
      [reportPhoto, reporter],
      [avatarPhoto, avatarOwner],
    ]

    for (const [mediaId, authorId] of bindings) {
      expect(await photoAuthorId(mediaId)).toBe(authorId)
    }
  })

  it("W7: a reported photo whose only binding is a PROXY-owned surface resolves no author", async () => {
    const groupOwner = await insertUser(h, testHandle())
    const groupAvatarPhoto = await insertMedia(h, {})
    const avatarGroupId = await insertGroup(h, groupOwner)
    await h.sql`
      UPDATE chat_groups SET avatar_media_id = ${groupAvatarPhoto} WHERE id = ${avatarGroupId}
    `

    const orgCreator = await insertUser(h, testHandle())
    const orgLogoPhoto = await insertMedia(h, {})
    await h.sql`
      INSERT INTO organizations (slug, name, created_by, logo_media_id)
      VALUES (${`org-${randomUUID().slice(0, 8)}`}, 'Cleanup Collective', ${orgCreator}, ${orgLogoPhoto})
    `

    const organizer = await insertUser(h, testHandle())
    const eventCoverPhoto = await insertMedia(h, {})
    await seedCleanup(h.sql, {
      organizerUserId: organizer,
      title: "Beach cleanup",
      lng: -118.49,
      lat: 34.0,
      coverMediaId: eventCoverPhoto,
    })

    const unboundPhoto = await insertMedia(h, {})

    for (const mediaId of [groupAvatarPhoto, orgLogoPhoto, eventCoverPhoto, unboundPhoto]) {
      expect(await photoAuthorId(mediaId)).toBeNull()
    }
  })

  it("backfillFromHeldReports creates one item per held report lacking an open item", async () => {
    const r1 = await insertReport(h, { status: "held", category: "hazard" })
    const r2 = await insertReport(h, { status: "held", category: "trash" })
    const r3 = await insertReport(h, { status: "held" })
    await repo.createItem({ kind: "image", subjectType: "report", subjectId: r3 })
    await insertReport(h, { status: "published" })

    const created = await repo.backfillFromHeldReports()
    expect(created).toBe(2)

    const page = await repo.listOpen({ q: null, filter: "all", cursor: null, limit: 100 })
    const subjectIds = new Set(page.records.map((r) => r.subjectId))
    expect(subjectIds.has(r1)).toBe(true)
    expect(subjectIds.has(r2)).toBe(true)
    expect(subjectIds.has(r3)).toBe(true)
    expect(page.records).toHaveLength(3)
  })
})
