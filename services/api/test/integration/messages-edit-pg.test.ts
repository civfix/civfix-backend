/**
 * Unified chat-message EDIT integration test (Docker-gated; P0 Task 0.2). Boots against a live PostGIS
 * container (via withPg) and exercises chat-edit-service — the roomKind-dispatching edit path behind the
 * upcoming PATCH /messages route (Task 0.3) and the already-mounted DM edit route — against real Postgres:
 *
 *   - edit own cleanup text message: body updated, edited_at stamped, hydrated DTO returned, and a
 *     message_update frame is handed to the broadcast seam with the room's key;
 *   - the gate ladder: non-sender 403 (code not_sender), >EDIT_WINDOW_HOURS-old 403 (code
 *     edit_window_expired), soft-deleted 409, non-text / sender-less SYSTEM rows 422, wrong roomId 404,
 *     room-send permission re-checked (membership revoked -> 403);
 *   - PATCH /dm/:threadId/messages/:messageId (the OLD route, now delegating to the service) still edits a
 *     DM end-to-end over HTTP.
 *
 * When Docker is unavailable the whole block SKIPS so the local suite stays green; CI runs it for real.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { WsServerMessage } from "@civfix/shared"
import { FakeMailer } from "@civfix/shared/fakes"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { buildServer } from "../../src/server.js"
import { buildContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryChatRepository, InMemoryThreadsRepository, MockConnection } from "../helpers/chat.js"
import { roomKeyFor } from "../../src/ws/gateway.js"
import type { ChatGatewayOverrides } from "../../src/routes/chat.routes.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { makeDrizzleChatRepository } from "../../src/services/chat-repository.drizzle.js"
import { makeDrizzleDmRepository } from "../../src/services/dm-repository.drizzle.js"
import { makeDrizzleBlocksRepository } from "../../src/services/blocks-repository.drizzle.js"
import { makeReportChatRepository } from "../../src/services/report-chat-repository.drizzle.js"
import { makeCleanupService } from "../../src/services/cleanup-service.js"
import { makeChatEditService } from "../../src/services/chat-edit-service.js"
import { makeDrizzleDiscussionRepository } from "../../src/services/discussion-repository.drizzle.js"
import { makeChatPollRepository } from "../../src/services/chat-poll-repository.drizzle.js"
import { makeChatGroupRepository } from "../../src/services/chat-group-repository.drizzle.js"
import { makeChatPowersResolver } from "../../src/services/chat-room-roles.js"
import { globalRoleOf } from "../../src/routes/chat-powers-wiring.js"

const pg = await withPg()

describe.skipIf(!pg)("chat message edit (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  /** Insert a user and return its id. */
  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id
    `
    return u!.id
  }

  /**
   * Insert a minimal report and return its id (fixture mirror of report-chat-members-pg).
   *
   * Defaults to 'submitted' — NOT a publicly-visible status. The service-level tests above wire no report
   * lookup at all, so visibility is not part of what they exercise; the HTTP describe at the bottom
   * ("report VISIBILITY gate") passes an explicit status because there the gate is live.
   */
  async function newReport(status = "submitted"): Promise<string> {
    const [r] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, h3_cell)
      VALUES (${randomUUID()}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'dump', ${status}, 'h0')
      RETURNING id
    `
    return r!.id
  }

  /** Create a cleanup whose organizer is `organizerId` (organizer row == chat membership). */
  async function newCleanup(organizerId: string): Promise<string> {
    const created = await makeCleanupService({ repo: makeDrizzleCleanupRepository(h.sql) }).createCleanup(
      {
        title: "Edit sweep",
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

  /** Build the service on the real Drizzle repos, capturing broadcast frames instead of fanning out. */
  function makeService(frames: { roomKey: string; frame: WsServerMessage }[] = []) {
    const chat = makeDrizzleChatRepository(h.sql)
    const dm = makeDrizzleDmRepository(h.sql)
    const blocks = makeDrizzleBlocksRepository(h.sql)
    const cleanups = makeDrizzleCleanupRepository(h.sql)
    const reportChat = makeReportChatRepository(h.sql)
    return makeChatEditService({
      chat,
      dm,
      isCleanupMember: (cleanupId, userId) => cleanups.isMember(cleanupId, userId),
      isReportMember: (reportId, userId) => reportChat.isMember(reportId, userId),
      dmPeerOf: async (threadId, userId) => {
        const t = await dm.getThread(threadId)
        if (t === null) return null
        if (t.userLo === userId) return t.userHi
        if (t.userHi === userId) return t.userLo
        return null
      },
      isBlockedEitherWay: (a, b) => blocks.isBlockedEitherWay(a, b),
      broadcastEvent: async (roomKey, frame) => {
        frames.push({ roomKey, frame })
      },
    })
  }

  it("edits own cleanup text message: body + editedAt persisted, message_update broadcast", async () => {
    const organizerId = await newUser("Edit Org")
    const cleanupId = await newCleanup(organizerId)
    const chat = makeDrizzleChatRepository(h.sql)
    const msg = await chat.insertMessage({ cleanupId, userId: organizerId, body: "first draft" }, randomUUID())

    const frames: { roomKey: string; frame: WsServerMessage }[] = []
    const service = makeService(frames)
    const updated = await service.editMessage({
      roomKind: "cleanup",
      roomId: cleanupId,
      messageId: msg.id,
      userId: organizerId,
      body: "second draft",
    })

    expect(updated.body).toBe("second draft")
    expect(updated.editedAt).toBeTruthy()
    expect(updated.mine).toBe(true)

    // Persisted (not just projected): a fresh read shows the new body + edited_at.
    const reread = await chat.findMessage(cleanupId, msg.id, organizerId)
    expect(reread?.body).toBe("second draft")
    expect(reread?.editedAt).toBeTruthy()

    // The message_update frame went to the cleanup's BARE room key with the refreshed DTO.
    expect(frames).toHaveLength(1)
    expect(frames[0]!.roomKey).toBe(cleanupId)
    expect(frames[0]!.frame).toMatchObject({
      type: "message_update",
      roomKind: "cleanup",
      roomId: cleanupId,
      message: { id: msg.id, body: "second draft" },
    })
  })

  it("edits own report-room message (member) and broadcasts to the report room key", async () => {
    const userId = await newUser("Edit Report Member")
    const reportId = await newReport()
    await makeReportChatRepository(h.sql).join(reportId, userId)
    const chat = makeDrizzleChatRepository(h.sql)
    const msg = await chat.insertMessage(
      { cleanupId: reportId, roomKind: "report", userId, body: "typo hree" },
      randomUUID(),
    )

    const frames: { roomKey: string; frame: WsServerMessage }[] = []
    const updated = await makeService(frames).editMessage({
      roomKind: "report",
      roomId: reportId,
      messageId: msg.id,
      userId,
      body: "typo here",
    })
    expect(updated.body).toBe("typo here")
    expect(updated.editedAt).toBeTruthy()
    expect(frames[0]!.roomKey).toBe(`report:${reportId}`)
    expect(frames[0]!.frame).toMatchObject({ type: "message_update", roomKind: "report", roomId: reportId })
  })

  it("rejects a non-sender with 403 code not_sender", async () => {
    const organizerId = await newUser("Edit Org NotSender")
    const cleanupId = await newCleanup(organizerId)
    const chat = makeDrizzleChatRepository(h.sql)
    const msg = await chat.insertMessage({ cleanupId, userId: organizerId, body: "mine" }, randomUUID())

    const mallory = await newUser("Edit Mallory")
    await makeCleanupService({ repo: makeDrizzleCleanupRepository(h.sql) }).joinCleanup(cleanupId, mallory)

    await expect(
      makeService().editMessage({
        roomKind: "cleanup",
        roomId: cleanupId,
        messageId: msg.id,
        userId: mallory,
        body: "not yours",
      }),
    ).rejects.toMatchObject({ httpStatus: 403, fields: { code: "not_sender" } })
  })

  it("rejects a message older than EDIT_WINDOW_HOURS with 403 code edit_window_expired", async () => {
    const organizerId = await newUser("Edit Org Old")
    const cleanupId = await newCleanup(organizerId)
    const chat = makeDrizzleChatRepository(h.sql)
    const msg = await chat.insertMessage({ cleanupId, userId: organizerId, body: "old" }, randomUUID())
    // Backdate past the 48h window (60h). The DEFAULT partition catches any out-of-range month.
    await h.sql`UPDATE chat_messages SET created_at = ${new Date(Date.now() - 60 * 3_600_000)} WHERE id = ${msg.id}`

    await expect(
      makeService().editMessage({
        roomKind: "cleanup",
        roomId: cleanupId,
        messageId: msg.id,
        userId: organizerId,
        body: "too late",
      }),
    ).rejects.toMatchObject({ httpStatus: 403, fields: { code: "edit_window_expired" } })
  })

  it("rejects editing a soft-deleted message with 409", async () => {
    const organizerId = await newUser("Edit Org Deleted")
    const cleanupId = await newCleanup(organizerId)
    const chat = makeDrizzleChatRepository(h.sql)
    const msg = await chat.insertMessage({ cleanupId, userId: organizerId, body: "gone" }, randomUUID())
    await chat.softDelete(cleanupId, msg.id, organizerId)

    await expect(
      makeService().editMessage({
        roomKind: "cleanup",
        roomId: cleanupId,
        messageId: msg.id,
        userId: organizerId,
        body: "raise the dead",
      }),
    ).rejects.toMatchObject({ httpStatus: 409 })
  })

  it("rejects a sender-less SYSTEM message with 422", async () => {
    const userId = await newUser("Edit System")
    const reportId = await newReport()
    await makeReportChatRepository(h.sql).join(reportId, userId)
    const sys = await makeReportChatRepository(h.sql).insertSystemMessage({
      reportId,
      status: "acknowledged",
      body: "Status changed",
    })

    await expect(
      makeService().editMessage({
        roomKind: "report",
        roomId: reportId,
        messageId: sys.id,
        userId,
        body: "rewrite history",
      }),
    ).rejects.toMatchObject({ httpStatus: 422 })
  })

  it("rejects a non-text kind (share_pin) the user DID send with 422", async () => {
    const organizerId = await newUser("Edit Org Pin")
    const cleanupId = await newCleanup(organizerId)
    const chat = makeDrizzleChatRepository(h.sql)
    const msg = await chat.insertMessage(
      { cleanupId, userId: organizerId, body: "pin", kind: "share_pin" },
      randomUUID(),
    )

    await expect(
      makeService().editMessage({
        roomKind: "cleanup",
        roomId: cleanupId,
        messageId: msg.id,
        userId: organizerId,
        body: "still a pin",
      }),
    ).rejects.toMatchObject({ httpStatus: 422 })
  })

  it("404s when the message exists but the room ref does not match roomId", async () => {
    const organizerId = await newUser("Edit Org XRoom")
    const cleanupA = await newCleanup(organizerId)
    const cleanupB = await newCleanup(organizerId)
    const chat = makeDrizzleChatRepository(h.sql)
    const msg = await chat.insertMessage({ cleanupId: cleanupA, userId: organizerId, body: "in A" }, randomUUID())

    await expect(
      makeService().editMessage({
        roomKind: "cleanup",
        roomId: cleanupB,
        messageId: msg.id,
        userId: organizerId,
        body: "steal into B",
      }),
    ).rejects.toMatchObject({ httpStatus: 404 })

    // And an unknown message id is a plain 404 too.
    await expect(
      makeService().editMessage({
        roomKind: "cleanup",
        roomId: cleanupA,
        messageId: randomUUID(),
        userId: organizerId,
        body: "ghost",
      }),
    ).rejects.toMatchObject({ httpStatus: 404 })
  })

  it("403s when room-send permission is no longer held (membership revoked)", async () => {
    const organizerId = await newUser("Edit Org Left")
    const cleanupId = await newCleanup(organizerId)
    const chat = makeDrizzleChatRepository(h.sql)
    const msg = await chat.insertMessage({ cleanupId, userId: organizerId, body: "was member" }, randomUUID())
    // Revoke the membership out from under the sender (same check the WS send path uses).
    await h.sql`DELETE FROM cleanup_members WHERE cleanup_id = ${cleanupId} AND user_id = ${organizerId}`

    await expect(
      makeService().editMessage({
        roomKind: "cleanup",
        roomId: cleanupId,
        messageId: msg.id,
        userId: organizerId,
        body: "still here?",
      }),
    ).rejects.toMatchObject({ httpStatus: 403 })
  })

  it("PATCH /dm/:threadId/messages/:messageId (old route) still edits a DM end-to-end", async () => {
    // Real Drizzle dm/blocks repos injected via chatOverrides (the established no-redis harness), with
    // sessions minted directly for pg-created user ids so the FK from dm_messages.sender_id resolves.
    const env = loadEnv({ NODE_ENV: "test" })
    const stores = makeInMemoryStores()
    const cache = new InMemoryCacheClient(() => Date.now())
    const authServices = buildAuthServices({
      stores,
      cache,
      mailer: new FakeMailer(),
      oauthConfig: {},
      verifier: new StubJwksVerifier(),
      now: () => Date.now(),
    })
    const overrides: ChatGatewayOverrides = {
      isMember: () => Promise.resolve(true),
      threadsRepo: new InMemoryThreadsRepository(),
      dmRepo: makeDrizzleDmRepository(h.sql),
      chatRepo: new InMemoryChatRepository(),
      blocksRepo: makeDrizzleBlocksRepository(h.sql),
    }
    const app: FastifyInstance = await buildServer({ env, authServices, chatOverrides: overrides })

    try {
      const aliceId = await newUser("DM Edit Alice")
      const bobId = await newUser("DM Edit Bob")
      const aliceToken = await authServices.sessions.createSession(aliceId, [])

      const dm = makeDrizzleDmRepository(h.sql)
      const thread = await dm.openOrCreateThread(aliceId, bobId)
      const msg = await dm.persist({ threadId: thread.id, senderId: aliceId, body: "hi bob" })

      const res = await app.inject({
        method: "PATCH",
        url: `/v1/dm/${thread.id}/messages/${msg.id}`,
        headers: { authorization: `Bearer ${aliceToken}`, "x-client": "mobile" },
        payload: { body: "hi bob (edited)" },
      })
      expect(res.statusCode).toBe(200)
      const dto = res.json()
      expect(dto.body).toBe("hi bob (edited)")
      expect(dto.editedAt).toBeTruthy()

      // Persisted: a fresh read shows the edit.
      const reread = await dm.findMessage(thread.id, msg.id, aliceId)
      expect(reread?.body).toBe("hi bob (edited)")
      expect(reread?.editedAt).toBeTruthy()

      // Bob (non-sender) cannot edit Alice's message via the route: 403.
      const bobToken = await authServices.sessions.createSession(bobId, [])
      const forbidden = await app.inject({
        method: "PATCH",
        url: `/v1/dm/${thread.id}/messages/${msg.id}`,
        headers: { authorization: `Bearer ${bobToken}`, "x-client": "mobile" },
        payload: { body: "bob was here" },
      })
      expect(forbidden.statusCode).toBe(403)
    } finally {
      await app.close()
    }
  })

  describe("PATCH /messages route + delete broadcasts (HTTP, P0 Task 0.3)", () => {
    // One app over real Drizzle repos (chatOverrides) + the container's FakeChatService, whose
    // joinRoom/broadcastEvent let a MockConnection stand in for a second connected WS client.
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
      }
      container = buildContainer(env)
      app = await buildServer({ env, container, authServices, chatOverrides: overrides })
    })

    afterAll(async () => {
      await app.close()
    })

    /** Let the fire-and-forget broadcast microtasks flush. */
    const flush = () => new Promise((resolve) => setImmediate(resolve))

    it("PATCH /messages edits a report-room message: 200 DTO + message_update to a second WS client", async () => {
      const userId = await newUser("Route Edit Report")
      const watcherId = await newUser("Route Edit Watcher")
      const reportId = await newReport()
      const reportChat = makeReportChatRepository(h.sql)
      await reportChat.join(reportId, userId)
      await reportChat.join(reportId, watcherId)
      const chat = makeDrizzleChatRepository(h.sql)
      const msg = await chat.insertMessage(
        { cleanupId: reportId, roomKind: "report", userId, body: "tpyo" },
        randomUUID(),
      )

      // A second connected client in the report room (FakeChatService joinRoom keys by room key).
      const watcher = new MockConnection("watcher")
      await container.chatService.joinRoom(roomKeyFor("report", reportId), watcher, watcherId)

      const token = await authServices.sessions.createSession(userId, [])
      const res = await app.inject({
        method: "PATCH",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
        payload: { roomKind: "report", roomId: reportId, messageId: msg.id, body: "typo" },
      })
      expect(res.statusCode).toBe(200)
      const dto = res.json()
      expect(dto.body).toBe("typo")
      expect(dto.editedAt).toBeTruthy()

      await flush()
      const updates = watcher.framesOfType("message_update")
      expect(updates).toHaveLength(1)
      expect(updates[0]).toMatchObject({
        type: "message_update",
        roomKind: "report",
        roomId: reportId,
        message: { id: msg.id, body: "typo" },
      })
    })

    it("PATCH /messages with roomKind dm edits a DM (same behavior as the old route)", async () => {
      const aliceId = await newUser("Route Edit DM Alice")
      const bobId = await newUser("Route Edit DM Bob")
      const dm = makeDrizzleDmRepository(h.sql)
      const thread = await dm.openOrCreateThread(aliceId, bobId)
      const msg = await dm.persist({ threadId: thread.id, senderId: aliceId, body: "hey bob" })

      const token = await authServices.sessions.createSession(aliceId, [])
      const res = await app.inject({
        method: "PATCH",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
        payload: { roomKind: "dm", roomId: thread.id, messageId: msg.id, body: "hey bob (edited)" },
      })
      expect(res.statusCode).toBe(200)
      const dto = res.json()
      expect(dto.body).toBe("hey bob (edited)")
      expect(dto.editedAt).toBeTruthy()

      // Persisted, not just projected.
      const reread = await dm.findMessage(thread.id, msg.id, aliceId)
      expect(reread?.body).toBe("hey bob (edited)")
      expect(reread?.editedAt).toBeTruthy()

      // Non-sender still 403s through the unified route.
      const bobToken = await authServices.sessions.createSession(bobId, [])
      const forbidden = await app.inject({
        method: "PATCH",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${bobToken}`, "x-client": "mobile" },
        payload: { roomKind: "dm", roomId: thread.id, messageId: msg.id, body: "bob was here" },
      })
      expect(forbidden.statusCode).toBe(403)
    })

    it("DELETE cleanup message broadcasts a message_update whose message has deletedAt set", async () => {
      const organizerId = await newUser("Route Del Org")
      const cleanupId = await newCleanup(organizerId)
      const chat = makeDrizzleChatRepository(h.sql)
      const msg = await chat.insertMessage({ cleanupId, userId: organizerId, body: "delete me" }, randomUUID())

      // Cleanup rooms use the BARE cleanupId as their room key.
      const watcher = new MockConnection("del-watcher")
      await container.chatService.joinRoom(roomKeyFor("cleanup", cleanupId), watcher, organizerId)

      const token = await authServices.sessions.createSession(organizerId, [])
      const res = await app.inject({
        method: "DELETE",
        url: `/v1/cleanups/${cleanupId}/messages/${msg.id}`,
        headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().deletedAt).toBeTruthy()

      await flush()
      const updates = watcher.framesOfType("message_update")
      expect(updates).toHaveLength(1)
      expect(updates[0]).toMatchObject({
        type: "message_update",
        roomKind: "cleanup",
        roomId: cleanupId,
        message: { id: msg.id },
      })
      expect((updates[0]!.message as { deletedAt: string | null }).deletedAt).toBeTruthy()
    })

    it("rate limits PATCH /messages at 30/min: a 429 lands within 40 edits", async () => {
      const organizerId = await newUser("Route Edit Limit")
      const cleanupId = await newCleanup(organizerId)
      const chat = makeDrizzleChatRepository(h.sql)
      const msg = await chat.insertMessage({ cleanupId, userId: organizerId, body: "v0" }, randomUUID())
      const token = await authServices.sessions.createSession(organizerId, [])

      // Same pattern as the anon-routes 30/min test: earlier tests in this app already consumed a few
      // slots on this route+key, so assert only that a 429 arrives before 40 attempts (limit is 30/min).
      let saw429 = false
      for (let i = 1; i <= 40 && !saw429; i++) {
        const res = await app.inject({
          method: "PATCH",
          url: "/v1/messages",
          headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
          payload: { roomKind: "cleanup", roomId: cleanupId, messageId: msg.id, body: `v${i}` },
        })
        if (res.statusCode === 429) saw429 = true
        else expect(res.statusCode).toBe(200)
      }
      expect(saw429).toBe(true)
    })
  })

  /**
   * The report-VISIBILITY gate on the unified /messages surfaces, over an app that wires
   * `discussionOverrides` — i.e. the PRODUCTION shape.
   *
   * The describe above (and chat-polls-pg) deliberately wires chatOverrides with NO report lookup, which
   * makes messages.routes' `isReportVisible` short-circuit to `true`; that is why those tests can drive
   * report rooms whose report sits at 'submitted'. Production always builds the lookup, so a
   * report_chat_members row — which OUTLIVES the report being held, unlisted or removed — must stop
   * granting edit / react / pin / poll rights. All four routes answer 404 (never 403): an invisible report
   * must not be distinguishable from a missing one, matching report-chat.routes' requireVisibleReport.
   */
  describe("report VISIBILITY gate on the unified routes (discussionOverrides wired)", () => {
    let app: FastifyInstance
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
      const dm = makeDrizzleDmRepository(h.sql)
      const reportChat = makeReportChatRepository(h.sql)
      const groups = makeChatGroupRepository(h.sql)
      const overrides: ChatGatewayOverrides = {
        isMember: (cleanupId, userId) => cleanups.isMember(cleanupId, userId),
        threadsRepo: new InMemoryThreadsRepository(),
        dmRepo: dm,
        chatRepo: makeDrizzleChatRepository(h.sql),
        blocksRepo: makeDrizzleBlocksRepository(h.sql),
        reportChat,
        groups,
        chatPolls: makeChatPollRepository(h.sql),
        // The REAL powers resolver (the offline branch fails report/global roles closed, which would 403
        // the PUBLISHED control's pin before the visibility gate could be shown to be the difference).
        chatPowers: makeChatPowersResolver({
          isDmParticipant: (threadId, userId) => dm.isParticipant(threadId, userId),
          cleanupRoleOf: (cleanupId, userId) => cleanups.roleOf(cleanupId, userId),
          reportChatRoleOf: (reportId, userId) => reportChat.roleOf(reportId, userId),
          globalRoleOf: (userId) => globalRoleOf(h.sql, userId),
          groupRoleOf: (groupId, userId) => groups.roleOf(groupId, userId),
        }),
      }
      app = await buildServer({
        env,
        container: buildContainer(env),
        authServices,
        chatOverrides: overrides,
        // THE difference from the harness above: the real report lookup behind isReportVisible.
        discussionOverrides: { repo: makeDrizzleDiscussionRepository(h.sql) },
      })
    })

    afterAll(async () => {
      await app.close()
    })

    /** A report at `status` whose chat has `ownerId` joined as OWNER, plus one message they authored. */
    async function seedRoom(
      status: string,
      name: string,
    ): Promise<{ reportId: string; ownerId: string; messageId: string; tok: string }> {
      const ownerId = await newUser(name)
      const reportId = await newReport(status)
      await makeReportChatRepository(h.sql).join(reportId, ownerId, "owner")
      const msg = await makeDrizzleChatRepository(h.sql).insertMessage(
        { cleanupId: reportId, roomKind: "report", userId: ownerId, body: "civic note" },
        randomUUID(),
      )
      return {
        reportId,
        ownerId,
        messageId: msg.id,
        tok: await authServices.sessions.createSession(ownerId, []),
      }
    }

    function call(
      tok: string,
      method: "PATCH" | "POST" | "PUT",
      url: string,
      payload: Record<string, unknown>,
    ) {
      return app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${tok}`, "x-client": "mobile" },
        payload,
      })
    }

    /** The four unified surfaces, as (name, response) pairs for one seeded room. */
    async function hitAll(room: {
      reportId: string
      messageId: string
      tok: string
    }): Promise<Array<[string, Awaited<ReturnType<typeof call>>]>> {
      const ref = { roomKind: "report", roomId: room.reportId, messageId: room.messageId }
      return [
        ["PATCH /messages", await call(room.tok, "PATCH", "/v1/messages", { ...ref, body: "edited" })],
        [
          "POST /messages/reactions",
          await call(room.tok, "POST", "/v1/messages/reactions", { ...ref, emoji: "like" }),
        ],
        [
          "PUT /messages/pin",
          await call(room.tok, "PUT", "/v1/messages/pin", { ...ref, pinned: true }),
        ],
        [
          "POST /messages/poll",
          await call(room.tok, "POST", "/v1/messages/poll", {
            roomKind: "report",
            roomId: room.reportId,
            question: "Best day?",
            options: ["Sat", "Sun"],
          }),
        ],
      ]
    }

    it("a HELD report 404s all four unified surfaces for the room's own OWNER", async () => {
      const room = await seedRoom("held", "Held Report Owner")

      for (const [label, res] of await hitAll(room)) {
        expect(res.statusCode, `${label} on a held report`).toBe(404)
      }

      // Nothing was written: the message is untouched and no poll row exists for the room.
      const reread = await makeDrizzleChatRepository(h.sql).findReportMessage(
        room.reportId,
        room.messageId,
        room.ownerId,
      )
      expect(reread?.body).toBe("civic note")
      expect(reread?.editedAt ?? null).toBeNull()
      expect(reread?.pinnedAt ?? null).toBeNull()
      expect(reread?.reactions).toEqual([])
      // chat_polls is keyed on the message id, so count the poll MESSAGES in this room instead.
      const polls = await h.sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM chat_messages
        WHERE report_id = ${room.reportId} AND kind = 'poll'
      `
      expect(polls[0]!.count).toBe(0)
    })

    it("a 'submitted' report 404s them too (pre-publication is not publicly visible)", async () => {
      const room = await seedRoom("submitted", "Submitted Report Owner")

      for (const [label, res] of await hitAll(room)) {
        expect(res.statusCode, `${label} on a submitted report`).toBe(404)
      }
    })

    it("a PUBLISHED report allows all four — so the 404s above are the gate, not the harness", async () => {
      const room = await seedRoom("published", "Published Report Owner")

      for (const [label, res] of await hitAll(room)) {
        expect(res.statusCode, `${label} on a published report`).toBe(200)
      }

      const reread = await makeDrizzleChatRepository(h.sql).findReportMessage(
        room.reportId,
        room.messageId,
        room.ownerId,
      )
      expect(reread?.body).toBe("edited")
      expect(reread?.pinnedAt).toBeTruthy()
      expect(reread?.reactions).toEqual([{ emoji: "like", count: 1, mine: true }])
    })

    it("a RESOLVED report still allows them (the widened public-status set, not 'published' only)", async () => {
      const room = await seedRoom("resolved", "Resolved Report Owner")

      const res = await call(room.tok, "PATCH", "/v1/messages", {
        roomKind: "report",
        roomId: room.reportId,
        messageId: room.messageId,
        body: "still editable after the fix landed",
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().body).toBe("still editable after the fix landed")
    })

    it("a report the owner can see but is NOT a chat member of still 403s (visibility is not membership)", async () => {
      const reportId = await newReport("published")
      const posterId = await newUser("Vis Poster")
      await makeReportChatRepository(h.sql).join(reportId, posterId, "owner")
      const msg = await makeDrizzleChatRepository(h.sql).insertMessage(
        { cleanupId: reportId, roomKind: "report", userId: posterId, body: "members only" },
        randomUUID(),
      )
      const strangerId = await newUser("Vis Stranger")
      const tok = await authServices.sessions.createSession(strangerId, [])

      // Visible report, no membership row: the gate ladder falls through to the membership/powers 403 —
      // the visibility check must not be doing double duty as the authorization check.
      const edit = await call(tok, "PATCH", "/v1/messages", {
        roomKind: "report",
        roomId: reportId,
        messageId: msg.id,
        body: "not mine",
      })
      expect(edit.statusCode).toBe(403)
      const react = await call(tok, "POST", "/v1/messages/reactions", {
        roomKind: "report",
        roomId: reportId,
        messageId: msg.id,
        emoji: "like",
      })
      expect(react.statusCode).toBe(403)
      const pinned = await call(tok, "PUT", "/v1/messages/pin", {
        roomKind: "report",
        roomId: reportId,
        messageId: msg.id,
        pinned: true,
      })
      expect(pinned.statusCode).toBe(403)
      expect(pinned.json().fields).toMatchObject({ code: "pin_forbidden" })
    })
  })
})
