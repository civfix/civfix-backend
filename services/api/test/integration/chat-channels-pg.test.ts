/**
 * Integration test (Docker-gated): CHANNEL read-only enforcement + PUBLIC self-serve join,
 * against a live PostGIS container (via withPg).
 *
 *   Channels are chat_groups with kind='channel': every member reads, but only owner/admin post. A
 *   regular kind='group' is unchanged (members write). visibility='public' groups/channels admit any
 *   authed user (self-serve join + WS read-only presence join + pre-join history reads); 'private'
 *   stays member-only.
 *
 *   HTTP (buildServer + chatOverrides on real repos):
 *     - POST /groups/:id/join: public 200 (myRole 'member', memberCount bumps) + idempotent re-join
 *       (no dupe row, count stable); private 403 not_public;
 *     - GET /groups/:id/messages: a non-member reads a PUBLIC channel's history 200, a PRIVATE one 403;
 *     - PATCH /messages roomKind:'group' by a read-only CHANNEL member 403s (the edit lane reuses the
 *       SEND-permission gate, not bare membership);
 *     - POST /messages/reactions: a joined (read-only) channel member reacts 200; a public NON-member
 *       reader 403s (reactions stay member-gated).
 *
 *   WS seam (handleClientFrame over real Drizzle repos + WsChatService/InMemoryChatPubSub):
 *     - a channel MEMBER's send is rejected with error code 'channel_read_only' and persists nothing;
 *       an ADMIN's send round-trips (ack + broadcast to a read-only member);
 *     - a read-only member's typing is rejected (same restriction as send);
 *     - a NON-member joins a PUBLIC channel (read-only presence, no error) but their send still rejects.
 *
 *   Threads: a channel thread carries MessageThreadDTO.channel:true; a plain group thread does not.
 *
 * When Docker is unavailable the whole block SKIPS so the local suite stays green; CI runs it for real.
 */

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
import { handleClientFrame, type GatewayDeps, type GatewaySession } from "../../src/ws/gateway.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatPubSub } from "../../src/adapters/chat-pubsub.js"
import { InMemoryChatPresence } from "../../src/adapters/chat-presence.js"
import { makeDrizzleChatRepository } from "../../src/services/chat-repository.drizzle.js"
import { makeDrizzleDmRepository } from "../../src/services/dm-repository.drizzle.js"
import { makeDrizzleBlocksRepository } from "../../src/services/blocks-repository.drizzle.js"
import { makeReportChatRepository } from "../../src/services/report-chat-repository.drizzle.js"
import {
  canPostToGroup,
  makeChatGroupRepository,
} from "../../src/services/chat-group-repository.drizzle.js"
import {
  makeDrizzleGroupThreadsSource,
  makeDrizzleThreadsRepository,
} from "../../src/services/threads-repository.drizzle.js"
import { makeThreadsService, InMemoryChatReadState } from "../../src/services/threads-service.js"

const pg = await withPg()

describe.skipIf(!pg)("chat channels: read-only enforcement + public join (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
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
   * Direct-SQL room fixture. `kind` picks group vs channel; `visibility` picks private vs public;
   * `members` are (id, role) pairs joined alongside the owner.
   */
  async function newRoom(
    ownerId: string,
    opts: {
      kind?: "group" | "channel"
      visibility?: "private" | "public"
      members?: Array<{ id: string; role?: "admin" | "member" }>
    } = {},
  ): Promise<string> {
    const [g] = await h.sql<{ id: string }[]>`
      INSERT INTO chat_groups (name, owner_id, kind, visibility)
      VALUES ('Broadcast', ${ownerId}, ${opts.kind ?? "channel"}, ${opts.visibility ?? "private"})
      RETURNING id
    `
    const groupId = g!.id
    await h.sql`
      INSERT INTO chat_group_members (group_id, user_id, role) VALUES (${groupId}, ${ownerId}, 'owner')
    `
    for (const m of opts.members ?? []) {
      await h.sql`
        INSERT INTO chat_group_members (group_id, user_id, role)
        VALUES (${groupId}, ${m.id}, ${m.role ?? "member"})
      `
    }
    return groupId
  }

  const chat = () => makeDrizzleChatRepository(h.sql)

  const memberCount = async (groupId: string): Promise<number> => {
    const rows = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chat_group_members WHERE group_id = ${groupId}
    `
    return rows[0]!.n
  }

  describe("HTTP: join + read gates + edit + reactions", () => {
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
      const overrides: ChatGatewayOverrides = {
        isMember: () => Promise.resolve(false),
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

    // Per-request remoteAddress keeps the IP-keyed rate limiters (join 20/min etc.) out of the way.
    let injectSeq = 0
    function inject(tok: string, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) {
      injectSeq += 1
      return app.inject({
        method,
        url,
        remoteAddress: `10.43.${Math.floor(injectSeq / 250)}.${(injectSeq % 250) + 1}`,
        headers: { authorization: `Bearer ${tok}`, "x-client": "mobile" },
        ...(payload !== undefined ? { payload: payload as object } : {}),
      })
    }

    it("POST /groups/:id/join: public 200 with myRole member + count bump; idempotent re-join", async () => {
      const ownerId = await newUser("Join Owner")
      const joinerId = await newUser("Join Stranger")
      const channelId = await newRoom(ownerId, { kind: "channel", visibility: "public" })
      expect(await memberCount(channelId)).toBe(1)

      const first = await inject(await token(joinerId), "POST", `/v1/groups/${channelId}/join`)
      expect(first.statusCode).toBe(200)
      expect(first.json()).toMatchObject({ id: channelId, myRole: "member", memberCount: 2 })
      expect(await memberCount(channelId)).toBe(2)

      // Re-join is a no-op: no dupe row, count stable, still 'member'.
      const again = await inject(await token(joinerId), "POST", `/v1/groups/${channelId}/join`)
      expect(again.statusCode).toBe(200)
      expect(again.json()).toMatchObject({ myRole: "member", memberCount: 2 })
      expect(await memberCount(channelId)).toBe(2)
    })

    it("POST /groups/:id/join: private 403 not_public", async () => {
      const ownerId = await newUser("Priv Join Owner")
      const strangerId = await newUser("Priv Join Stranger")
      const channelId = await newRoom(ownerId, { kind: "channel", visibility: "private" })

      const res = await inject(await token(strangerId), "POST", `/v1/groups/${channelId}/join`)
      expect(res.statusCode).toBe(403)
      expect(res.json().fields).toMatchObject({ code: "not_public" })
      expect(await memberCount(channelId)).toBe(1)
    })

    it("GET /groups/:id/messages: non-member reads a PUBLIC channel 200, a PRIVATE one 403", async () => {
      const ownerId = await newUser("Read Owner")
      const strangerId = await newUser("Read Stranger")
      const publicCh = await newRoom(ownerId, { kind: "channel", visibility: "public" })
      const privateCh = await newRoom(ownerId, { kind: "channel", visibility: "private" })
      await chat().insertMessage(
        { cleanupId: publicCh, roomKind: "group", userId: ownerId, body: "broadcast" },
        randomUUID(),
      )

      const pub = await inject(await token(strangerId), "GET", `/v1/groups/${publicCh}/messages`)
      expect(pub.statusCode).toBe(200)
      expect(pub.json().items.map((m: { body: string }) => m.body)).toEqual(["broadcast"])

      const priv = await inject(await token(strangerId), "GET", `/v1/groups/${privateCh}/messages`)
      expect(priv.statusCode).toBe(403)
    })

    it("PATCH /messages roomKind:group by a read-only CHANNEL member 403s (send-permission gate)", async () => {
      const ownerId = await newUser("Edit Ch Owner")
      const memberId = await newUser("Edit Ch Member")
      const channelId = await newRoom(ownerId, {
        kind: "channel",
        members: [{ id: memberId, role: "member" }],
      })
      // A read-only member can't author, so target the OWNER's message: the gate 403s before the
      // sender/window checks (belt-and-braces: a read-only member's edit is rejected like a WS send).
      const msg = await chat().insertMessage(
        { cleanupId: channelId, roomKind: "group", userId: ownerId, body: "owner post" },
        randomUUID(),
      )

      const res = await inject(await token(memberId), "PATCH", "/v1/messages", {
        roomKind: "group",
        roomId: channelId,
        messageId: msg.id,
        body: "hijack",
      })
      expect(res.statusCode).toBe(403)
      expect((await chat().findGroupMessage(channelId, msg.id, ownerId))?.body).toBe("owner post")
    })

    it("POST /messages/reactions: a channel MEMBER reacts 200; a public NON-member reader 403s", async () => {
      const ownerId = await newUser("React Ch Owner")
      const memberId = await newUser("React Ch Member")
      const strangerId = await newUser("React Ch Stranger")
      const channelId = await newRoom(ownerId, {
        kind: "channel",
        visibility: "public",
        members: [{ id: memberId, role: "member" }],
      })
      const msg = await chat().insertMessage(
        { cleanupId: channelId, roomKind: "group", userId: ownerId, body: "react to me" },
        randomUUID(),
      )

      // A joined (read-only) member may react: reactions stay MEMBER-gated, not send-gated.
      const ok = await inject(await token(memberId), "POST", "/v1/messages/reactions", {
        roomKind: "group",
        roomId: channelId,
        messageId: msg.id,
        emoji: "heart",
      })
      expect(ok.statusCode).toBe(200)
      expect(ok.json().reactions).toEqual([{ emoji: "heart", count: 1, mine: true }])

      // A public non-member reader is NOT a member -> can't react even though the room is readable.
      const denied = await inject(await token(strangerId), "POST", "/v1/messages/reactions", {
        roomKind: "group",
        roomId: channelId,
        messageId: msg.id,
        emoji: "like",
      })
      expect(denied.statusCode).toBe(403)
    })
  })

  describe("WS seam: channel read-only send/typing + public read-join", () => {
    function makeDeps(): GatewayDeps {
      const chatRepo = makeDrizzleChatRepository(h.sql)
      const groups = makeChatGroupRepository(h.sql)
      return {
        chat: new WsChatService({ repo: chatRepo, pubsub: new InMemoryChatPubSub() }),
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
      }
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

    it("a channel MEMBER's send is rejected channel_read_only and persists nothing; the ADMIN's round-trips", async () => {
      const ownerId = await newUser("Ch Owner")
      const adminId = await newUser("Ch Admin")
      const memberId = await newUser("Ch Member")
      const channelId = await newRoom(ownerId, {
        kind: "channel",
        members: [
          { id: adminId, role: "admin" },
          { id: memberId, role: "member" },
        ],
      })
      const deps = makeDeps()

      const adminConn = new MockConnection("admin")
      const memberConn = new MockConnection("member")
      const adminSession = sessionFor(adminId, adminConn, deps)
      const memberSession = sessionFor(memberId, memberConn, deps)
      // Both are members, so both may JOIN (read-only for the plain member).
      await handleClientFrame(
        adminSession,
        frame({ type: "join", cleanupId: channelId, roomKind: "group" }),
      )
      await handleClientFrame(
        memberSession,
        frame({ type: "join", cleanupId: channelId, roomKind: "group" }),
      )
      expect(memberConn.framesOfType("error")).toHaveLength(0)

      // Read-only member send -> channel_read_only, no ack, nothing persisted.
      await handleClientFrame(
        memberSession,
        frame({
          type: "send",
          cleanupId: channelId,
          roomKind: "group",
          clientId: "m1",
          body: "let me post",
        }),
      )
      expect(memberConn.framesOfType("ack")).toHaveLength(0)
      const memberErr = memberConn.framesOfType("error")
      expect(memberErr).toHaveLength(1)
      expect(memberErr[0]).toMatchObject({ code: "channel_read_only", roomKind: "group" })

      // Admin send -> ack to the admin, broadcast to the read-only member, row persisted group-scoped.
      await handleClientFrame(
        adminSession,
        frame({
          type: "send",
          cleanupId: channelId,
          roomKind: "group",
          clientId: "a1",
          body: "the news",
        }),
      )
      const acks = adminConn.framesOfType("ack")
      expect(acks).toHaveLength(1)
      const acked = (acks[0] as { message: { id: string; body: string } }).message
      expect(acked.body).toBe("the news")
      expect(
        (memberConn.framesOfType("message")[0] as { message: { id: string } }).message.id,
      ).toBe(acked.id)

      const rows = await h.sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM chat_messages WHERE group_id = ${channelId}
      `
      expect(rows[0]!.count).toBe(1) // only the admin's message
    })

    it("a read-only channel member's typing is rejected (channel_read_only)", async () => {
      const ownerId = await newUser("Type Ch Owner")
      const memberId = await newUser("Type Ch Member")
      const channelId = await newRoom(ownerId, {
        kind: "channel",
        members: [{ id: memberId, role: "member" }],
      })
      const deps = makeDeps()

      const conn = new MockConnection("member")
      const session = sessionFor(memberId, conn, deps)
      await handleClientFrame(
        session,
        frame({ type: "join", cleanupId: channelId, roomKind: "group" }),
      )
      await handleClientFrame(
        session,
        frame({ type: "typing", cleanupId: channelId, roomKind: "group" }),
      )

      const errors = conn.framesOfType("error")
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ code: "channel_read_only" })
    })

    it("a NON-member joins a PUBLIC channel (read-only presence) but a send still rejects", async () => {
      const ownerId = await newUser("Pub Ch Owner")
      const strangerId = await newUser("Pub Ch Stranger")
      const channelId = await newRoom(ownerId, { kind: "channel", visibility: "public" })
      const deps = makeDeps()

      const conn = new MockConnection("stranger")
      const session = sessionFor(strangerId, conn, deps)
      // Public read-only join: admitted, no error, presence snapshot delivered.
      await handleClientFrame(
        session,
        frame({ type: "join", cleanupId: channelId, roomKind: "group" }),
      )
      expect(conn.framesOfType("error")).toHaveLength(0)
      expect(session.joined.has(`group:${channelId}`)).toBe(true)
      expect(conn.framesOfType("presence_snapshot")).toHaveLength(1)

      // ...but they're not a member, so a send is rejected and nothing persists.
      await handleClientFrame(
        session,
        frame({
          type: "send",
          cleanupId: channelId,
          roomKind: "group",
          clientId: "x",
          body: "sneak in",
        }),
      )
      expect(conn.framesOfType("ack")).toHaveLength(0)
      expect(conn.framesOfType("error")).toHaveLength(1)
      const rows = await h.sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM chat_messages WHERE group_id = ${channelId}
      `
      expect(rows[0]!.count).toBe(0)
    })
  })

  describe("threads inbox: channel flag", () => {
    function threadsService() {
      return makeThreadsService({
        repo: makeDrizzleThreadsRepository(h.sql),
        readState: new InMemoryChatReadState(),
        group: makeDrizzleGroupThreadsSource(h.sql),
        now: () => new Date("2026-06-01T12:00:00.000Z"),
      })
    }

    it("a channel thread carries channel:true; a plain group thread does not", async () => {
      const me = await newUser("Flag Member")
      const owner = await newUser("Flag Owner")
      const channelId = await newRoom(owner, { kind: "channel", members: [{ id: me }] })
      const groupId = await newRoom(owner, { kind: "group", members: [{ id: me }] })

      const { items } = await threadsService().listThreads(me)
      const channelThread = items.find((x) => x.id === channelId)
      const groupThread = items.find((x) => x.id === groupId)
      expect(channelThread, "member should see the channel thread").toBeDefined()
      expect(groupThread, "member should see the group thread").toBeDefined()
      expect(channelThread!.channel).toBe(true)
      expect(groupThread!.channel).toBeUndefined()
    })
  })
})
