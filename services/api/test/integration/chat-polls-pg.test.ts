/**
 * P6 Tasks 6.3/6.4 integration test (Docker-gated): poll CREATE / VOTE / CLOSE + hydration, against a
 * live PostGIS container (via withPg).
 *
 *   A poll is a chat_messages row (kind='poll', body=question) plus the chat_polls trio. The three REST
 *   routes ride the unified /messages plugin (buildServer + chatOverrides on real repos; the container's
 *   FakeChatService captures broadcasts via joinRoom'd MockConnections):
 *
 *   CREATE (POST /messages/poll):
 *     - group member 200; the poll DTO rides the response AND the broadcast `message` frame a second
 *       joined client receives (viewer-aware counts/options);
 *     - channel: a read-only MEMBER 403s (send-permission gate), the ADMIN 200s;
 *     - cleanup member 200; report NON-joined 403.
 *   HYDRATION: history hydrates counts + myVote + totalVoters (distinct voters).
 *   VOTE (PUT /messages/poll/vote):
 *     - vote A -> counts; switch A->B decrements A + increments B; retract [] -> zeros;
 *     - totalVoters is DISTINCT (one voter's multi-ballot counts once);
 *     - multi-idx on a single-choice poll 422; an unknown idx 422; a closed poll 409 (poll_closed);
 *     - a channel READ-ONLY member may vote 200 (membership suffices); a public non-member 403s.
 *   CLOSE (POST /messages/poll/close):
 *     - the AUTHOR 200s + a joined client sees message_update; a plain member 403s; a cleanup ORGANIZER
 *       (moderator) 200s; a re-close is idempotent (closed_at unchanged).
 *   TOMBSTONE: a deleted poll's history row hydrates as a plain tombstone with NO poll field.
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
import { roomKeyFor } from "../../src/ws/gateway.js"
import { makeDrizzleChatRepository } from "../../src/services/chat-repository.drizzle.js"
import { makeDrizzleDmRepository } from "../../src/services/dm-repository.drizzle.js"
import { makeDrizzleBlocksRepository } from "../../src/services/blocks-repository.drizzle.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { makeReportChatRepository } from "../../src/services/report-chat-repository.drizzle.js"
import { makeChatGroupRepository } from "../../src/services/chat-group-repository.drizzle.js"
import { makeChatPollRepository } from "../../src/services/chat-poll-repository.drizzle.js"
import { makeChatPowersResolver } from "../../src/services/chat-room-roles.js"
import { globalRoleOf } from "../../src/routes/chat-powers-wiring.js"

const pg = await withPg()

describe.skipIf(!pg)("chat polls: create / vote / close + hydration (integration)", () => {
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
    const dmRepo = makeDrizzleDmRepository(h.sql)
    const reportChat = makeReportChatRepository(h.sql)
    const groups = makeChatGroupRepository(h.sql)
    // Real chat-powers resolver over the DB (the offline override branch fails cleanup/global roles
    // closed, which would 403 the cleanup-organizer close test — inject the real one instead).
    const chatPowers = makeChatPowersResolver({
      isDmParticipant: (t, u) => dmRepo.isParticipant(t, u),
      cleanupRoleOf: (c, u) => cleanups.roleOf(c, u),
      reportChatRoleOf: (r, u) => reportChat.roleOf(r, u),
      globalRoleOf: (u) => globalRoleOf(h.sql, u),
      groupRoleOf: (g, u) => groups.roleOf(g, u),
    })
    const overrides: ChatGatewayOverrides = {
      isMember: (cleanupId, userId) => cleanups.isMember(cleanupId, userId),
      threadsRepo: new InMemoryThreadsRepository(),
      dmRepo,
      chatRepo: makeDrizzleChatRepository(h.sql),
      blocksRepo: makeDrizzleBlocksRepository(h.sql),
      reportChat,
      groups,
      chatPolls: makeChatPollRepository(h.sql),
      chatPowers,
    }
    container = buildContainer(env)
    app = await buildServer({ env, container, authServices, chatOverrides: overrides })
  })

  afterAll(async () => {
    await app.close()
    await h.teardown()
  })

  const token = (userId: string) => authServices.sessions.createSession(userId, [])
  const chat = () => makeDrizzleChatRepository(h.sql)
  const flush = () => new Promise((resolve) => setImmediate(resolve))

  async function newUser(name: string, handle?: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${handle ?? testHandle()}) RETURNING id
    `
    return u!.id
  }

  /** Direct-SQL group/channel fixture: owner + (id, role) members. */
  async function newGroup(
    ownerId: string,
    opts: {
      kind?: "group" | "channel"
      visibility?: "private" | "public"
      members?: Array<{ id: string; role?: "admin" | "member" }>
    } = {},
  ): Promise<string> {
    const [g] = await h.sql<{ id: string }[]>`
      INSERT INTO chat_groups (name, owner_id, kind, visibility)
      VALUES ('Poll Room', ${ownerId}, ${opts.kind ?? "group"}, ${opts.visibility ?? "private"})
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

  /** Direct-SQL cleanup fixture: organizer + plain members (role 'member'). */
  async function newCleanup(organizerId: string, memberIds: string[] = []): Promise<string> {
    const [c] = await h.sql<{ id: string }[]>`
      INSERT INTO cleanups (organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (${organizerId}, 'site', 'Poll Cleanup',
              ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), ${new Date()}, 'upcoming')
      RETURNING id
    `
    const cleanupId = c!.id
    await h.sql`
      INSERT INTO cleanup_members (cleanup_id, user_id, role) VALUES (${cleanupId}, ${organizerId}, 'organizer')
    `
    for (const m of memberIds) {
      await h.sql`
        INSERT INTO cleanup_members (cleanup_id, user_id, role) VALUES (${cleanupId}, ${m}, 'member')
      `
    }
    return cleanupId
  }

  async function newReport(): Promise<string> {
    const [r] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, h3_cell)
      VALUES (${randomUUID()}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'dump', 'submitted', 'h0')
      RETURNING id
    `
    return r!.id
  }

  let injectSeq = 0
  function inject(tok: string, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
    injectSeq += 1
    return app.inject({
      method,
      url,
      remoteAddress: `10.51.${Math.floor(injectSeq / 250)}.${(injectSeq % 250) + 1}`,
      headers: { authorization: `Bearer ${tok}`, "x-client": "mobile" },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    })
  }

  const createPollBody = (roomKind: string, roomId: string, extra: Record<string, unknown> = {}) => ({
    roomKind,
    roomId,
    question: "Best day?",
    options: ["Sat", "Sun"],
    ...extra,
  })

  // -- CREATE -----------------------------------------------------------------

  it("create in a group by a member 200; the poll rides the response + the broadcast message frame", async () => {
    const ownerId = await newUser("Poll Owner")
    const memberId = await newUser("Poll Member")
    const groupId = await newGroup(ownerId, { members: [{ id: memberId }] })

    const watcher = new MockConnection("watcher")
    await container.chatService.joinRoom(roomKeyFor("group", groupId), watcher, ownerId)

    const res = await inject(
      await token(memberId),
      "POST",
      "/v1/messages/poll",
      createPollBody("group", groupId, { options: ["Sat", "Sun", "Mon"], anonymous: false }),
    )
    expect(res.statusCode).toBe(200)
    const dto = res.json()
    expect(dto.kind).toBe("poll")
    expect(dto.roomKind).toBe("group")
    expect(dto.body).toBe("Best day?")
    expect(dto.poll).toMatchObject({
      question: "Best day?",
      allowMultiple: false,
      anonymous: false,
      closed: false,
      totalVoters: 0,
      myVote: [],
    })
    expect(dto.poll.options).toEqual([
      { idx: 0, text: "Sat", count: 0, mine: false },
      { idx: 1, text: "Sun", count: 0, mine: false },
      { idx: 2, text: "Mon", count: 0, mine: false },
    ])

    await flush()
    const frames = watcher.framesOfType("message")
    expect(frames).toHaveLength(1)
    const framed = (frames[0] as { message: { id: string; kind: string; poll?: unknown } }).message
    expect(framed.id).toBe(dto.id)
    expect(framed.kind).toBe("poll")
    expect(framed.poll).toBeTruthy()
  })

  it("create in a CHANNEL: a read-only member 403s, the admin 200s", async () => {
    const ownerId = await newUser("Ch Poll Owner")
    const adminId = await newUser("Ch Poll Admin")
    const memberId = await newUser("Ch Poll Member")
    const channelId = await newGroup(ownerId, {
      kind: "channel",
      members: [
        { id: adminId, role: "admin" },
        { id: memberId, role: "member" },
      ],
    })

    const denied = await inject(await token(memberId), "POST", "/v1/messages/poll", createPollBody("group", channelId))
    expect(denied.statusCode).toBe(403)
    expect(denied.json().fields).toMatchObject({ code: "poll_forbidden" })

    const ok = await inject(await token(adminId), "POST", "/v1/messages/poll", createPollBody("group", channelId))
    expect(ok.statusCode).toBe(200)
    expect(ok.json().kind).toBe("poll")
  })

  it("create in a cleanup by a member 200", async () => {
    const organizerId = await newUser("Cl Poll Org")
    const memberId = await newUser("Cl Poll Member")
    const cleanupId = await newCleanup(organizerId, [memberId])

    const res = await inject(await token(memberId), "POST", "/v1/messages/poll", createPollBody("cleanup", cleanupId))
    expect(res.statusCode).toBe(200)
    expect(res.json().poll.options).toHaveLength(2)
  })

  it("create in a report by a NON-joined user 403s", async () => {
    const strangerId = await newUser("Rep Poll Stranger")
    const reportId = await newReport()

    const res = await inject(await token(strangerId), "POST", "/v1/messages/poll", createPollBody("report", reportId))
    expect(res.statusCode).toBe(403)
    expect(res.json().fields).toMatchObject({ code: "poll_forbidden" })
  })

  // -- HYDRATION --------------------------------------------------------------

  it("history hydrates counts + myVote + totalVoters", async () => {
    const ownerId = await newUser("Hydr Owner")
    const bId = await newUser("Hydr B")
    const groupId = await newGroup(ownerId, { members: [{ id: bId }] })

    const created = await inject(await token(ownerId), "POST", "/v1/messages/poll", createPollBody("group", groupId))
    const pollId = created.json().id

    // Owner votes idx 0, B votes idx 1.
    await inject(await token(ownerId), "PUT", "/v1/messages/poll/vote", { messageId: pollId, optionIdxs: [0] })
    await inject(await token(bId), "PUT", "/v1/messages/poll/vote", { messageId: pollId, optionIdxs: [1] })

    // History as the owner: counts reflect both votes, myVote is the owner's, totalVoters distinct = 2.
    const hist = await inject(await token(ownerId), "GET", `/v1/groups/${groupId}/messages`)
    expect(hist.statusCode).toBe(200)
    const poll = hist.json().items.find((m: { id: string }) => m.id === pollId).poll
    expect(poll.totalVoters).toBe(2)
    expect(poll.myVote).toEqual([0])
    expect(poll.options).toEqual([
      { idx: 0, text: "Sat", count: 1, mine: true },
      { idx: 1, text: "Sun", count: 1, mine: false },
    ])
  })

  // -- VOTE -------------------------------------------------------------------

  it("vote -> switch -> retract adjusts counts; totalVoters stays distinct on a multi-ballot", async () => {
    const ownerId = await newUser("Vote Owner")
    const groupId = await newGroup(ownerId, {})
    const created = await inject(
      await token(ownerId),
      "POST",
      "/v1/messages/poll",
      createPollBody("group", groupId, { allowMultiple: true }),
    )
    const pollId = created.json().id

    // Vote A(0).
    const a = await inject(await token(ownerId), "PUT", "/v1/messages/poll/vote", { messageId: pollId, optionIdxs: [0] })
    expect(a.statusCode).toBe(200)
    expect(a.json().poll.options.map((o: { count: number }) => o.count)).toEqual([1, 0])
    expect(a.json().poll.myVote).toEqual([0])

    // Switch A->B: A decrements, B increments.
    const b = await inject(await token(ownerId), "PUT", "/v1/messages/poll/vote", { messageId: pollId, optionIdxs: [1] })
    expect(b.json().poll.options.map((o: { count: number }) => o.count)).toEqual([0, 1])
    expect(b.json().poll.myVote).toEqual([1])

    // Both idxs (allowMultiple) => one distinct voter, both counts 1.
    const both = await inject(await token(ownerId), "PUT", "/v1/messages/poll/vote", {
      messageId: pollId,
      optionIdxs: [0, 1],
    })
    expect(both.json().poll.options.map((o: { count: number }) => o.count)).toEqual([1, 1])
    expect(both.json().poll.totalVoters).toBe(1)
    expect(both.json().poll.myVote).toEqual([0, 1])

    // Retract [] => zeros, no voters.
    const retract = await inject(await token(ownerId), "PUT", "/v1/messages/poll/vote", {
      messageId: pollId,
      optionIdxs: [],
    })
    expect(retract.json().poll.options.map((o: { count: number }) => o.count)).toEqual([0, 0])
    expect(retract.json().poll.totalVoters).toBe(0)
    expect(retract.json().poll.myVote).toEqual([])
  })

  it("a duplicate idx in a multi ballot dedupes: [0,0] -> 200 with ONE vote row", async () => {
    const ownerId = await newUser("Dup Owner")
    const groupId = await newGroup(ownerId, {})
    const created = await inject(
      await token(ownerId),
      "POST",
      "/v1/messages/poll",
      createPollBody("group", groupId, { allowMultiple: true }),
    )
    const pollId = created.json().id

    // Schema-valid repeat idx: must NOT 500 on the votes PK — dedupe to a single ballot row.
    const res = await inject(await token(ownerId), "PUT", "/v1/messages/poll/vote", {
      messageId: pollId,
      optionIdxs: [0, 0],
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().poll.options.map((o: { count: number }) => o.count)).toEqual([1, 0])
    expect(res.json().poll.myVote).toEqual([0])
    const rows = await h.sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM chat_poll_votes WHERE poll_id = ${pollId}
    `
    expect(rows[0]!.count).toBe(1)
  })

  it("a multi-idx ballot on a single-choice poll 422s; an unknown idx 422s", async () => {
    const ownerId = await newUser("Val Owner")
    const groupId = await newGroup(ownerId, {})
    const created = await inject(await token(ownerId), "POST", "/v1/messages/poll", createPollBody("group", groupId))
    const pollId = created.json().id

    const multi = await inject(await token(ownerId), "PUT", "/v1/messages/poll/vote", {
      messageId: pollId,
      optionIdxs: [0, 1],
    })
    expect(multi.statusCode).toBe(422)

    // idx 5 is schema-valid (<=9) but not an option on this 2-choice poll.
    const bad = await inject(await token(ownerId), "PUT", "/v1/messages/poll/vote", {
      messageId: pollId,
      optionIdxs: [5],
    })
    expect(bad.statusCode).toBe(422)
  })

  it("voting on a CLOSED poll 409s (poll_closed)", async () => {
    const ownerId = await newUser("Closed Owner")
    const groupId = await newGroup(ownerId, {})
    const created = await inject(await token(ownerId), "POST", "/v1/messages/poll", createPollBody("group", groupId))
    const pollId = created.json().id
    const closed = await inject(await token(ownerId), "POST", "/v1/messages/poll/close", { messageId: pollId })
    expect(closed.statusCode).toBe(200)

    const vote = await inject(await token(ownerId), "PUT", "/v1/messages/poll/vote", { messageId: pollId, optionIdxs: [0] })
    expect(vote.statusCode).toBe(409)
    expect(vote.json().fields).toMatchObject({ code: "poll_closed" })
  })

  it("a channel READ-ONLY member may vote 200; a public non-member 403s", async () => {
    const ownerId = await newUser("PubCh Owner")
    const readerId = await newUser("PubCh Reader")
    const strangerId = await newUser("PubCh Stranger")
    const channelId = await newGroup(ownerId, {
      kind: "channel",
      visibility: "public",
      members: [{ id: readerId, role: "member" }],
    })
    const created = await inject(await token(ownerId), "POST", "/v1/messages/poll", createPollBody("group", channelId))
    const pollId = created.json().id

    // A read-only channel member can't POST but CAN vote (membership suffices).
    const reader = await inject(await token(readerId), "PUT", "/v1/messages/poll/vote", { messageId: pollId, optionIdxs: [0] })
    expect(reader.statusCode).toBe(200)
    expect(reader.json().poll.options[0].count).toBe(1)

    // A public non-member reader is NOT a member -> can't vote.
    const stranger = await inject(await token(strangerId), "PUT", "/v1/messages/poll/vote", { messageId: pollId, optionIdxs: [1] })
    expect(stranger.statusCode).toBe(403)
    expect(stranger.json().fields).toMatchObject({ code: "poll_not_member" })
  })

  // -- CLOSE ------------------------------------------------------------------

  it("close by the author 200s + broadcasts message_update; a plain member 403s", async () => {
    const ownerId = await newUser("Close Owner")
    const memberId = await newUser("Close Member")
    const groupId = await newGroup(ownerId, { members: [{ id: memberId }] })
    const created = await inject(await token(ownerId), "POST", "/v1/messages/poll", createPollBody("group", groupId))
    const pollId = created.json().id

    // A plain member (not author, not moderator) can't close.
    const denied = await inject(await token(memberId), "POST", "/v1/messages/poll/close", { messageId: pollId })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().fields).toMatchObject({ code: "poll_close_forbidden" })

    const watcher = new MockConnection("close-watcher")
    await container.chatService.joinRoom(roomKeyFor("group", groupId), watcher, ownerId)

    const closed = await inject(await token(ownerId), "POST", "/v1/messages/poll/close", { messageId: pollId })
    expect(closed.statusCode).toBe(200)
    expect(closed.json().poll.closed).toBe(true)

    await flush()
    const updates = watcher.framesOfType("message_update")
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      type: "message_update",
      roomKind: "group",
      roomId: groupId,
      message: { id: pollId, poll: { closed: true } },
    })
  })

  it("close by a cleanup ORGANIZER (moderator) 200s; a re-close keeps the original closed_at", async () => {
    const organizerId = await newUser("Cl Close Org")
    const memberId = await newUser("Cl Close Member")
    const cleanupId = await newCleanup(organizerId, [memberId])
    // Poll authored by the plain member; the organizer closes it as a moderator.
    const created = await inject(await token(memberId), "POST", "/v1/messages/poll", createPollBody("cleanup", cleanupId))
    const pollId = created.json().id

    const closed = await inject(await token(organizerId), "POST", "/v1/messages/poll/close", { messageId: pollId })
    expect(closed.statusCode).toBe(200)
    expect(closed.json().poll.closed).toBe(true)

    const [firstClose] = await h.sql<{ closed_at: Date }[]>`
      SELECT closed_at FROM chat_polls WHERE message_id = ${pollId}
    `
    // Re-close is idempotent: still 200, closed_at unchanged.
    const again = await inject(await token(organizerId), "POST", "/v1/messages/poll/close", { messageId: pollId })
    expect(again.statusCode).toBe(200)
    const [secondClose] = await h.sql<{ closed_at: Date }[]>`
      SELECT closed_at FROM chat_polls WHERE message_id = ${pollId}
    `
    expect(secondClose!.closed_at.getTime()).toBe(firstClose!.closed_at.getTime())
  })

  it("close by a REPORT-CHAT OWNER (pin-only, non-operator) on another member's poll 200s (ruling: isModerator)", async () => {
    const reportOwnerId = await newUser("Rep Close Owner")
    const memberId = await newUser("Rep Close Member")
    const reportId = await newReport()
    const reportChat = makeReportChatRepository(h.sql)
    await reportChat.join(reportId, reportOwnerId, "owner")
    await reportChat.join(reportId, memberId, "member")

    // Poll authored by the plain member; the report chat OWNER closes it — isModerator is true for a
    // report owner (canPin), so close succeeds even though they hold no canDeleteOthers power.
    const created = await inject(await token(memberId), "POST", "/v1/messages/poll", createPollBody("report", reportId))
    expect(created.statusCode).toBe(200)
    const pollId = created.json().id

    const closed = await inject(await token(reportOwnerId), "POST", "/v1/messages/poll/close", { messageId: pollId })
    expect(closed.statusCode).toBe(200)
    expect(closed.json().poll.closed).toBe(true)
  })

  // -- TOMBSTONE --------------------------------------------------------------

  it("a deleted poll hydrates as a plain tombstone with NO poll field", async () => {
    const ownerId = await newUser("Tomb Owner")
    const groupId = await newGroup(ownerId, {})
    const created = await inject(await token(ownerId), "POST", "/v1/messages/poll", createPollBody("group", groupId))
    const pollId = created.json().id

    // Tombstone the poll message (sender-only soft delete).
    expect(await chat().softDeleteGroup(groupId, pollId, ownerId)).not.toBeNull()

    // A live re-read never returns a deleted row; assert directly via the poll repo + a fresh find.
    const reread = await chat().findGroupMessage(groupId, pollId, ownerId)
    expect(reread).toBeNull()

    // The poll rows survive (subtree intact) but hydration must not attach them to the tombstone: load
    // the row including deleted via a history around-jump to the deleted id.
    const around = await chat().groupHistory(groupId, undefined, 20, ownerId, pollId)
    const tombstone = around.items.find((m) => m.id === pollId)
    expect(tombstone).toBeTruthy()
    expect(tombstone!.deletedAt).toBeTruthy()
    expect(tombstone!.poll).toBeUndefined()
  })
})
