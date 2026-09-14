/**
 * P4 Task 4.4 integration test (Docker-gated): the group-room REALTIME lane + the unified reaction
 * toggle, against a live PostGIS container (via withPg).
 *
 *   WS seam (handleClientFrame over real Drizzle repos + WsChatService/InMemoryChatPubSub — the same
 *   pieces chat-gateway-wiring composes):
 *     - member send round-trips: sender gets the ack, a second joined member receives the broadcast
 *       {type:"message"} frame, and the row lands group-scoped (roomKind "group");
 *     - NON-member join / send / typing all reject FORBIDDEN (member-only for BOTH kinds until P5's
 *       public-channel read-joins) and persist nothing;
 *     - joining marks the room read (chat_group_members.last_read_at stamped via markReadOnOpen) and
 *       ack {upToId} advances the watermark to that message's created_at;
 *     - @mention of a group MEMBER resolves + records the chat_message_mentions row; a non-member
 *       handle resolves to nothing (no row) — the chat-mention-resolver group scope end-to-end.
 *
 *   HTTP (buildServer + chatOverrides on real repos, FakeChatService watcher for broadcast frames):
 *     - PATCH /messages roomKind:"group" edits the sender's message (200 + message_update broadcast);
 *       a NON-member 403s (the chat-edit-service group lane);
 *     - POST /messages/reactions toggles in a group room (200, refreshed summary, legacy
 *       {type:"reaction"} frame with roomKind:"group") and in a cleanup room (parity, no roomKind
 *       stamp); a group NON-member 403s.
 *
 * When Docker is unavailable the whole block SKIPS so the local suite stays green; CI runs it for real.
 */

import { TEST_TICKET_SIGNER } from "../helpers/ticket-signer.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { buildServer } from "../../src/server.js"
import { buildContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryThreadsRepository, MockConnection } from "../helpers/chat.js"
import type { ChatGatewayOverrides } from "../../src/routes/chat.routes.js"
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
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { makeReportChatRepository } from "../../src/services/report-chat-repository.drizzle.js"
import { canPostToGroup, makeChatGroupRepository } from "../../src/services/chat-group-repository.drizzle.js"
import { makeCleanupService } from "../../src/services/cleanup-service.js"
import { makeChatMentionResolver } from "../../src/services/chat-mention-resolver.js"
import { recordChatMentions } from "../../src/services/chat-mentions.drizzle.js"
import { resolveMentionTargets } from "../../src/services/mention-resolver.drizzle.js"

const pg = await withPg()

describe.skipIf(!pg)("chat groups WS lane + unified reactions (integration)", () => {
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

  /** Direct-SQL group fixture: owner + plain members (management gates are 4.3's suite, not this one). */
  async function newGroup(ownerId: string, memberIds: string[]): Promise<string> {
    const [g] = await h.sql<{ id: string }[]>`
      INSERT INTO chat_groups (name, owner_id) VALUES ('WS Crew', ${ownerId}) RETURNING id
    `
    const groupId = g!.id
    await h.sql`
      INSERT INTO chat_group_members (group_id, user_id, role) VALUES (${groupId}, ${ownerId}, 'owner')
    `
    for (const m of memberIds) {
      await h.sql`
        INSERT INTO chat_group_members (group_id, user_id, role) VALUES (${groupId}, ${m}, 'member')
      `
    }
    return groupId
  }

  const lastReadAt = async (groupId: string, userId: string): Promise<Date | null> => {
    const rows = await h.sql<{ last_read_at: Date | null }[]>`
      SELECT last_read_at FROM chat_group_members
      WHERE group_id = ${groupId} AND user_id = ${userId}
    `
    return rows[0]?.last_read_at ?? null
  }

  /** Let fire-and-forget microtasks (mark-read-on-open, broadcasts) flush. */
  const flush = () => new Promise((resolve) => setImmediate(resolve))

  describe("WS seam (handleClientFrame over real repos)", () => {
    /** Fresh gateway deps per test: real Drizzle persistence, in-process pub/sub + presence. */
    function makeDeps() {
      const chatRepo = makeDrizzleChatRepository(h.sql)
      const groups = makeChatGroupRepository(h.sql)
      const chat = new WsChatService({ repo: chatRepo, pubsub: new InMemoryChatPubSub() })
      const deps: GatewayDeps = {
        chat,
        isMember: () => Promise.resolve(false),
        presence: new InMemoryChatPresence(),
        groupChat: {
          isMember: async (groupId, userId) => (await groups.roleOf(groupId, userId)) !== null,
          access: async (groupId, userId) => {
            const a = await groups.accessOf(groupId, userId)
            return a === null
              ? null
              : { isMember: a.role !== null, canPost: canPostToGroup(a), visibility: a.visibility }
          },
          advanceReadWatermark: (groupId, userId, upToId) =>
            groups.advanceReadWatermark(groupId, userId, upToId),
        },
        markReadOnOpen: (kind, id, userId) =>
          kind === "group" ? groups.markRead(id, userId, new Date()) : Promise.resolve(),
        chatMentions: {
          resolveChatMentions: makeChatMentionResolver({
            resolveTargets: (input) => resolveMentionTargets(h.sql, input),
            dmPeerOf: () => Promise.resolve(null),
            listCleanupMemberIds: () => Promise.resolve([]),
            listReportChatMemberIds: () => Promise.resolve([]),
            listGroupMemberIds: (groupId) => groups.listMemberIds(groupId),
          }),
          recordChatMentions: (messageId, ids) => recordChatMentions(h.sql, messageId, ids),
          // Bells are 4.5's — the WS lane only needs resolve+record here.
          notifyChatMention: () => Promise.resolve(),
        },
      }
      return deps
    }

    function sessionFor(userId: string, conn: MockConnection, deps: GatewayDeps): GatewaySession {
      return { userId, conn, joined: new Set<string>(), typingThrottle: new Map<string, number>(), deps }
    }

    const frame = (f: Record<string, unknown>) => JSON.stringify(f)

    it("member send round-trips: ack to the sender, broadcast to a second member, group-scoped row", async () => {
      const aId = await newUser("WS A")
      const bId = await newUser("WS B")
      const groupId = await newGroup(aId, [bId])
      const deps = makeDeps()

      const aConn = new MockConnection("A")
      const bConn = new MockConnection("B")
      const aSession = sessionFor(aId, aConn, deps)
      const bSession = sessionFor(bId, bConn, deps)
      await handleClientFrame(aSession, frame({ type: "join", cleanupId: groupId, roomKind: "group" }))
      await handleClientFrame(bSession, frame({ type: "join", cleanupId: groupId, roomKind: "group" }))
      expect(aConn.framesOfType("error")).toHaveLength(0)
      expect(aSession.joined.has(`group:${groupId}`)).toBe(true)

      await handleClientFrame(
        aSession,
        frame({ type: "send", cleanupId: groupId, roomKind: "group", clientId: "c1", body: "hello group" }),
      )

      const acks = aConn.framesOfType("ack")
      expect(acks).toHaveLength(1)
      const acked = (acks[0] as { message: { id: string; roomKind?: string; body: string } }).message
      expect(acked.roomKind).toBe("group")
      expect(acked.body).toBe("hello group")

      const received = bConn.framesOfType("message")
      expect(received).toHaveLength(1)
      expect((received[0] as { message: { id: string } }).message.id).toBe(acked.id)

      // Persisted group-scoped (group_id set, cleanup/report refs NULL — the 0047 three-way XOR).
      const rows = await h.sql<{ group_id: string | null; cleanup_id: string | null }[]>`
        SELECT group_id, cleanup_id FROM chat_messages WHERE id = ${acked.id}
      `
      expect(rows[0]).toMatchObject({ group_id: groupId, cleanup_id: null })
    })

    it("NON-member join is rejected FORBIDDEN and the socket is not admitted", async () => {
      const ownerId = await newUser("WS Owner")
      const strangerId = await newUser("WS Stranger")
      const groupId = await newGroup(ownerId, [])
      const deps = makeDeps()

      const conn = new MockConnection("S")
      const session = sessionFor(strangerId, conn, deps)
      await handleClientFrame(session, frame({ type: "join", cleanupId: groupId, roomKind: "group" }))

      const errors = conn.framesOfType("error")
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ code: "FORBIDDEN", roomKind: "group" })
      expect(session.joined.has(`group:${groupId}`)).toBe(false)
    })

    it("NON-member send is rejected and persists nothing", async () => {
      const ownerId = await newUser("WS Owner2")
      const strangerId = await newUser("WS Stranger2")
      const groupId = await newGroup(ownerId, [])
      const deps = makeDeps()

      const conn = new MockConnection("S")
      const session = sessionFor(strangerId, conn, deps)
      await handleClientFrame(
        session,
        frame({ type: "send", cleanupId: groupId, roomKind: "group", clientId: "cx", body: "let me in" }),
      )

      expect(conn.framesOfType("ack")).toHaveLength(0)
      const errors = conn.framesOfType("error")
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ code: "FORBIDDEN" })
      const rows = await h.sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM chat_messages WHERE group_id = ${groupId}
      `
      expect(rows[0]!.count).toBe(0)
    })

    it("typing is member-gated: a member's typing fans out, a non-member's errors", async () => {
      const aId = await newUser("WS Typist")
      const bId = await newUser("WS Watcher")
      const strangerId = await newUser("WS TypeStranger")
      const groupId = await newGroup(aId, [bId])
      const deps = makeDeps()

      const aConn = new MockConnection("A")
      const bConn = new MockConnection("B")
      const aSession = sessionFor(aId, aConn, deps)
      const bSession = sessionFor(bId, bConn, deps)
      await handleClientFrame(aSession, frame({ type: "join", cleanupId: groupId, roomKind: "group" }))
      await handleClientFrame(bSession, frame({ type: "join", cleanupId: groupId, roomKind: "group" }))

      await handleClientFrame(aSession, frame({ type: "typing", cleanupId: groupId, roomKind: "group" }))
      const typing = bConn.framesOfType("typing")
      expect(typing).toHaveLength(1)
      expect(typing[0]).toMatchObject({ cleanupId: groupId, roomKind: "group", userId: aId })

      const sConn = new MockConnection("S")
      const sSession = sessionFor(strangerId, sConn, deps)
      await handleClientFrame(sSession, frame({ type: "typing", cleanupId: groupId, roomKind: "group" }))
      expect(sConn.framesOfType("error")).toHaveLength(1)
    })

    it("join marks the room read and ack {upToId} advances chat_group_members.last_read_at", async () => {
      const aId = await newUser("WS Reader A")
      const bId = await newUser("WS Reader B")
      const groupId = await newGroup(aId, [bId])
      const deps = makeDeps()

      expect(await lastReadAt(groupId, bId)).toBeNull()

      const aConn = new MockConnection("A")
      const bConn = new MockConnection("B")
      const aSession = sessionFor(aId, aConn, deps)
      const bSession = sessionFor(bId, bConn, deps)
      await handleClientFrame(bSession, frame({ type: "join", cleanupId: groupId, roomKind: "group" }))
      // Mark-read-on-join (mirrors the cleanup lane) is FIRE-AND-FORGET behind a real SQL round-trip,
      // so poll briefly rather than racing a single microtask flush.
      let afterJoin: Date | null = null
      for (let i = 0; i < 50 && afterJoin === null; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        afterJoin = await lastReadAt(groupId, bId)
      }
      expect(afterJoin).not.toBeNull()

      // A message lands AFTER the join stamp; B acks it -> watermark advances to its created_at.
      await handleClientFrame(aSession, frame({ type: "join", cleanupId: groupId, roomKind: "group" }))
      await handleClientFrame(
        aSession,
        frame({ type: "send", cleanupId: groupId, roomKind: "group", clientId: "c1", body: "new msg" }),
      )
      const acked = (aConn.framesOfType("ack")[0] as { message: { id: string; createdAt: string } }).message
      await handleClientFrame(
        bSession,
        frame({ type: "ack", cleanupId: groupId, roomKind: "group", upToId: acked.id }),
      )
      const afterAck = await lastReadAt(groupId, bId)
      expect(afterAck).not.toBeNull()
      expect(afterAck!.getTime()).toBe(new Date(acked.createdAt).getTime())
      expect(afterAck!.getTime()).toBeGreaterThanOrEqual(afterJoin!.getTime())
    })

    it("@mention of a group member records the row; a non-member handle resolves to nothing", async () => {
      const authorId = await newUser("WS Mentioner")
      const memberHandle = testHandle()
      const memberId = await newUser("WS Mentionee", memberHandle)
      const outsiderHandle = testHandle()
      await newUser("WS Outsider", outsiderHandle)
      const groupId = await newGroup(authorId, [memberId])
      const deps = makeDeps()

      const conn = new MockConnection("A")
      const session = sessionFor(authorId, conn, deps)
      await handleClientFrame(session, frame({ type: "join", cleanupId: groupId, roomKind: "group" }))

      // Member mention: resolved (scoped to chat_group_members), recorded, and riding the ack DTO.
      await handleClientFrame(
        session,
        frame({
          type: "send",
          cleanupId: groupId,
          roomKind: "group",
          clientId: "m1",
          body: `hey @${memberHandle}`,
        }),
      )
      const acked = (
        conn.framesOfType("ack")[0] as { message: { id: string; mentions?: { id: string }[] } }
      ).message
      expect(acked.mentions?.map((m) => m.id)).toEqual([memberId])
      const recorded = await h.sql<{ mentioned_user_id: string }[]>`
        SELECT mentioned_user_id FROM chat_message_mentions WHERE message_id = ${acked.id}
      `
      expect(recorded.map((r) => r.mentioned_user_id)).toEqual([memberId])

      // Non-member mention: the handle EXISTS but is outside chat_group_members -> no row.
      await handleClientFrame(
        session,
        frame({
          type: "send",
          cleanupId: groupId,
          roomKind: "group",
          clientId: "m2",
          body: `hey @${outsiderHandle}`,
        }),
      )
      const acked2 = (conn.framesOfType("ack")[1] as { message: { id: string } }).message
      const recorded2 = await h.sql<{ mentioned_user_id: string }[]>`
        SELECT mentioned_user_id FROM chat_message_mentions WHERE message_id = ${acked2.id}
      `
      expect(recorded2).toHaveLength(0)
    })
  })

  describe("HTTP: group edit lane + unified reaction toggle", () => {
    let app: FastifyInstance
    let container: Container
    let authServices: AuthServices

    beforeAll(async () => {
      const env = loadEnv({ NODE_ENV: "test" })
      authServices = buildAuthServices({
        stores: makeInMemoryStores(),
        cache: new InMemoryCacheClient(() => Date.now()),
        mailer: new FakeMailer(),
        oauthConfig: {},
        verifier: new StubJwksVerifier(),
        now: () => Date.now(),
      })
      const cleanups = makeDrizzleCleanupRepository(h.sql)
      const overrides: ChatGatewayOverrides = {
        isMember: (cleanupId, userId) => cleanups.isMember(cleanupId, userId),
        threadsRepo: new InMemoryThreadsRepository(),
        dmRepo: makeDrizzleDmRepository(h.sql),
        chatRepo: makeDrizzleChatRepository(h.sql),
        blocksRepo: makeDrizzleBlocksRepository(h.sql),
        reportChat: makeReportChatRepository(h.sql),
        groups: makeChatGroupRepository(h.sql),
      }
      container = buildContainer(env)
      app = await buildServer({ env, container, authServices, chatOverrides: overrides })
    })

    afterAll(async () => {
      await app.close()
    })

    const token = (userId: string) => authServices.sessions.createSession(userId, [])
    const chat = () => makeDrizzleChatRepository(h.sql)

    it("PATCH /messages roomKind:group edits the sender's message + broadcasts message_update", async () => {
      const senderId = await newUser("Edit Sender")
      const watcherId = await newUser("Edit Watcher")
      const groupId = await newGroup(senderId, [watcherId])
      const msg = await chat().insertMessage(
        { cleanupId: groupId, roomKind: "group", userId: senderId, body: "tpyo" },
        randomUUID(),
      )

      // A second connected client in the group room (FakeChatService joinRoom keys by room key).
      const watcher = new MockConnection("watcher")
      await container.chatService.joinRoom(roomKeyFor("group", groupId), watcher, watcherId)

      const res = await app.inject({
        method: "PATCH",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${await token(senderId)}`, "x-client": "mobile" },
        payload: { roomKind: "group", roomId: groupId, messageId: msg.id, body: "typo" },
      })
      expect(res.statusCode).toBe(200)
      const dto = res.json()
      expect(dto.body).toBe("typo")
      expect(dto.editedAt).toBeTruthy()
      expect(dto.roomKind).toBe("group")

      await flush()
      const updates = watcher.framesOfType("message_update")
      expect(updates).toHaveLength(1)
      expect(updates[0]).toMatchObject({
        type: "message_update",
        roomKind: "group",
        roomId: groupId,
        message: { id: msg.id, body: "typo" },
      })
    })

    it("PATCH /messages roomKind:group by a NON-member 403s (no state leaked)", async () => {
      const senderId = await newUser("Edit Owner2")
      const strangerId = await newUser("Edit Stranger")
      const groupId = await newGroup(senderId, [])
      const msg = await chat().insertMessage(
        { cleanupId: groupId, roomKind: "group", userId: senderId, body: "mine" },
        randomUUID(),
      )

      const res = await app.inject({
        method: "PATCH",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${await token(strangerId)}`, "x-client": "mobile" },
        payload: { roomKind: "group", roomId: groupId, messageId: msg.id, body: "hijack" },
      })
      expect(res.statusCode).toBe(403)
      const reread = await chat().findGroupMessage(groupId, msg.id, senderId)
      expect(reread?.body).toBe("mine")
    })

    it("POST /messages/reactions toggles in a group room: 200, summary, legacy reaction frame", async () => {
      const senderId = await newUser("React Sender")
      const reactorId = await newUser("React Member")
      const groupId = await newGroup(senderId, [reactorId])
      const msg = await chat().insertMessage(
        { cleanupId: groupId, roomKind: "group", userId: senderId, body: "react to me" },
        randomUUID(),
      )

      const watcher = new MockConnection("react-watcher")
      await container.chatService.joinRoom(roomKeyFor("group", groupId), watcher, senderId)

      const res = await app.inject({
        method: "POST",
        url: "/v1/messages/reactions",
        headers: { authorization: `Bearer ${await token(reactorId)}`, "x-client": "mobile" },
        payload: { roomKind: "group", roomId: groupId, messageId: msg.id, emoji: "heart" },
      })
      expect(res.statusCode).toBe(200)
      const dto = res.json()
      expect(dto.id).toBe(msg.id)
      expect(dto.reactions).toEqual([{ emoji: "heart", count: 1, mine: true }])

      await flush()
      const frames = watcher.framesOfType("reaction")
      expect(frames).toHaveLength(1)
      // The EXACT legacy frame shape the per-room toggles broadcast (roomId rides `cleanupId`).
      expect(frames[0]).toMatchObject({
        type: "reaction",
        cleanupId: groupId,
        roomKind: "group",
        message: { id: msg.id },
      })

      // Toggle OFF (same route, same emoji): the summary empties.
      const off = await app.inject({
        method: "POST",
        url: "/v1/messages/reactions",
        headers: { authorization: `Bearer ${await token(reactorId)}`, "x-client": "mobile" },
        payload: { roomKind: "group", roomId: groupId, messageId: msg.id, emoji: "heart" },
      })
      expect(off.statusCode).toBe(200)
      expect(off.json().reactions).toEqual([])
    })

    it("POST /messages/reactions works for a cleanup room too (parity, no roomKind stamp)", async () => {
      const organizerId = await newUser("React Org")
      const created = await makeCleanupService({
        tickets: TEST_TICKET_SIGNER,
        repo: makeDrizzleCleanupRepository(h.sql),
      }).createCleanup(
        {
          title: "Reaction sweep",
          type: "site",
          eventKind: "cleanup",
          lat: 34.05,
          lng: -118.25,
          scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          slots: [{ title: "General volunteers", capacity: null }],
        },
        organizerId,
      )
      const cleanupId = created.id
      const msg = await chat().insertMessage(
        { cleanupId, userId: organizerId, body: "cleanup msg" },
        randomUUID(),
      )

      const watcher = new MockConnection("cleanup-watcher")
      await container.chatService.joinRoom(roomKeyFor("cleanup", cleanupId), watcher, organizerId)

      const res = await app.inject({
        method: "POST",
        url: "/v1/messages/reactions",
        headers: { authorization: `Bearer ${await token(organizerId)}`, "x-client": "mobile" },
        payload: { roomKind: "cleanup", roomId: cleanupId, messageId: msg.id, emoji: "like" },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().reactions).toEqual([{ emoji: "like", count: 1, mine: true }])

      await flush()
      const frames = watcher.framesOfType("reaction")
      expect(frames).toHaveLength(1)
      expect(frames[0]).toMatchObject({ type: "reaction", cleanupId, message: { id: msg.id } })
      // Cleanup rooms omit roomKind on the legacy frame — mirrored exactly.
      expect(frames[0]).not.toHaveProperty("roomKind")
    })

    it("POST /messages/reactions by a group NON-member 403s; wrong room 404s", async () => {
      const senderId = await newUser("React Owner2")
      const strangerId = await newUser("React Stranger")
      const groupId = await newGroup(senderId, [])
      const otherGroupId = await newGroup(senderId, [])
      const msg = await chat().insertMessage(
        { cleanupId: groupId, roomKind: "group", userId: senderId, body: "private" },
        randomUUID(),
      )

      const forbidden = await app.inject({
        method: "POST",
        url: "/v1/messages/reactions",
        headers: { authorization: `Bearer ${await token(strangerId)}`, "x-client": "mobile" },
        payload: { roomKind: "group", roomId: groupId, messageId: msg.id, emoji: "like" },
      })
      expect(forbidden.statusCode).toBe(403)

      // Room-ref mismatch (a MEMBER of the other group probing a foreign message id) -> 404.
      const wrongRoom = await app.inject({
        method: "POST",
        url: "/v1/messages/reactions",
        headers: { authorization: `Bearer ${await token(senderId)}`, "x-client": "mobile" },
        payload: { roomKind: "group", roomId: otherGroupId, messageId: msg.id, emoji: "like" },
      })
      expect(wrongRoom.statusCode).toBe(404)
    })

    it("POST /messages/reactions on a TOMBSTONE 404s and inserts no orphan reaction row (group + dm)", async () => {
      // Group branch: sender tombstones their own message, a member then reacts -> 404, zero rows.
      const senderId = await newUser("Tomb Sender")
      const reactorId = await newUser("Tomb Reactor")
      const groupId = await newGroup(senderId, [reactorId])
      const msg = await chat().insertMessage(
        { cleanupId: groupId, roomKind: "group", userId: senderId, body: "soon gone" },
        randomUUID(),
      )
      expect(await chat().softDeleteGroup(groupId, msg.id, senderId)).not.toBeNull()

      const res = await app.inject({
        method: "POST",
        url: "/v1/messages/reactions",
        headers: { authorization: `Bearer ${await token(reactorId)}`, "x-client": "mobile" },
        payload: { roomKind: "group", roomId: groupId, messageId: msg.id, emoji: "heart" },
      })
      expect(res.statusCode).toBe(404)
      const orphaned = await h.sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM chat_message_reactions WHERE message_id = ${msg.id}
      `
      expect(orphaned[0]!.count).toBe(0)

      // DM branch: same gate on the dm lane of the unified route.
      const dmRepo = makeDrizzleDmRepository(h.sql)
      const peerId = await newUser("Tomb DM Peer")
      const thread = await dmRepo.openOrCreateThread(senderId, peerId)
      const dmMsg = await dmRepo.persist({ threadId: thread.id, senderId, body: "dm soon gone" })
      expect(await dmRepo.softDelete(thread.id, dmMsg.id, senderId)).not.toBeNull()

      const dmRes = await app.inject({
        method: "POST",
        url: "/v1/messages/reactions",
        headers: { authorization: `Bearer ${await token(peerId)}`, "x-client": "mobile" },
        payload: { roomKind: "dm", roomId: thread.id, messageId: dmMsg.id, emoji: "heart" },
      })
      expect(dmRes.statusCode).toBe(404)
      const dmOrphaned = await h.sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM chat_message_reactions WHERE message_id = ${dmMsg.id}
      `
      expect(dmOrphaned[0]!.count).toBe(0)
    })
  })
})
