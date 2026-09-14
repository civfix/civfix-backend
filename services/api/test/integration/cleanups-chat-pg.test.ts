/**
 * Cleanups + chat integration test (Docker-gated). Boots against a live PostGIS container (via withPg)
 * and exercises the DB-backed paths that the offline suite covers only with in-memory fakes:
 *
 *   - the Drizzle CleanupRepository create transaction inserts the cleanup AND the organizer's
 *     cleanup_members row atomically (membership == chat membership), and join/leave toggle membership;
 *   - the Drizzle ChatRepository persists into the PARTITIONED chat_messages table and pages history
 *     newest-first with a `before` cursor across the partitions;
 *   - GET /cleanups/:id/messages is membership-gated against real Postgres: 200 for a member, 403 for a
 *     non-member.
 *
 * When Docker is unavailable the whole block SKIPS so the local suite stays green; CI runs it for real.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { buildServer } from "../../src/server.js"
import { buildContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { makeDrizzleChatRepository } from "../../src/services/chat-repository.drizzle.js"
import { makeDrizzleChatReadState } from "../../src/services/chat-read-state.drizzle.js"
import { makeCleanupService } from "../../src/services/cleanup-service.js"

const pg = await withPg()

describe.skipIf(!pg)("cleanups + chat (integration)", () => {
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

  it("createCleanupTx inserts the cleanup + organizer membership atomically", async () => {
    const organizerId = await newUser("Org Atomic")
    const repo = makeDrizzleCleanupRepository(h.sql)
    const service = makeCleanupService({ repo })

    const dto = await service.createCleanup(
      {
        title: "Atomic sweep",
        type: "site",
        eventKind: "cleanup",
        lat: 34.05,
        lng: -118.25,
        scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        slots: [{ title: "General volunteers", capacity: null }],
        bring: ["gloves"],
        address: "Main gate",
      },
      organizerId,
    )

    expect(dto.joined).toBe(true)
    expect(dto.going).toBe(1)
    expect(dto.address).toBe("Main gate")

    // The membership row exists with role organizer (== chat membership).
    const members = await h.sql<{ role: string }[]>`
      SELECT role FROM cleanup_members WHERE cleanup_id = ${dto.id} AND user_id = ${organizerId}
    `
    expect(members).toHaveLength(1)
    expect(members[0]!.role).toBe("organizer")
  })

  it("join is idempotent and leave removes membership", async () => {
    const organizerId = await newUser("Org Join")
    const aliceId = await newUser("Alice Join")
    const repo = makeDrizzleCleanupRepository(h.sql)
    const service = makeCleanupService({ repo })
    const created = await service.createCleanup(
      {
        title: "Join sweep",
        type: "site",
        eventKind: "cleanup",
        lat: 34.06,
        lng: -118.26,
        scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        slots: [{ title: "General volunteers", capacity: null }],
      },
      organizerId,
    )

    expect(await service.joinCleanup(created.id, aliceId)).toEqual({ joined: true, going: 2 })
    // Idempotent re-join.
    expect(await service.joinCleanup(created.id, aliceId)).toEqual({ joined: true, going: 2 })
    expect(await service.leaveCleanup(created.id, aliceId)).toEqual({ joined: false, going: 1 })
  })

  it("persists chat into the partitioned table and pages history newest-first with a cursor", async () => {
    const organizerId = await newUser("Org Chat")
    const cleanupRepo = makeDrizzleCleanupRepository(h.sql)
    const cleanupService = makeCleanupService({ repo: cleanupRepo })
    const created = await cleanupService.createCleanup(
      {
        title: "Chat sweep",
        type: "site",
        eventKind: "cleanup",
        lat: 34.07,
        lng: -118.27,
        scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        slots: [{ title: "General volunteers", capacity: null }],
      },
      organizerId,
    )

    const chatRepo = makeDrizzleChatRepository(h.sql)
    const ids: string[] = []
    for (let i = 1; i <= 5; i++) {
      const dto = await chatRepo.insertMessage(
        { cleanupId: created.id, userId: organizerId, body: `m${i}` },
        randomUUID(),
      )
      ids.push(dto.id)
      // This is an organizer-authored message, not a sender-less SYSTEM message, so `from` is always
      // present here; assert that before narrowing so the intent (author == organizer) stays explicit.
      expect(dto.from).toBeTruthy()
      expect(dto.from?.id).toBe(organizerId)
    }
    // insertMessage stamps created_at = now(), which can TIE for back-to-back inserts; the table's uuid
    // id is random, not a send-order tiebreaker, so newest-first ordering of tied rows is unstable. Force
    // strictly-increasing created_at (1s apart, send order) so the cursor-paging assertions below are
    // deterministic. (Real chat messages arrive seconds apart, so this matches production ordering.)
    const base = Date.now()
    let order = 0
    for (const id of ids) {
      await h.sql`UPDATE chat_messages SET created_at = ${new Date(base + order * 1000)} WHERE id = ${id}`
      order++
    }

    // Newest-first page of 2.
    const page1 = await chatRepo.history(created.id, undefined, 2)
    expect(page1.items.map((m) => m.body)).toEqual(["m5", "m4"])
    expect(page1.nextCursor).not.toBeNull()

    const page2 = await chatRepo.history(created.id, page1.nextCursor!, 2)
    expect(page2.items.map((m) => m.body)).toEqual(["m3", "m2"])

    const page3 = await chatRepo.history(created.id, page2.nextCursor!, 2)
    expect(page3.items.map((m) => m.body)).toEqual(["m1"])
    expect(page3.nextCursor).toBeNull()

    // The rows physically landed in a monthly partition (not just the parent).
    const partition = await h.sql<{ child: string }[]>`
      SELECT tableoid::regclass::text AS child FROM chat_messages WHERE cleanup_id = ${created.id} LIMIT 1
    `
    expect(partition[0]!.child).toContain("chat_messages_")
  })

  it("P1-5: a `before` cursor from ANOTHER room cannot seek/leak into this room", async () => {
    const organizerId = await newUser("Org XRoom")
    const cleanupRepo = makeDrizzleCleanupRepository(h.sql)
    const cleanupService = makeCleanupService({ repo: cleanupRepo })
    const mk = (title: string) =>
      cleanupService.createCleanup(
        {
          title,
          type: "site",
          eventKind: "cleanup",
          lat: 34.07,
          lng: -118.27,
          scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          slots: [{ title: "General volunteers", capacity: null }],
        },
        organizerId,
      )
    const roomA = await mk("Room A")
    const roomB = await mk("Room B")

    const chatRepo = makeDrizzleChatRepository(h.sql)
    // Room A has 3 messages; room B has 1 message whose id we will (mis)use as a cursor against room A.
    for (let i = 1; i <= 3; i++) {
      await chatRepo.insertMessage({ cleanupId: roomA.id, userId: organizerId, body: `a${i}` }, randomUUID())
    }
    const bMsg = await chatRepo.insertMessage(
      { cleanupId: roomB.id, userId: organizerId, body: "b1" },
      randomUUID(),
    )

    // Page room A with a `before` cursor that belongs to ROOM B. The foreign anchor does NOT resolve
    // (the lookup is scoped to room A), so we get room A's NEWEST page - never a window carved by B's
    // timestamp, and never any of B's rows. Every returned row belongs to room A.
    const page = await chatRepo.history(roomA.id, bMsg.id, 2)
    expect(page.items.map((m) => m.body)).toEqual(["a3", "a2"])
    expect(page.items.every((m) => m.cleanupId === roomA.id)).toBe(true)
    // Sanity: room B's message is not leaked into room A's page.
    expect(page.items.some((m) => m.id === bMsg.id)).toBe(false)
  })

  it("persists the chat read watermark (cleanup_members.last_read_at) monotonically", async () => {
    const organizerId = await newUser("Org Read")
    const cleanupRepo = makeDrizzleCleanupRepository(h.sql)
    const created = await makeCleanupService({ repo: cleanupRepo }).createCleanup(
      {
        title: "Read sweep",
        type: "site",
        eventKind: "cleanup",
        lat: 34.09,
        lng: -118.29,
        scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        slots: [{ title: "General volunteers", capacity: null }],
      },
      organizerId,
    )

    const readState = makeDrizzleChatReadState(h.sql)
    // Never marked -> null (unread baseline falls back to joined_at).
    expect(await readState.lastReadAt(created.id, organizerId)).toBeNull()

    const t1 = new Date("2026-06-01T12:00:00.000Z")
    await readState.markRead(created.id, organizerId, t1)
    expect((await readState.lastReadAt(created.id, organizerId))!.getTime()).toBe(t1.getTime())

    // Monotonic: an EARLIER mark never moves the watermark back.
    await readState.markRead(created.id, organizerId, new Date("2026-06-01T11:00:00.000Z"))
    expect((await readState.lastReadAt(created.id, organizerId))!.getTime()).toBe(t1.getTime())

    // A LATER mark advances it.
    const t2 = new Date("2026-06-01T13:00:00.000Z")
    await readState.markRead(created.id, organizerId, t2)
    expect((await readState.lastReadAt(created.id, organizerId))!.getTime()).toBe(t2.getTime())

    // Marking read for a NON-member is a silent no-op (0 rows; nothing to read back).
    const strangerId = await newUser("Stranger Read")
    await readState.markRead(created.id, strangerId, t2)
    expect(await readState.lastReadAt(created.id, strangerId)).toBeNull()
  })

  it("GET /cleanups/:id/messages is membership-gated against real Postgres (200 member, 403 non-member)", async () => {
    // Real DB-backed cleanup routes (no cleanupOverrides) + an in-memory auth bundle for sessions.
    const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: h.uri })
    const container = buildContainer(env)
    const stores = makeInMemoryStores()
    const cache = new InMemoryCacheClient(() => Date.now())
    const authServices = buildAuthServices({
      stores,
      cache,
      mailer: container.mailer as never,
      oauthConfig: {},
      verifier: new StubJwksVerifier(),
      now: () => Date.now(),
    })
    const app: FastifyInstance = await buildServer({ env, container, authServices })

    try {
      // Create a cleanup owned by an organizer who is also a real session user.
      // Mint a session for an existing users row so requireAuth resolves to that id.
      const organizerId = await newUser("Org Route")
      const organizerToken = await authServices.sessions.createSession(organizerId, [])

      const cleanupRepo = makeDrizzleCleanupRepository(h.sql)
      const created = await makeCleanupService({ repo: cleanupRepo }).createCleanup(
        {
          title: "Route sweep",
          type: "site",
          eventKind: "cleanup",
          lat: 34.08,
          lng: -118.28,
          scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          slots: [{ title: "General volunteers", capacity: null }],
        },
        organizerId,
      )

      // Seed a message via the chat seam so history is non-empty.
      await container.chatService.persist({ cleanupId: created.id, userId: organizerId, body: "hello" })

      // Member (organizer) -> 200.
      const ok = await app.inject({
        method: "GET",
        url: `/v1/cleanups/${created.id}/messages`,
        headers: { authorization: `Bearer ${organizerToken}` },
      })
      expect(ok.statusCode).toBe(200)
      expect(ok.json().items.length).toBeGreaterThanOrEqual(1)

      // Non-member -> 403.
      const strangerId = await newUser("Stranger Route")
      const strangerToken = await authServices.sessions.createSession(strangerId, [])
      const forbidden = await app.inject({
        method: "GET",
        url: `/v1/cleanups/${created.id}/messages`,
        headers: { authorization: `Bearer ${strangerToken}` },
      })
      expect(forbidden.statusCode).toBe(403)
      expect(forbidden.json().code).toBe("FORBIDDEN")
    } finally {
      await app.close()
    }
  })

  it("P1: reaction toggle honors the WIDENED allowlist end-to-end (laugh -> 200 + summary; unknown -> 422)", async () => {
    // Full server against the real DB (same wiring as the membership-gated route test above) so the
    // POST /cleanups/:id/messages/:messageId/reactions path — shared-schema parse included — runs for real.
    const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: h.uri })
    const container = buildContainer(env)
    const stores = makeInMemoryStores()
    const cache = new InMemoryCacheClient(() => Date.now())
    const authServices = buildAuthServices({
      stores,
      cache,
      mailer: container.mailer as never,
      oauthConfig: {},
      verifier: new StubJwksVerifier(),
      now: () => Date.now(),
    })
    const app: FastifyInstance = await buildServer({ env, container, authServices })

    try {
      const organizerId = await newUser("Org Reaction")
      const organizerToken = await authServices.sessions.createSession(organizerId, [])

      const cleanupRepo = makeDrizzleCleanupRepository(h.sql)
      const created = await makeCleanupService({ repo: cleanupRepo }).createCleanup(
        {
          title: "Reaction sweep",
          type: "site",
          eventKind: "cleanup",
          lat: 34.1,
          lng: -118.3,
          scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          slots: [{ title: "General volunteers", capacity: null }],
        },
        organizerId,
      )
      const msg = await makeDrizzleChatRepository(h.sql).insertMessage(
        { cleanupId: created.id, userId: organizerId, body: "react to me" },
        randomUUID(),
      )

      // "laugh" is one of the two P1 additions (append-only widening 6 -> 8): the shared schema at the
      // route boundary must accept it and the toggle must land in chat_reactions.
      const on = await app.inject({
        method: "POST",
        url: `/v1/cleanups/${created.id}/messages/${msg.id}/reactions`,
        headers: { authorization: `Bearer ${organizerToken}`, "x-client": "mobile" },
        payload: { emoji: "laugh" },
      })
      expect(on.statusCode).toBe(200)
      const summary = on.json().reactions as { emoji: string; count: number; mine: boolean }[]
      expect(summary).toContainEqual({ emoji: "laugh", count: 1, mine: true })

      // Second toggle removes it (same endpoint, same emoji).
      const off = await app.inject({
        method: "POST",
        url: `/v1/cleanups/${created.id}/messages/${msg.id}/reactions`,
        headers: { authorization: `Bearer ${organizerToken}`, "x-client": "mobile" },
        payload: { emoji: "laugh" },
      })
      expect(off.statusCode).toBe(200)
      expect((off.json().reactions as { emoji: string }[]).some((r) => r.emoji === "laugh")).toBe(false)

      // The allowlist is widened, not open: a name outside the 8 still fails schema parse.
      const rejected = await app.inject({
        method: "POST",
        url: `/v1/cleanups/${created.id}/messages/${msg.id}/reactions`,
        headers: { authorization: `Bearer ${organizerToken}`, "x-client": "mobile" },
        payload: { emoji: "angry" },
      })
      expect(rejected.statusCode).toBe(422)
    } finally {
      await app.close()
    }
  })

  it("WS4: promote/demote flips cleanup_members.role in Postgres (cohost value) and remove deletes the row", async () => {
    const organizerId = await newUser("Org Roles")
    const aliceId = await newUser("Alice Roles")
    const bobId = await newUser("Bob Roles")
    const repo = makeDrizzleCleanupRepository(h.sql)
    const service = makeCleanupService({ repo })
    const created = await service.createCleanup(
      {
        title: "Roles sweep",
        type: "site",
        eventKind: "cleanup",
        lat: 34.08,
        lng: -118.28,
        scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        slots: [{ title: "General volunteers", capacity: null }],
      },
      organizerId,
    )
    await service.joinCleanup(created.id, aliceId)
    await service.joinCleanup(created.id, bobId)

    // Promote against the real table: the stored role is 'cohost' (0045 widened the value set).
    await service.setMemberRole(created.id, organizerId, aliceId, "cohost")
    const stored = await h.sql<{ role: string }[]>`
      SELECT role FROM cleanup_members WHERE cleanup_id = ${created.id} AND user_id = ${aliceId}
    `
    expect(stored[0]!.role).toBe("cohost")
    expect(await repo.roleOf(created.id, aliceId)).toBe("cohost")
    expect(await repo.rolesOf([created.id], aliceId)).toEqual(new Map([[created.id, "cohost"]]))

    // The attendees read carries the role, cohost sorted after the organizer.
    const roster = await service.listAttendees(created.id, { userId: organizerId })
    expect(roster.attendees.map((p) => p.role)).toEqual(["organizer", "cohost", "member"])

    // myRole on the detail read.
    expect((await service.getCleanup(created.id, { userId: aliceId })).myRole).toBe("cohost")
    expect((await service.getCleanup(created.id, { userId: organizerId })).myRole).toBe("organizer")

    // The SQL guard refuses to touch the organizer row even when called directly.
    expect(await repo.setMemberRole(created.id, organizerId, "member")).toBe(false)

    // Demote back, then remove: the row is gone and the count reflects it in the same tx.
    await service.setMemberRole(created.id, organizerId, aliceId, "member")
    expect(await repo.roleOf(created.id, aliceId)).toBe("member")
    const removed = await service.removeMember(created.id, organizerId, bobId)
    expect(removed).toEqual({ ok: true, going: 2 })
    expect(await repo.isMember(created.id, bobId)).toBe(false)
    // M17: the same transaction wrote the ban that makes the removal stick — the self-service join
    // now refuses instead of silently re-creating the membership row.
    expect(await repo.isBanned(created.id, bobId)).toBe(true)
    expect(await repo.joinCleanupTx(created.id, bobId)).toBe("banned")
    expect(await repo.isMember(created.id, bobId)).toBe(false)
    // The organizer lifts it, and only then can Bob RSVP again.
    expect(await repo.unbanMember(created.id, bobId)).toBe(true)
    expect(await repo.joinCleanupTx(created.id, bobId)).toBe("joined")
    expect(await repo.isMember(created.id, bobId)).toBe(true)
    // Direct repo guard: removing the organizer row is refused (and writes no ban).
    expect((await repo.removeMember(created.id, organizerId, organizerId)).kind).toBe("not_member")
    expect(await repo.isBanned(created.id, organizerId)).toBe(false)
  })
})
