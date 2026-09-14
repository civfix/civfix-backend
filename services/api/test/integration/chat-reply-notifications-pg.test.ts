/**
 * P2 Task 2.5 integration test (Docker-gated): reply bells + re-enabled report-room @mentions (D11),
 * composed from the SAME production pieces the gateway wiring uses — chat-bells notifiers, the
 * report-chat fan-out, the chat-mention resolver, recordChatMentions — over real Postgres rows
 * (conversation_mutes, notification_prefs, cleanup/report members, notifications):
 *
 *   - a reply bells the replied-to user EVEN when they muted the room (replies pierce mutes);
 *   - prefs.mentions=false suppresses the reply bell (reply urgency is mention-class);
 *   - report-room member fan-out EXCLUDES the reply target — they get exactly ONE bell (the reply);
 *   - @mention of a NON-member in a report room resolves empty (no row, no bell); a member resolves,
 *     records the chat_message_mentions row, and bells as report_chat;
 *   - a MUTED dm thread still bells on a reply to the recipient; an unmuted dm reply produces exactly
 *     one dm bell.
 *
 * When Docker is unavailable the whole block SKIPS so the local suite stays green; CI runs it for real.
 */

import { TEST_TICKET_SIGNER } from "../helpers/ticket-signer.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { FakePushSender } from "@civfix/shared/fakes"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { makeDrizzleChatRepository } from "../../src/services/chat-repository.drizzle.js"
import { makeDrizzleDmRepository } from "../../src/services/dm-repository.drizzle.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { makeCleanupService } from "../../src/services/cleanup-service.js"
import { makeReportChatRepository } from "../../src/services/report-chat-repository.drizzle.js"
import { makeChatGroupRepository } from "../../src/services/chat-group-repository.drizzle.js"
import { makeDrizzleNotificationRepository } from "../../src/services/notification-repository.drizzle.js"
import { makeNotificationService } from "../../src/services/notification-service.js"
import { makeConversationMutesRepository } from "../../src/services/conversation-mutes-repository.drizzle.js"
import { makeDrizzleBlocksRepository } from "../../src/services/blocks-repository.drizzle.js"
import {
  makeChatMentionNotifier,
  makeChatReplyNotifier,
  makeDmBellNotifier,
  type ChatBellDeps,
} from "../../src/services/chat-bells.js"
import { makeChatMentionResolver } from "../../src/services/chat-mention-resolver.js"
import { recordChatMentions } from "../../src/services/chat-mentions.drizzle.js"
import { resolveMentionTargets } from "../../src/services/mention-resolver.drizzle.js"
import { makeReportChatNotifier } from "../../src/services/report-chat-notifier.js"
import { roomKeyFor } from "../../src/ws/gateway.js"

const pg = await withPg()

describe.skipIf(!pg)("reply notifications + report @mentions (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  /** Insert a user (with a real handle so mention resolution can find them) and return its id. */
  async function newUser(name: string, handle?: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${handle ?? testHandle()}) RETURNING id
    `
    return u!.id
  }

  /** Create a cleanup (organizer joined) and return its id. */
  async function newCleanup(organizerId: string, title: string): Promise<string> {
    const created = await makeCleanupService({
      tickets: TEST_TICKET_SIGNER,
      repo: makeDrizzleCleanupRepository(h.sql),
    }).createCleanup(
      {
        title,
        type: "site",
        eventKind: "cleanup",
        lat: 34.05,
        lng: -118.25,
        scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        slots: [{ title: "General volunteers", capacity: null }],
      },
      organizerId,
    )
    return created.id
  }

  /** Insert a minimal report and return its id. */
  async function newReport(): Promise<string> {
    const [r] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, h3_cell)
      VALUES (${randomUUID()}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'dump', 'submitted', 'h0')
      RETURNING id
    `
    return r!.id
  }

  /** All notification rows for a user, oldest-first. */
  async function bellsFor(userId: string): Promise<Array<{ type: string; title: string; body: string | null; link: string | null }>> {
    return await h.sql<Array<{ type: string; title: string; body: string | null; link: string | null }>>`
      SELECT type, title, body, link FROM notifications WHERE user_id = ${userId} ORDER BY created_at ASC
    `
  }

  /** The wiring-equivalent bell dep set over real repos (no presence: no one is "watching live"). */
  function makeBellDeps(): ChatBellDeps {
    const mutes = makeConversationMutesRepository(h.sql)
    const cleanupRepo = makeDrizzleCleanupRepository(h.sql)
    const reportChatRepo = makeReportChatRepository(h.sql)
    const groups = makeChatGroupRepository(h.sql)
    const blocks = makeDrizzleBlocksRepository(h.sql)
    return {
      notificationService: makeNotificationService({
        repo: makeDrizzleNotificationRepository(h.sql),
        pushSender: new FakePushSender(),
      }),
      isMutedFor: (userId, kind, roomId) => mutes.isMuted(userId, kind, roomId),
      isCleanupMember: (cleanupId, userId) => cleanupRepo.isMember(cleanupId, userId),
      isReportChatMember: (reportId, userId) => reportChatRepo.isMember(reportId, userId),
      isChatGroupMember: async (groupId, userId) => (await groups.roleOf(groupId, userId)) !== null,
      isBlockedEitherWay: (a, b) => blocks.isBlockedEitherWay(a, b),
      roomKeyFor,
    }
  }

  it("a reply bells the replied-to user even when they MUTED the room (replies pierce mutes)", async () => {
    const target = await newUser("Muted Target")
    const actor = await newUser("Reply Actor")
    const cleanupId = await newCleanup(target, "Muted-room sweep")
    await makeCleanupService({
      tickets: TEST_TICKET_SIGNER,
      repo: makeDrizzleCleanupRepository(h.sql),
    }).joinCleanup(cleanupId, actor)

    // Target mutes the room — the normal room/mention bells would be silenced.
    await makeConversationMutesRepository(h.sql).setMuted(target, "cleanup", cleanupId, true)

    const chatRepo = makeDrizzleChatRepository(h.sql)
    const original = await chatRepo.insertMessage(
      { cleanupId, userId: target, body: "please reply" },
      randomUUID(),
    )
    const reply = await chatRepo.insertMessage(
      { cleanupId, userId: actor, body: "replying anyway", replyToId: original.id },
      randomUUID(),
    )

    const deps = makeBellDeps()
    // Sanity: the mute would silence the MENTION bell for the same user in the same room.
    await makeChatMentionNotifier(deps)({
      kind: "cleanup",
      roomId: cleanupId,
      actorUserId: actor,
      mentionedUserId: target,
      message: reply,
    })
    expect(await bellsFor(target)).toHaveLength(0)

    // ...but the REPLY bell pierces it.
    await makeChatReplyNotifier(deps)({
      kind: "cleanup",
      roomId: cleanupId,
      actorUserId: actor,
      targetUserId: target,
      message: reply,
    })
    const bells = await bellsFor(target)
    expect(bells).toHaveLength(1)
    expect(bells[0]).toMatchObject({
      type: "cleanup_chat",
      title: "Reply Actor replied to you",
      body: "replying anyway",
      link: `/cleanups/${cleanupId}`,
    })
  })

  it("prefs.mentions=false suppresses the reply bell (reply urgency is mention-class)", async () => {
    const target = await newUser("No-Mentions Target")
    const actor = await newUser("Reply Actor 2")
    const cleanupId = await newCleanup(target, "Prefs sweep")
    await makeCleanupService({
      tickets: TEST_TICKET_SIGNER,
      repo: makeDrizzleCleanupRepository(h.sql),
    }).joinCleanup(cleanupId, actor)

    const deps = makeBellDeps()
    await deps.notificationService.getPrefs(target) // materialize defaults
    await makeNotificationService({
      repo: makeDrizzleNotificationRepository(h.sql),
      pushSender: new FakePushSender(),
    }).updatePrefs(target, { mentions: false })

    const chatRepo = makeDrizzleChatRepository(h.sql)
    const original = await chatRepo.insertMessage(
      { cleanupId, userId: target, body: "orig" },
      randomUUID(),
    )
    const reply = await chatRepo.insertMessage(
      { cleanupId, userId: actor, body: "quiet reply", replyToId: original.id },
      randomUUID(),
    )

    await makeChatReplyNotifier(deps)({
      kind: "cleanup",
      roomId: cleanupId,
      actorUserId: actor,
      targetUserId: target,
      message: reply,
    })
    expect(await bellsFor(target)).toHaveLength(0)
  })

  it("report room: member fan-out EXCLUDES the reply target — they get exactly ONE bell (the reply)", async () => {
    const target = await newUser("Fanout Target")
    const actor = await newUser("Fanout Actor")
    const other = await newUser("Fanout Other")
    const reportId = await newReport()
    const reportChatRepo = makeReportChatRepository(h.sql)
    await reportChatRepo.join(reportId, target, "member")
    await reportChatRepo.join(reportId, actor, "member")
    await reportChatRepo.join(reportId, other, "member")

    const chatRepo = makeDrizzleChatRepository(h.sql)
    const original = await chatRepo.insertMessage(
      { cleanupId: reportId, roomKind: "report", userId: target, body: "report orig" },
      randomUUID(),
    )
    const reply = await chatRepo.insertMessage(
      { cleanupId: reportId, roomKind: "report", userId: actor, body: "report reply", replyToId: original.id },
      randomUUID(),
    )

    const deps = makeBellDeps()
    const mutes = makeConversationMutesRepository(h.sql)
    // Run BOTH post-send paths exactly as the wiring does for a report message: the member fan-out
    // (onReportMessage) and the reply bell (onChatReply).
    const fanOut = makeReportChatNotifier({
      notificationService: makeNotificationService({
        repo: makeDrizzleNotificationRepository(h.sql),
        pushSender: new FakePushSender(),
      }),
      reportChatRepo: { listMemberIds: (id) => reportChatRepo.listMemberIds(id) },
      isMuted: (userId, roomId) => mutes.isMuted(userId, "report", roomId),
      roomKeyFor: (kind, id) => roomKeyFor(kind, id),
      isBlockedEitherWay: () => Promise.resolve(false), // offline harness: no blocks store
    })
    await fanOut(reportId, reply)
    await makeChatReplyNotifier(deps)({
      kind: "report",
      roomId: reportId,
      actorUserId: actor,
      targetUserId: target,
      message: reply,
    })

    // Target: exactly ONE bell — the reply-flavored one, not the fan-out copy.
    const targetBells = await bellsFor(target)
    expect(targetBells).toHaveLength(1)
    expect(targetBells[0]).toMatchObject({
      type: "report_chat",
      title: "Fanout Actor replied to you",
      link: `/messages/report/${reportId}`,
    })
    // Other member: exactly ONE bell — the plain fan-out copy.
    const otherBells = await bellsFor(other)
    expect(otherBells).toHaveLength(1)
    expect(otherBells[0]).toMatchObject({ type: "report_chat", title: "Fanout Actor" })
    // Actor (sender): nothing.
    expect(await bellsFor(actor)).toHaveLength(0)
  })

  it("report @mentions (D11): a NON-member resolves empty (no row, no bell); a member resolves + records + bells", async () => {
    const author = await newUser("Mention Author", testHandle())
    const memberHandle = testHandle()
    const outsiderHandle = testHandle()
    const member = await newUser("Report Member", memberHandle)
    const outsider = await newUser("Report Outsider", outsiderHandle)
    const reportId = await newReport()
    const reportChatRepo = makeReportChatRepository(h.sql)
    await reportChatRepo.join(reportId, author, "member")
    await reportChatRepo.join(reportId, member, "member")

    const resolve = makeChatMentionResolver({
      resolveTargets: (input) => resolveMentionTargets(h.sql, input),
      dmPeerOf: () => Promise.resolve(null),
      listCleanupMemberIds: () => Promise.resolve([]),
      listReportChatMemberIds: (id) => reportChatRepo.listMemberIds(id),
      listGroupMemberIds: () => Promise.resolve([]),
    })

    // NON-member: the handle exists but is outside report_chat_members -> resolves to NOTHING.
    const none = await resolve({
      handles: [outsiderHandle],
      userIds: [],
      authorUserId: author,
      kind: "report",
      roomId: reportId,
    })
    expect(none).toEqual([])
    expect(await bellsFor(outsider)).toHaveLength(0)

    // Member: resolves; the send path records the row and fires the mention bell.
    const resolved = await resolve({
      handles: [memberHandle, outsiderHandle],
      userIds: [],
      authorUserId: author,
      kind: "report",
      roomId: reportId,
    })
    expect(resolved.map((m) => m.id)).toEqual([member])

    const chatRepo = makeDrizzleChatRepository(h.sql)
    const message = await chatRepo.insertMessage(
      { cleanupId: reportId, roomKind: "report", userId: author, body: `hey @${memberHandle}` },
      randomUUID(),
    )
    await recordChatMentions(h.sql, message.id, resolved.map((m) => m.id))
    const rows = await h.sql<{ mentioned_user_id: string }[]>`
      SELECT mentioned_user_id FROM chat_message_mentions WHERE message_id = ${message.id}
    `
    expect(rows.map((r) => r.mentioned_user_id)).toEqual([member])

    await makeChatMentionNotifier(makeBellDeps())({
      kind: "report",
      roomId: reportId,
      actorUserId: author,
      mentionedUserId: member,
      message,
    })
    const bells = await bellsFor(member)
    expect(bells).toHaveLength(1)
    expect(bells[0]).toMatchObject({
      type: "report_chat",
      title: "Mention Author mentioned you",
      link: `/messages/report/${reportId}`,
    })
  })

  it("a MUTED dm thread still bells on a reply to the recipient; a non-reply stays silent", async () => {
    const a = await newUser("DM Reply A")
    const b = await newUser("DM Reply B")
    const dm = makeDrizzleDmRepository(h.sql)
    const thread = await dm.openOrCreateThread(a, b)
    await makeConversationMutesRepository(h.sql).setMuted(b, "dm", thread.id, true)

    const deps = makeBellDeps()
    const onDmDelivered = makeDmBellNotifier(deps)

    // Non-reply message: mute holds.
    const plain = await dm.persist({ threadId: thread.id, senderId: a, body: "plain" })
    await onDmDelivered(thread.id, b, plain)
    expect(await bellsFor(b)).toHaveLength(0)

    // Reply to B's message: pierces the mute, reply-flavored title.
    const bMsg = await dm.persist({ threadId: thread.id, senderId: b, body: "b's message" })
    const reply = await dm.persist({ threadId: thread.id, senderId: a, body: "re: b", replyToId: bMsg.id })
    await onDmDelivered(thread.id, b, reply)
    const bells = await bellsFor(b)
    expect(bells).toHaveLength(1)
    expect(bells[0]).toMatchObject({
      type: "dm",
      title: "DM Reply A replied to you",
      body: "re: b",
      link: `/messages/dm/${thread.id}`,
    })
  })

  it("2.5 side fix: a TOMBSTONED before-cursor still pages from its keyset position (chat + dm)", async () => {
    const org = await newUser("Anchor Org")
    const cleanupId = await newCleanup(org, "Anchor sweep")
    const chatRepo = makeDrizzleChatRepository(h.sql)
    const m1 = await chatRepo.insertMessage({ cleanupId, userId: org, body: "one" }, randomUUID())
    const m2 = await chatRepo.insertMessage({ cleanupId, userId: org, body: "two" }, randomUUID())
    const m3 = await chatRepo.insertMessage({ cleanupId, userId: org, body: "three" }, randomUUID())
    expect(await chatRepo.softDelete(cleanupId, m2.id, org)).not.toBeNull()

    // before=m2 (deleted): must return the page OLDER than m2 (just m1) — not fall back to the newest
    // page (which would start at m3).
    const page = await chatRepo.history(cleanupId, m2.id, 10)
    expect(page.items.map((m) => m.id)).toEqual([m1.id])
    expect(page.items.map((m) => m.id)).not.toContain(m3.id)

    const a = await newUser("Anchor DM A")
    const b = await newUser("Anchor DM B")
    const dm = makeDrizzleDmRepository(h.sql)
    const thread = await dm.openOrCreateThread(a, b)
    const d1 = await dm.persist({ threadId: thread.id, senderId: a, body: "one" })
    const d2 = await dm.persist({ threadId: thread.id, senderId: b, body: "two" })
    await dm.persist({ threadId: thread.id, senderId: a, body: "three" })
    expect(await dm.softDelete(thread.id, d2.id, b)).not.toBeNull()

    const dmPage = await dm.history(thread.id, d2.id, 10, a)
    expect(dmPage.items.map((m) => m.id)).toEqual([d1.id])
  })

  it("an UNMUTED dm reply produces exactly one dm bell", async () => {
    const a = await newUser("DM Unmuted A")
    const b = await newUser("DM Unmuted B")
    const dm = makeDrizzleDmRepository(h.sql)
    const thread = await dm.openOrCreateThread(a, b)

    const onDmDelivered = makeDmBellNotifier(makeBellDeps())
    const bMsg = await dm.persist({ threadId: thread.id, senderId: b, body: "hello" })
    const reply = await dm.persist({ threadId: thread.id, senderId: a, body: "re: hello", replyToId: bMsg.id })
    await onDmDelivered(thread.id, b, reply)

    const bells = await bellsFor(b)
    expect(bells).toHaveLength(1)
    expect(bells[0]).toMatchObject({ type: "dm", title: "DM Unmuted A replied to you" })
  })
})
