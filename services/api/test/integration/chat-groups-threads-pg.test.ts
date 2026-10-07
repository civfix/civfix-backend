/**
 * Integration test (Docker-gated): groups in the threads inbox + group_chat bells +
 * the read-watermark / keyset carry-ins, against a live PostGIS container (via withPg).
 *
 *   Threads inbox (service-level, the threads-report-pg pattern):
 *     - a member's listThreads includes a kind:"group" thread with the right id/refId/title (group
 *       name) / last / ago / lastFromMe / members / muted:false; a non-member sees nothing;
 *     - unread math rides the durable chat_group_members.last_read_at watermark: 2 unread, ack the
 *       FIRST message -> unread 1;
 *     - watermark REGRESSION: acking an OLDER message after a newer one never moves last_read_at
 *       back (GREATEST semantics);
 *     - a conversation_mutes ('group') row flips the thread's muted to true.
 *
 *   Bells (WS seam: handleClientFrame over the SAME pieces chat-gateway-wiring composes:
 *   makeGroupChatNotifier fan-out via onGroupMessage, chat-bells mention/reply notifiers, presence,
 *   and the wiring-shaped markReadOnOpen):
 *     - a member send bells the UNMUTED absent member exactly once (group_chat,
 *       /messages/group/:id); the sender, a PRESENT member, and a MUTED member get nothing;
 *     - a reply in a MUTED group still bells the reply target (the mute-piercing reply override),
 *       and the fan-out's reply-target exclusion keeps it to exactly ONE bell;
 *     - an @-mentioned member gets the MENTION bell, not the fan-out copy (dedupe); other members
 *       still get the plain fan-out bell;
 *     - markReadOnOpen (join) clears the room's group_chat bells and leaves other rooms' bells.
 *
 *   Keyset carry-in: five messages sharing ONE transaction timestamp (identical created_at to the
 *   microsecond) page with limit 2 into 3 pages with no dupes and no skips, group history AND dm
 *   history (the anchor tuple now stays in SQL; a ms-truncated JS-Date anchor would return an empty
 *   second page).
 *
 * When Docker is unavailable the whole block SKIPS so the local suite stays green; CI runs it for real.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { FakePushSender } from "@civfix/shared/fakes"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { MockConnection } from "../helpers/chat.js"
import {
  handleClientFrame,
  roomKeyFor,
  type GatewayDeps,
  type GatewaySession,
} from "../../src/ws/gateway.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatPubSub } from "../../src/adapters/chat-pubsub.js"
import { InMemoryChatPresence } from "../../src/adapters/chat-presence.js"
import { makeDrizzleChatRepository } from "../../src/services/chat-repository.drizzle.js"
import { makeDrizzleDmRepository } from "../../src/services/dm-repository.drizzle.js"
import { makeDrizzleBlocksRepository } from "../../src/services/blocks-repository.drizzle.js"
import {
  canPostToGroup,
  makeChatGroupRepository,
} from "../../src/services/chat-group-repository.drizzle.js"
import { makeConversationMutesRepository } from "../../src/services/conversation-mutes-repository.drizzle.js"
import { makeDrizzleNotificationRepository } from "../../src/services/notification-repository.drizzle.js"
import { makeNotificationService } from "../../src/services/notification-service.js"
import { makeGroupChatNotifier } from "../../src/services/group-chat-notifier.js"
import {
  makeChatMentionNotifier,
  makeChatReplyNotifier,
  type ChatBellDeps,
} from "../../src/services/chat-bells.js"
import { makeChatMentionResolver } from "../../src/services/chat-mention-resolver.js"
import { recordChatMentions } from "../../src/services/chat-mentions-repository.drizzle.js"
import { resolveMentionTargets } from "../../src/services/mention-targets-repository.drizzle.js"
import {
  makeDrizzleGroupThreadsSource,
  makeDrizzleThreadsRepository,
} from "../../src/services/threads-repository.drizzle.js"
import { makeThreadsService, InMemoryChatReadState } from "../../src/services/threads-service.js"

const pg = await withPg()

describe.skipIf(!pg)("chat groups: threads inbox + group_chat bells (integration)", () => {
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

  /** Direct-SQL group fixture: owner + plain members, with an optional explicit join time. */
  async function newGroup(
    ownerId: string,
    memberIds: string[],
    opts: { name?: string; joinedAt?: Date } = {},
  ): Promise<string> {
    const [g] = await h.sql<{ id: string }[]>`
      INSERT INTO chat_groups (name, owner_id) VALUES (${opts.name ?? "Threads Crew"}, ${ownerId}) RETURNING id
    `
    const groupId = g!.id
    const joined = opts.joinedAt ?? new Date()
    await h.sql`
      INSERT INTO chat_group_members (group_id, user_id, role, joined_at)
      VALUES (${groupId}, ${ownerId}, 'owner', ${joined})
    `
    for (const m of memberIds) {
      await h.sql`
        INSERT INTO chat_group_members (group_id, user_id, role, joined_at)
        VALUES (${groupId}, ${m}, 'member', ${joined})
      `
    }
    return groupId
  }

  /** Insert a group chat message with an explicit created_at; returns its id. */
  async function addGroupMessage(
    groupId: string,
    senderId: string,
    body: string,
    createdAt: Date,
  ): Promise<string> {
    const [r] = await h.sql<{ id: string }[]>`
      INSERT INTO chat_messages (group_id, sender_id, body, kind, created_at)
      VALUES (${groupId}, ${senderId}, ${body}, 'text', ${createdAt})
      RETURNING id
    `
    return r!.id
  }

  /** All notification rows for a user, oldest-first. */
  async function bellsFor(
    userId: string,
  ): Promise<Array<{ type: string; title: string; body: string | null; link: string | null }>> {
    return await h.sql<
      Array<{ type: string; title: string; body: string | null; link: string | null }>
    >`
      SELECT type, title, body, link FROM notifications WHERE user_id = ${userId} ORDER BY created_at ASC
    `
  }

  /** Poll until `cond` returns truthy (fire-and-forget bells land behind real SQL round-trips). */
  async function waitFor<T>(cond: () => Promise<T | null | false>, ms = 3000): Promise<T> {
    const deadline = Date.now() + ms
    for (;;) {
      const v = await cond()
      if (v) return v
      if (Date.now() > deadline) throw new Error("waitFor: condition not met in time")
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  /** Grace period for zero-assertions: give the fire-and-forget effects time to (wrongly) land. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 250))

  const groups = () => makeChatGroupRepository(h.sql)

  function threadsService() {
    return makeThreadsService({
      repo: makeDrizzleThreadsRepository(h.sql),
      readState: new InMemoryChatReadState(),
      group: makeDrizzleGroupThreadsSource(h.sql),
      mutes: makeConversationMutesRepository(h.sql),
      now: () => new Date("2026-06-01T12:00:00.000Z"),
    })
  }

  describe("threads inbox", () => {
    it("a member sees a kind:'group' thread with the right title / last / unread / members; a stranger doesn't", async () => {
      const me = await newUser("Group Member")
      const other = await newUser("Group Other")
      const stranger = await newUser("Group Stranger")
      const groupId = await newGroup(other, [me], {
        name: "Weekend Crew",
        joinedAt: new Date("2026-06-01T09:00:00.000Z"),
      })

      await addGroupMessage(groupId, other, "first", new Date("2026-06-01T10:00:00.000Z"))
      await addGroupMessage(groupId, other, "second", new Date("2026-06-01T11:30:00.000Z"))

      const { items } = await threadsService().listThreads(me)
      const t = items.find((x) => x.id === groupId)
      expect(t, "member should see the group thread").toBeDefined()
      expect(t!.kind).toBe("group")
      expect(t!.refId).toBe(groupId)
      expect(t!.title).toBe("Weekend Crew")
      expect(t!.last).toBe("second")
      expect(t!.ago).toBe("30m")
      expect(t!.lastFromMe).toBe(false)
      expect(t!.unread).toBe(2)
      expect(t!.members).toBe(2)
      expect(t!.muted).toBe(false)

      const strangerThreads = await threadsService().listThreads(stranger)
      expect(strangerThreads.items.some((x) => x.id === groupId)).toBe(false)
    })

    it("unread rides the last_read_at watermark: acking the FIRST of two messages leaves unread 1", async () => {
      const me = await newUser("Watermark Member")
      const other = await newUser("Watermark Other")
      const groupId = await newGroup(other, [me], {
        joinedAt: new Date("2026-06-01T09:00:00.000Z"),
      })

      const m1 = await addGroupMessage(groupId, other, "one", new Date("2026-06-01T10:00:00.000Z"))
      await addGroupMessage(groupId, other, "two", new Date("2026-06-01T11:00:00.000Z"))

      await groups().advanceReadWatermark(groupId, me, m1)

      const t = (await threadsService().listThreads(me)).items.find((x) => x.id === groupId)
      expect(t!.unread).toBe(1)
      // The viewer's own later message never counts as unread either way.
      await addGroupMessage(groupId, me, "mine", new Date("2026-06-01T11:30:00.000Z"))
      const t2 = (await threadsService().listThreads(me)).items.find((x) => x.id === groupId)
      expect(t2!.unread).toBe(1)
      expect(t2!.lastFromMe).toBe(true)
    })

    it("watermark regression: acking an OLDER message after a newer one never moves last_read_at back", async () => {
      const me = await newUser("Regress Member")
      const other = await newUser("Regress Other")
      const groupId = await newGroup(other, [me], {
        joinedAt: new Date("2026-06-01T09:00:00.000Z"),
      })

      const older = await addGroupMessage(
        groupId,
        other,
        "older",
        new Date("2026-06-01T10:00:00.000Z"),
      )
      const newer = await addGroupMessage(
        groupId,
        other,
        "newer",
        new Date("2026-06-01T11:00:00.000Z"),
      )

      const readAt = async (): Promise<Date | null> => {
        const rows = await h.sql<{ last_read_at: Date | null }[]>`
          SELECT last_read_at FROM chat_group_members WHERE group_id = ${groupId} AND user_id = ${me}
        `
        return rows[0]?.last_read_at ?? null
      }

      await groups().advanceReadWatermark(groupId, me, newer)
      const afterNewer = await readAt()
      expect(afterNewer).not.toBeNull()

      // A late/out-of-order ack for the OLDER message must not regress the watermark (GREATEST).
      await groups().advanceReadWatermark(groupId, me, older)
      const afterOlder = await readAt()
      expect(afterOlder!.getTime()).toBe(afterNewer!.getTime())

      const t = (await threadsService().listThreads(me)).items.find((x) => x.id === groupId)
      expect(t!.unread).toBe(0)
    })

    it("a conversation_mutes ('group') row flips the thread's muted to true", async () => {
      const me = await newUser("Mute Member")
      const other = await newUser("Mute Owner")
      const groupId = await newGroup(other, [me], {
        joinedAt: new Date("2026-06-01T09:00:00.000Z"),
      })
      await addGroupMessage(groupId, other, "hello", new Date("2026-06-01T10:00:00.000Z"))

      const before = (await threadsService().listThreads(me)).items.find((x) => x.id === groupId)
      expect(before!.muted).toBe(false)

      await makeConversationMutesRepository(h.sql).setMuted(me, "group", groupId, true)

      const after = (await threadsService().listThreads(me)).items.find((x) => x.id === groupId)
      expect(after!.muted).toBe(true)
    })
  })

  describe("group_chat bells (WS seam over the wiring's pieces)", () => {
    /**
     * Gateway deps composed from the SAME production pieces chat-gateway-wiring uses for group rooms:
     * makeGroupChatNotifier behind onGroupMessage, the chat-bells mention/reply notifiers, shared
     * presence, and the wiring-shaped markReadOnOpen (markRead + group_chat clearByTypeAndLink).
     */
    function makeDeps() {
      const chatRepo = makeDrizzleChatRepository(h.sql)
      const groupRepo = makeChatGroupRepository(h.sql)
      const mutes = makeConversationMutesRepository(h.sql)
      const blocks = makeDrizzleBlocksRepository(h.sql)
      const presence = new InMemoryChatPresence()
      const notificationService = makeNotificationService({
        repo: makeDrizzleNotificationRepository(h.sql),
        pushSender: new FakePushSender(),
      })
      const bellDeps: ChatBellDeps = {
        notificationService,
        isMutedFor: (userId, kind, roomId) => mutes.isMuted(userId, kind, roomId),
        isCleanupMember: () => Promise.resolve(false),
        isReportChatMember: () => Promise.resolve(false),
        isChatGroupMember: async (groupId, userId) =>
          (await groupRepo.roleOf(groupId, userId)) !== null,
        isBlockedEitherWay: (a, b) => blocks.isBlockedEitherWay(a, b),
        presence,
        roomKeyFor,
      }
      const notifyGroupChatMembers = makeGroupChatNotifier({
        notificationService,
        groupRepo: { listMemberIds: (groupId) => groupRepo.listMemberIds(groupId) },
        isMuted: (userId, roomId) => mutes.isMuted(userId, "group", roomId),
        presence,
        roomKeyFor,
        isBlockedEitherWay: () => Promise.resolve(false), // offline harness: no blocks store
      })
      const deps: GatewayDeps = {
        chat: new WsChatService({ repo: chatRepo, pubsub: new InMemoryChatPubSub() }),
        isMember: () => Promise.resolve(false),
        presence,
        groupChat: {
          isMember: async (groupId, userId) => (await groupRepo.roleOf(groupId, userId)) !== null,
          access: async (groupId, userId) => {
            const a = await groupRepo.accessOf(groupId, userId)
            return a === null
              ? null
              : { isMember: a.role !== null, canPost: canPostToGroup(a), visibility: a.visibility }
          },
          advanceReadWatermark: (groupId, userId, upToId) =>
            groupRepo.advanceReadWatermark(groupId, userId, upToId),
        },
        // The wiring's group markReadOnOpen branch: stamp last_read_at + clear the room's bells.
        markReadOnOpen: async (kind, id, userId) => {
          if (kind !== "group") return
          await groupRepo.markRead(id, userId, new Date())
          await notificationService.clearByTypeAndLink(
            userId,
            "group_chat",
            `/messages/group/${id}`,
          )
        },
        chatMentions: {
          resolveChatMentions: makeChatMentionResolver({
            resolveTargets: (input) => resolveMentionTargets(h.sql, input),
            dmPeerOf: () => Promise.resolve(null),
            listCleanupMemberIds: () => Promise.resolve([]),
            listReportChatMemberIds: () => Promise.resolve([]),
            listGroupMemberIds: (groupId) => groupRepo.listMemberIds(groupId),
          }),
          recordChatMentions: (messageId, ids) => recordChatMentions(h.sql, messageId, ids),
          notifyChatMention: makeChatMentionNotifier(bellDeps),
        },
        onChatReply: makeChatReplyNotifier(bellDeps),
        onGroupMessage: async (groupId, message) => {
          await notifyGroupChatMembers(groupId, message)
        },
      }
      return deps
    }

    function sessionFor(userId: string, conn: MockConnection, deps: GatewayDeps): GatewaySession {
      return {
        userId,
        conn,
        joined: new Set<string>(),
        typingThrottle: new Map<string, number>(),
        deps,
      }
    }

    const frame = (f: Record<string, unknown>) => JSON.stringify(f)

    async function join(session: GatewaySession, groupId: string): Promise<void> {
      await handleClientFrame(
        session,
        frame({ type: "join", cleanupId: groupId, roomKind: "group" }),
      )
    }

    it("a send bells the UNMUTED absent member exactly once; sender, PRESENT, and MUTED members get nothing", async () => {
      const sender = await newUser("Bell Sender")
      const present = await newUser("Bell Present")
      const unmuted = await newUser("Bell Unmuted")
      const mutedU = await newUser("Bell Muted")
      const groupId = await newGroup(sender, [present, unmuted, mutedU])
      await makeConversationMutesRepository(h.sql).setMuted(mutedU, "group", groupId, true)

      const deps = makeDeps()
      const senderSession = sessionFor(sender, new MockConnection("S"), deps)
      const presentSession = sessionFor(present, new MockConnection("P"), deps)
      await join(senderSession, groupId)
      await join(presentSession, groupId)

      await handleClientFrame(
        senderSession,
        frame({
          type: "send",
          cleanupId: groupId,
          roomKind: "group",
          clientId: "c1",
          body: "hello bells",
        }),
      )

      const bells = await waitFor(async () => {
        const b = await bellsFor(unmuted)
        return b.length > 0 ? b : null
      })
      expect(bells).toHaveLength(1)
      expect(bells[0]).toMatchObject({
        type: "group_chat",
        title: "Bell Sender",
        body: "hello bells",
        link: `/messages/group/${groupId}`,
      })

      await settle()
      expect(await bellsFor(sender)).toHaveLength(0)
      expect(await bellsFor(present)).toHaveLength(0)
      expect(await bellsFor(mutedU)).toHaveLength(0)
    })

    it("a reply in a MUTED group still bells the reply target: exactly ONE, reply-flavored", async () => {
      const target = await newUser("Muted Reply Target")
      const actor = await newUser("Group Reply Actor")
      const groupId = await newGroup(target, [actor])
      await makeConversationMutesRepository(h.sql).setMuted(target, "group", groupId, true)

      const original = await addGroupMessage(groupId, target, "please reply", new Date())

      const deps = makeDeps()
      const actorSession = sessionFor(actor, new MockConnection("A"), deps)
      await join(actorSession, groupId)
      await handleClientFrame(
        actorSession,
        frame({
          type: "send",
          cleanupId: groupId,
          roomKind: "group",
          clientId: "r1",
          body: "replying anyway",
          replyToId: original,
        }),
      )

      const bells = await waitFor(async () => {
        const b = await bellsFor(target)
        return b.length > 0 ? b : null
      })
      await settle() // let any (wrong) second bell land before asserting the count
      const finalBells = await bellsFor(target)
      expect(finalBells).toHaveLength(1)
      expect(finalBells[0]).toMatchObject({
        type: "group_chat",
        title: "Group Reply Actor replied to you",
        body: "replying anyway",
        link: `/messages/group/${groupId}`,
      })
      expect(bells[0]!.title).toBe("Group Reply Actor replied to you")
    })

    it("an @-mentioned member gets the MENTION bell, not the fan-out copy; others get the fan-out", async () => {
      const author = await newUser("Group Mention Author")
      const mentionHandle = testHandle()
      const mentioned = await newUser("Group Mentionee", mentionHandle)
      const other = await newUser("Group Fanout Other")
      const groupId = await newGroup(author, [mentioned, other])

      const deps = makeDeps()
      const authorSession = sessionFor(author, new MockConnection("A"), deps)
      await join(authorSession, groupId)
      await handleClientFrame(
        authorSession,
        frame({
          type: "send",
          cleanupId: groupId,
          roomKind: "group",
          clientId: "m1",
          body: `hey @${mentionHandle}`,
        }),
      )

      const mentionedBells = await waitFor(async () => {
        const b = await bellsFor(mentioned)
        return b.length > 0 ? b : null
      })
      const otherBells = await waitFor(async () => {
        const b = await bellsFor(other)
        return b.length > 0 ? b : null
      })
      await settle()

      // Mentioned member: exactly ONE bell, the mention-flavored one, never the fan-out copy.
      const mentionedFinal = await bellsFor(mentioned)
      expect(mentionedFinal).toHaveLength(1)
      expect(mentionedFinal[0]).toMatchObject({
        type: "group_chat",
        title: "Group Mention Author mentioned you",
        link: `/messages/group/${groupId}`,
      })
      expect(mentionedBells[0]!.title).toBe("Group Mention Author mentioned you")
      // Other member: exactly ONE bell, the plain fan-out copy.
      const otherFinal = await bellsFor(other)
      expect(otherFinal).toHaveLength(1)
      expect(otherFinal[0]).toMatchObject({ type: "group_chat", title: "Group Mention Author" })
      expect(otherBells[0]!.title).toBe("Group Mention Author")
      // Author (sender): nothing.
      expect(await bellsFor(author)).toHaveLength(0)
    })

    it("markReadOnOpen (join) clears THIS room's group_chat bells and leaves other rooms' bells", async () => {
      const owner = await newUser("Clear Owner")
      const member = await newUser("Clear Member")
      const groupId = await newGroup(owner, [member])
      const otherGroupId = await newGroup(owner, [member], { name: "Other Crew" })

      const notificationService = makeNotificationService({
        repo: makeDrizzleNotificationRepository(h.sql),
        pushSender: new FakePushSender(),
      })
      await notificationService.createNotification(member, {
        type: "group_chat",
        title: "Clear Owner",
        body: "one",
        link: `/messages/group/${groupId}`,
      })
      await notificationService.createNotification(member, {
        type: "group_chat",
        title: "Clear Owner",
        body: "other room",
        link: `/messages/group/${otherGroupId}`,
      })
      // "Clear" = mark read (the dm/cleanup clear-on-open semantics), so assert on UNREAD rows.
      const unreadLinks = async (): Promise<Array<string | null>> => {
        const rows = await h.sql<{ link: string | null }[]>`
          SELECT link FROM notifications
          WHERE user_id = ${member} AND read_at IS NULL ORDER BY created_at ASC
        `
        return rows.map((r) => r.link)
      }
      expect(await unreadLinks()).toHaveLength(2)

      const deps = makeDeps()
      const memberSession = sessionFor(member, new MockConnection("M"), deps)
      await join(memberSession, groupId)

      // mark-read-on-open is fire-and-forget; poll until THIS room's bell is cleared.
      await waitFor(async () => {
        const links = await unreadLinks()
        return links.every((l) => l !== `/messages/group/${groupId}`) ? true : null
      })
      const remaining = await unreadLinks()
      expect(remaining).toEqual([`/messages/group/${otherGroupId}`])
      // ...and the join also stamped the read watermark.
      const rows = await h.sql<{ last_read_at: Date | null }[]>`
        SELECT last_read_at FROM chat_group_members WHERE group_id = ${groupId} AND user_id = ${member}
      `
      expect(rows[0]!.last_read_at).not.toBeNull()
    })
  })

  describe("same-millisecond keyset pagination (anchor tuple stays in SQL)", () => {
    it("group history: five messages sharing one tx timestamp page 2+2+1 with no dupes/skips", async () => {
      const owner = await newUser("Keyset Owner")
      const groupId = await newGroup(owner, [])

      // ONE transaction => now() is constant, so all five rows share created_at to the MICROSECOND.
      // A ms-truncated JS-Date anchor would make page 2 come back empty (every tied row compares
      // "greater" than the truncated tuple); the SQL-resident anchor keysets on (created_at, id).
      const ids: string[] = []
      await h.sql.begin(async (tx) => {
        for (let i = 0; i < 5; i++) {
          const [r] = await tx<{ id: string }[]>`
            INSERT INTO chat_messages (group_id, sender_id, body, kind)
            VALUES (${groupId}, ${owner}, ${"tied " + String(i)}, 'text')
            RETURNING id
          `
          ids.push(r!.id)
        }
      })
      const stamps = await h.sql<{ n: number }[]>`
        SELECT count(DISTINCT created_at)::int AS n FROM chat_messages WHERE group_id = ${groupId}
      `
      expect(stamps[0]!.n).toBe(1) // the fixture really is a single shared timestamp

      const repo = makeDrizzleChatRepository(h.sql)
      const seen: string[] = []
      let cursor: string | undefined = undefined
      const pageSizes: number[] = []
      for (let i = 0; i < 3; i++) {
        const page = await repo.groupHistory(groupId, cursor, 2, owner)
        pageSizes.push(page.items.length)
        seen.push(...page.items.map((m) => m.id))
        if (page.nextCursor === null) break
        cursor = page.nextCursor
      }
      expect(pageSizes).toEqual([2, 2, 1])
      expect(new Set(seen).size).toBe(5) // no dupes
      expect([...seen].sort()).toEqual([...ids].sort()) // no skips
    })

    it("dm history: five messages sharing one tx timestamp page 2+2+1 with no dupes/skips", async () => {
      const a = await newUser("Keyset DM A")
      const b = await newUser("Keyset DM B")
      const dm = makeDrizzleDmRepository(h.sql)
      const thread = await dm.openOrCreateThread(a, b)

      const ids: string[] = []
      await h.sql.begin(async (tx) => {
        for (let i = 0; i < 5; i++) {
          const [r] = await tx<{ id: string }[]>`
            INSERT INTO dm_messages (thread_id, sender_id, body, kind)
            VALUES (${thread.id}, ${a}, ${"tied dm " + String(i)}, 'text')
            RETURNING id
          `
          ids.push(r!.id)
        }
      })

      const seen: string[] = []
      let cursor: string | undefined = undefined
      const pageSizes: number[] = []
      for (let i = 0; i < 3; i++) {
        const page = await dm.history(thread.id, cursor, 2, a)
        pageSizes.push(page.items.length)
        seen.push(...page.items.map((m) => m.id))
        if (page.nextCursor === null) break
        cursor = page.nextCursor
      }
      expect(pageSizes).toEqual([2, 2, 1])
      expect(new Set(seen).size).toBe(5)
      expect([...seen].sort()).toEqual([...ids].sort())
    })
  })
})
