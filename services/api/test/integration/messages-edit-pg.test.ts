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
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryChatRepository, InMemoryThreadsRepository } from "../helpers/chat.js"
import type { ChatGatewayOverrides } from "../../src/routes/chat.routes.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { makeDrizzleChatRepository } from "../../src/services/chat-repository.drizzle.js"
import { makeDrizzleDmRepository } from "../../src/services/dm-repository.drizzle.js"
import { makeDrizzleBlocksRepository } from "../../src/services/blocks-repository.drizzle.js"
import { makeReportChatRepository } from "../../src/services/report-chat-repository.drizzle.js"
import { makeCleanupService } from "../../src/services/cleanup-service.js"
import { makeChatEditService } from "../../src/services/chat-edit-service.js"

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

  /** Insert a minimal report and return its id (fixture mirror of report-chat-members-pg). */
  async function newReport(): Promise<string> {
    const [r] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, h3_cell)
      VALUES (${randomUUID()}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'dump', 'submitted', 'h0')
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
})
