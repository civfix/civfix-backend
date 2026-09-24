/**
 * P3 Tasks 3.4 + 3.5 integration test (Docker-gated): message PINNING + the moderator delete-others
 * override, against a live PostGIS container (via withPg) over HTTP.
 *
 *   PUT /messages/pin — the chat-powers matrix end-to-end: cleanup organizer pins (member 403
 *   pin_forbidden), report owner pins (member 403), a global OPERATOR pins in a report room WITHOUT a
 *   membership row, a dm participant pins; unpin clears pinnedAt; system/deleted targets 422; a repeat
 *   pin is IDEMPOTENT (same pinnedAt, no refresh); every successful flip broadcasts a
 *   {type:"message_update"} frame carrying the new pin state to a second connected client.
 *
 *   History pins — the INITIAL page (no before/around) of all three history routes carries `pins`
 *   (newest-pin first, capped at PIN_LIST_CAP); before-paged and around-paged responses omit the key.
 *
 *   Delete override — a cleanup ORGANIZER deletes a member's message (tombstone broadcast); a member
 *   deleting someone else's stays 403; an OPERATOR deletes in a report room without membership; a
 *   report OWNER deleting someone else's stays 403 (owners curate pins, never erase speech); a dm peer
 *   deleting the other's message stays 403 (unchanged).
 *
 * Repos ride chatOverrides on the real Drizzle impls over the harness pool (the established no-redis
 * pattern), and chatOverrides.chatPowers injects the REAL resolver wired to the REAL roleOf lookups
 * (cleanup_members / report_chat_members / users.role) — so the powers matrix is exercised against pg.
 * When Docker is unavailable the whole block SKIPS so the local suite stays green; CI runs it for real.
 */

import { TEST_TICKET_SIGNER } from "../helpers/ticket-signer.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { buildServer } from "../../src/server.js"
import { buildContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryThreadsRepository, MockConnection } from "../helpers/chat.js"
import { roomKeyFor } from "../../src/ws/gateway.js"
import type { ChatGatewayOverrides } from "../../src/routes/chat.routes.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import {
  makeDrizzleChatRepository,
  PIN_LIST_CAP,
} from "../../src/services/chat-repository.drizzle.js"
import { makeDrizzleDmRepository } from "../../src/services/dm-repository.drizzle.js"
import { makeDrizzleBlocksRepository } from "../../src/services/blocks-repository.drizzle.js"
import { makeReportChatRepository } from "../../src/services/report-chat-repository.drizzle.js"
import { makeDrizzleDiscussionRepository } from "../../src/services/discussion-repository.drizzle.js"
import { makeCleanupService } from "../../src/services/cleanup-service.js"
import { makeChatPowersResolver } from "../../src/services/chat-room-roles.js"
import { makeChatGroupRepository } from "../../src/services/chat-group-repository.drizzle.js"
import { globalRoleOf } from "../../src/routes/chat-powers-wiring.js"

const pg = await withPg()

describe.skipIf(!pg)("chat pins + moderator delete (integration)", () => {
  let h: PgHarness
  let app: FastifyInstance
  let container: Container
  let authServices: AuthServices

  beforeAll(async () => {
    h = pg as PgHarness

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
    const reportChat = makeReportChatRepository(h.sql)
    const dm = makeDrizzleDmRepository(h.sql)
    const overrides: ChatGatewayOverrides = {
      isMember: (cleanupId, userId) => cleanups.isMember(cleanupId, userId),
      threadsRepo: new InMemoryThreadsRepository(),
      dmRepo: dm,
      chatRepo: makeDrizzleChatRepository(h.sql),
      blocksRepo: makeDrizzleBlocksRepository(h.sql),
      reportChat,
      // The REAL resolver over the REAL pg-backed lookups (incl. the new roleOf queries) — the same
      // wiring shape wireChatPowers builds in production, pointed at the harness pool.
      chatPowers: makeChatPowersResolver({
        isDmParticipant: (threadId, userId) => dm.isParticipant(threadId, userId),
        cleanupRoleOf: (cleanupId, userId) => cleanups.roleOf(cleanupId, userId),
        reportChatRoleOf: (reportId, userId) => reportChat.roleOf(reportId, userId),
        globalRoleOf: (userId) => globalRoleOf(h.sql, userId),
        // P4 group lane, wired to the real repo for parity (this file exercises no group rooms).
        groupRoleOf: (groupId, userId) => makeChatGroupRepository(h.sql).roleOf(groupId, userId),
      }),
    }
    container = buildContainer(env)
    app = await buildServer({
      env,
      container,
      authServices,
      chatOverrides: overrides,
      // The member-gate + report-visibility lookups of the history/delete routes, over the same pool.
      cleanupOverrides: { repo: cleanups },
      discussionOverrides: { repo: makeDrizzleDiscussionRepository(h.sql) },
    })
  })

  afterAll(async () => {
    await app.close()
    await h.teardown()
  })

  /** Let the fire-and-forget broadcast microtasks flush. */
  const flush = () => new Promise((resolve) => setImmediate(resolve))

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id
    `
    return u!.id
  }

  /**
   * Insert a minimal report and return its id (fixture mirror of messages-edit-pg, but PUBLISHED:
   * the report history/delete HTTP routes gate on isReportVisibleTo, which requires status
   * 'published' + visibility 'public' for a non-reporter viewer).
   */
  async function newReport(): Promise<string> {
    const [r] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, h3_cell)
      VALUES (${randomUUID()}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'dump', 'published', 'h0')
      RETURNING id
    `
    return r!.id
  }

  /** Create a cleanup whose organizer is `organizerId` (organizer row == chat membership). */
  async function newCleanup(organizerId: string): Promise<string> {
    const created = await makeCleanupService({
      tickets: TEST_TICKET_SIGNER,
      repo: makeDrizzleCleanupRepository(h.sql),
    }).createCleanup(
      {
        title: "Pin sweep",
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

  const chat = () => makeDrizzleChatRepository(h.sql)
  const dmRepo = () => makeDrizzleDmRepository(h.sql)

  const token = (userId: string) => authServices.sessions.createSession(userId, [])

  function pin(
    tok: string,
    body: { roomKind: string; roomId: string; messageId: string; pinned: boolean },
  ) {
    return app.inject({
      method: "PUT",
      url: "/v1/messages/pin",
      headers: { authorization: `Bearer ${tok}`, "x-client": "mobile" },
      payload: body,
    })
  }

  describe("PUT /messages/pin", () => {
    it("organizer pins a cleanup message: 200 + pinnedAt + message_update to a second client", async () => {
      const organizerId = await newUser("Pin Org")
      const memberId = await newUser("Pin Member")
      const cleanupId = await newCleanup(organizerId)
      await makeCleanupService({
        tickets: TEST_TICKET_SIGNER,
        repo: makeDrizzleCleanupRepository(h.sql),
      }).joinCleanup(cleanupId, memberId)
      const msg = await chat().insertMessage(
        { cleanupId, userId: memberId, body: "pin me" },
        randomUUID(),
      )

      const watcher = new MockConnection("pin-watcher")
      await container.chatService.joinRoom(roomKeyFor("cleanup", cleanupId), watcher, memberId)

      const res = await pin(await token(organizerId), {
        roomKind: "cleanup",
        roomId: cleanupId,
        messageId: msg.id,
        pinned: true,
      })
      expect(res.statusCode).toBe(200)
      const dto = res.json()
      expect(dto.id).toBe(msg.id)
      expect(dto.pinnedAt).toBeTruthy()

      await flush()
      const updates = watcher.framesOfType("message_update")
      expect(updates).toHaveLength(1)
      expect(updates[0]).toMatchObject({
        type: "message_update",
        roomKind: "cleanup",
        roomId: cleanupId,
        message: { id: msg.id },
      })
      expect((updates[0]!.message as { pinnedAt?: string }).pinnedAt).toBeTruthy()
    })

    it("a plain cleanup MEMBER gets 403 pin_forbidden", async () => {
      const organizerId = await newUser("Pin Org Deny")
      const memberId = await newUser("Pin Member Deny")
      const cleanupId = await newCleanup(organizerId)
      await makeCleanupService({
        tickets: TEST_TICKET_SIGNER,
        repo: makeDrizzleCleanupRepository(h.sql),
      }).joinCleanup(cleanupId, memberId)
      const msg = await chat().insertMessage(
        { cleanupId, userId: organizerId, body: "no pin for you" },
        randomUUID(),
      )

      const res = await pin(await token(memberId), {
        roomKind: "cleanup",
        roomId: cleanupId,
        messageId: msg.id,
        pinned: true,
      })
      expect(res.statusCode).toBe(403)
      expect(res.json().fields).toMatchObject({ code: "pin_forbidden" })
    })

    it("report OWNER pins (200); a report MEMBER gets 403 pin_forbidden", async () => {
      const ownerId = await newUser("Pin Report Owner")
      const memberId = await newUser("Pin Report Member")
      const reportId = await newReport()
      const reportChat = makeReportChatRepository(h.sql)
      await reportChat.join(reportId, ownerId, "owner")
      await reportChat.join(reportId, memberId)
      const msg = await chat().insertMessage(
        { cleanupId: reportId, roomKind: "report", userId: memberId, body: "civic note" },
        randomUUID(),
      )

      const denied = await pin(await token(memberId), {
        roomKind: "report",
        roomId: reportId,
        messageId: msg.id,
        pinned: true,
      })
      expect(denied.statusCode).toBe(403)
      expect(denied.json().fields).toMatchObject({ code: "pin_forbidden" })

      const ok = await pin(await token(ownerId), {
        roomKind: "report",
        roomId: reportId,
        messageId: msg.id,
        pinned: true,
      })
      expect(ok.statusCode).toBe(200)
      expect(ok.json().pinnedAt).toBeTruthy()
    })

    it("a global OPERATOR pins in a report room WITHOUT a membership row", async () => {
      const posterId = await newUser("Pin Poster")
      const operatorId = await newUser("Pin Operator")
      await h.sql`UPDATE users SET role = 'operator' WHERE id = ${operatorId}`
      const reportId = await newReport()
      await makeReportChatRepository(h.sql).join(reportId, posterId)
      const msg = await chat().insertMessage(
        { cleanupId: reportId, roomKind: "report", userId: posterId, body: "operator target" },
        randomUUID(),
      )

      const res = await pin(await token(operatorId), {
        roomKind: "report",
        roomId: reportId,
        messageId: msg.id,
        pinned: true,
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().pinnedAt).toBeTruthy()
    })

    it("a dm participant pins; unpin clears pinnedAt and broadcasts the cleared DTO", async () => {
      const aliceId = await newUser("Pin DM Alice")
      const bobId = await newUser("Pin DM Bob")
      const thread = await dmRepo().openOrCreateThread(aliceId, bobId)
      const msg = await dmRepo().persist({
        threadId: thread.id,
        senderId: bobId,
        body: "keep this",
      })

      const aliceToken = await token(aliceId)
      const pinned = await pin(aliceToken, {
        roomKind: "dm",
        roomId: thread.id,
        messageId: msg.id,
        pinned: true,
      })
      expect(pinned.statusCode).toBe(200)
      expect(pinned.json().pinnedAt).toBeTruthy()

      const watcher = new MockConnection("dm-unpin-watcher")
      await container.chatService.joinRoom(roomKeyFor("dm", thread.id), watcher, bobId)

      const unpinned = await pin(aliceToken, {
        roomKind: "dm",
        roomId: thread.id,
        messageId: msg.id,
        pinned: false,
      })
      expect(unpinned.statusCode).toBe(200)
      expect(unpinned.json().pinnedAt ?? null).toBeNull()

      await flush()
      const updates = watcher.framesOfType("message_update")
      expect(updates).toHaveLength(1)
      expect((updates[0]!.message as { pinnedAt?: string }).pinnedAt ?? null).toBeNull()
    })

    it("pinning is IDEMPOTENT: a second pin returns the SAME pinnedAt (no refresh)", async () => {
      const organizerId = await newUser("Pin Idem Org")
      const cleanupId = await newCleanup(organizerId)
      const msg = await chat().insertMessage(
        { cleanupId, userId: organizerId, body: "once" },
        randomUUID(),
      )

      const tok = await token(organizerId)
      const first = await pin(tok, {
        roomKind: "cleanup",
        roomId: cleanupId,
        messageId: msg.id,
        pinned: true,
      })
      expect(first.statusCode).toBe(200)
      const firstAt = first.json().pinnedAt
      expect(firstAt).toBeTruthy()

      // A repeat pin is a no-op: 200 with the ORIGINAL stamp, not a refreshed one.
      const second = await pin(tok, {
        roomKind: "cleanup",
        roomId: cleanupId,
        messageId: msg.id,
        pinned: true,
      })
      expect(second.statusCode).toBe(200)
      expect(second.json().pinnedAt).toBe(firstAt)
    })

    it("422s a SYSTEM message and a soft-deleted message", async () => {
      const ownerId = await newUser("Pin System Owner")
      const reportId = await newReport()
      const reportChat = makeReportChatRepository(h.sql)
      await reportChat.join(reportId, ownerId, "owner")
      const sys = await reportChat.insertSystemMessage({
        reportId,
        status: "acknowledged",
        body: "Status changed",
      })
      const tok = await token(ownerId)
      const sysRes = await pin(tok, {
        roomKind: "report",
        roomId: reportId,
        messageId: sys.id,
        pinned: true,
      })
      expect(sysRes.statusCode).toBe(422)

      const msg = await chat().insertMessage(
        { cleanupId: reportId, roomKind: "report", userId: ownerId, body: "soon gone" },
        randomUUID(),
      )
      await chat().softDeleteReport(reportId, msg.id, ownerId)
      const delRes = await pin(tok, {
        roomKind: "report",
        roomId: reportId,
        messageId: msg.id,
        pinned: true,
      })
      expect(delRes.statusCode).toBe(422)
    })
  })

  describe("pins in history (initial page only)", () => {
    it("cleanup history: initial page carries pins newest-pin first; before/around pages omit the key", async () => {
      const organizerId = await newUser("Hist Org")
      const cleanupId = await newCleanup(organizerId)
      const repo = chat()
      const m1 = await repo.insertMessage(
        { cleanupId, userId: organizerId, body: "one" },
        randomUUID(),
      )
      const m2 = await repo.insertMessage(
        { cleanupId, userId: organizerId, body: "two" },
        randomUUID(),
      )
      const m3 = await repo.insertMessage(
        { cleanupId, userId: organizerId, body: "three" },
        randomUUID(),
      )
      await repo.setPinned(cleanupId, m1.id, organizerId, true)
      await repo.setPinned(cleanupId, m2.id, organizerId, true)

      const tok = await token(organizerId)
      const initial = await app.inject({
        method: "GET",
        url: `/v1/cleanups/${cleanupId}/messages`,
        headers: { authorization: `Bearer ${tok}`, "x-client": "mobile" },
      })
      expect(initial.statusCode).toBe(200)
      const pins = initial.json().pins as Array<{ id: string; pinnedAt?: string }>
      expect(pins.map((p) => p.id)).toEqual([m2.id, m1.id])
      expect(pins.every((p) => Boolean(p.pinnedAt))).toBe(true)

      const before = await app.inject({
        method: "GET",
        url: `/v1/cleanups/${cleanupId}/messages?before=${m3.id}`,
        headers: { authorization: `Bearer ${tok}`, "x-client": "mobile" },
      })
      expect(before.statusCode).toBe(200)
      expect(before.json()).not.toHaveProperty("pins")

      // Around-mode: the cleanup around-page reads through the container chatService (FakeChatService
      // under the test env), which has no such message — the pins key must be absent regardless, and
      // that is what this asserts (the fake 404s the unknown target).
      const around = await app.inject({
        method: "GET",
        url: `/v1/cleanups/${cleanupId}/messages?around=${m2.id}`,
        headers: { authorization: `Bearer ${tok}`, "x-client": "mobile" },
      })
      expect(around.json()).not.toHaveProperty("pins")
    })

    it("report history: initial page carries pins (cap respected); before-paged omits them", async () => {
      const ownerId = await newUser("Hist Report Owner")
      const reportId = await newReport()
      await makeReportChatRepository(h.sql).join(reportId, ownerId, "owner")
      const repo = chat()
      const ids: string[] = []
      for (let i = 0; i < PIN_LIST_CAP + 1; i++) {
        const m = await repo.insertMessage(
          { cleanupId: reportId, roomKind: "report", userId: ownerId, body: `pin ${i}` },
          randomUUID(),
        )
        await repo.setReportPinned(reportId, m.id, ownerId, true)
        ids.push(m.id)
      }

      const tok = await token(ownerId)
      const initial = await app.inject({
        method: "GET",
        url: `/v1/reports/${reportId}/messages`,
        headers: { authorization: `Bearer ${tok}`, "x-client": "mobile" },
      })
      expect(initial.statusCode).toBe(200)
      const body = initial.json()
      const pins = body.pins as Array<{ id: string }>
      // Cap respected, newest-pin first: the FIRST-pinned message (ids[0]) fell off the capped list.
      expect(pins).toHaveLength(PIN_LIST_CAP)
      expect(pins[0]!.id).toBe(ids[ids.length - 1]!)
      expect(pins.some((p) => p.id === ids[0])).toBe(false)

      const before = await app.inject({
        method: "GET",
        url: `/v1/reports/${reportId}/messages?before=${ids[ids.length - 1]}`,
        headers: { authorization: `Bearer ${tok}`, "x-client": "mobile" },
      })
      expect(before.statusCode).toBe(200)
      expect(before.json()).not.toHaveProperty("pins")
    })

    it("dm history: initial page carries pins; around-paged omits them", async () => {
      const aliceId = await newUser("Hist DM Alice")
      const bobId = await newUser("Hist DM Bob")
      const thread = await dmRepo().openOrCreateThread(aliceId, bobId)
      const m1 = await dmRepo().persist({ threadId: thread.id, senderId: aliceId, body: "dm one" })
      const m2 = await dmRepo().persist({ threadId: thread.id, senderId: bobId, body: "dm two" })
      await dmRepo().setPinned(thread.id, m2.id, aliceId, true)

      const tok = await token(aliceId)
      const initial = await app.inject({
        method: "GET",
        url: `/v1/dm/${thread.id}/messages`,
        headers: { authorization: `Bearer ${tok}`, "x-client": "mobile" },
      })
      expect(initial.statusCode).toBe(200)
      const pins = initial.json().pins as Array<{ id: string }>
      expect(pins.map((p) => p.id)).toEqual([m2.id])

      const around = await app.inject({
        method: "GET",
        url: `/v1/dm/${thread.id}/messages?around=${m1.id}`,
        headers: { authorization: `Bearer ${tok}`, "x-client": "mobile" },
      })
      expect(around.statusCode).toBe(200)
      expect(around.json()).not.toHaveProperty("pins")
    })
  })

  describe("delete-others override (Task 3.5)", () => {
    it("cleanup ORGANIZER deletes a member's message: 200 tombstone + message_update broadcast", async () => {
      const organizerId = await newUser("Del Org")
      const memberId = await newUser("Del Member")
      const cleanupId = await newCleanup(organizerId)
      await makeCleanupService({
        tickets: TEST_TICKET_SIGNER,
        repo: makeDrizzleCleanupRepository(h.sql),
      }).joinCleanup(cleanupId, memberId)
      const msg = await chat().insertMessage(
        { cleanupId, userId: memberId, body: "rule-breaking" },
        randomUUID(),
      )

      const watcher = new MockConnection("del-override-watcher")
      await container.chatService.joinRoom(roomKeyFor("cleanup", cleanupId), watcher, memberId)

      const res = await app.inject({
        method: "DELETE",
        url: `/v1/cleanups/${cleanupId}/messages/${msg.id}`,
        headers: { authorization: `Bearer ${await token(organizerId)}`, "x-client": "mobile" },
      })
      expect(res.statusCode).toBe(200)
      const dto = res.json()
      expect(dto.id).toBe(msg.id)
      expect(dto.deletedAt).toBeTruthy()
      // The moderator is not the author: the tombstone is not "mine" for them.
      expect(dto.mine).toBe(false)

      await flush()
      const updates = watcher.framesOfType("message_update")
      expect(updates).toHaveLength(1)
      expect((updates[0]!.message as { deletedAt: string | null }).deletedAt).toBeTruthy()
    })

    it("a plain member deleting someone else's cleanup message stays 403", async () => {
      const organizerId = await newUser("Del Org Deny")
      const memberId = await newUser("Del Member Deny")
      const cleanupId = await newCleanup(organizerId)
      await makeCleanupService({
        tickets: TEST_TICKET_SIGNER,
        repo: makeDrizzleCleanupRepository(h.sql),
      }).joinCleanup(cleanupId, memberId)
      const msg = await chat().insertMessage(
        { cleanupId, userId: organizerId, body: "keep out" },
        randomUUID(),
      )

      const res = await app.inject({
        method: "DELETE",
        url: `/v1/cleanups/${cleanupId}/messages/${msg.id}`,
        headers: { authorization: `Bearer ${await token(memberId)}`, "x-client": "mobile" },
      })
      expect(res.statusCode).toBe(403)
      // Still present.
      const reread = await chat().findMessage(cleanupId, msg.id, organizerId)
      expect(reread).not.toBeNull()
    })

    it("an OPERATOR deletes a report message without a membership row (200)", async () => {
      const posterId = await newUser("Del Poster")
      const operatorId = await newUser("Del Operator")
      await h.sql`UPDATE users SET role = 'operator' WHERE id = ${operatorId}`
      const reportId = await newReport()
      await makeReportChatRepository(h.sql).join(reportId, posterId)
      const msg = await chat().insertMessage(
        { cleanupId: reportId, roomKind: "report", userId: posterId, body: "moderate me" },
        randomUUID(),
      )

      const res = await app.inject({
        method: "DELETE",
        url: `/v1/reports/${reportId}/messages/${msg.id}`,
        headers: { authorization: `Bearer ${await token(operatorId)}`, "x-client": "mobile" },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().deletedAt).toBeTruthy()
    })

    it("a report OWNER deleting someone else's message stays 403 (owners curate, never erase)", async () => {
      const ownerId = await newUser("Del Report Owner")
      const memberId = await newUser("Del Report Member")
      const reportId = await newReport()
      const reportChat = makeReportChatRepository(h.sql)
      await reportChat.join(reportId, ownerId, "owner")
      await reportChat.join(reportId, memberId)
      const msg = await chat().insertMessage(
        { cleanupId: reportId, roomKind: "report", userId: memberId, body: "resident voice" },
        randomUUID(),
      )

      const res = await app.inject({
        method: "DELETE",
        url: `/v1/reports/${reportId}/messages/${msg.id}`,
        headers: { authorization: `Bearer ${await token(ownerId)}`, "x-client": "mobile" },
      })
      expect(res.statusCode).toBe(403)
      const reread = await chat().findReportMessage(reportId, msg.id, memberId)
      expect(reread).not.toBeNull()
    })

    it("a dm peer deleting the other's message stays 403 (unchanged)", async () => {
      const aliceId = await newUser("Del DM Alice")
      const bobId = await newUser("Del DM Bob")
      const thread = await dmRepo().openOrCreateThread(aliceId, bobId)
      const msg = await dmRepo().persist({
        threadId: thread.id,
        senderId: bobId,
        body: "bob's words",
      })

      const res = await app.inject({
        method: "DELETE",
        url: `/v1/dm/${thread.id}/messages/${msg.id}`,
        headers: { authorization: `Bearer ${await token(aliceId)}`, "x-client": "mobile" },
      })
      expect(res.statusCode).toBe(403)
      const reread = await dmRepo().findMessage(thread.id, msg.id, bobId)
      expect(reread).not.toBeNull()
    })
  })
})
