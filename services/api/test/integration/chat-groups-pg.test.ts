/**
 * P4 Task 4.3 integration test (Docker-gated): the /groups management surface + the group message
 * lanes, against a live PostGIS container (via withPg) over HTTP.
 *
 *   Create — POST /groups seeds the owner membership + invited members; dupes, self, and anyone the
 *   creator is blocked-either-way with are silently skipped; avatarUploadId finalizes to
 *   avatar_media_id (hydrated once 'ready').
 *
 *   Read gates — private groups 403 non-members (fields.code not_a_member) and 200 members with
 *   myRole; PUBLIC groups are viewable pre-join (myRole null).
 *
 *   Management matrix — admin updates name (member 403 update_forbidden); visibility change is
 *   owner-only (admin 403 visibility_owner_only); role set is owner-only (admin 403 role_owner_only);
 *   owner removes an admin but an admin cannot (403 remove_forbidden); self-remove = leave; the
 *   owner's leave 409s owner_must_stay; addGroupMembers is owner/admin-only (member 403).
 *
 *   Message lanes — GET /groups/:id/messages is member-gated for private rooms (non-member 403);
 *   DELETE /groups/:id/messages/:messageId lets the sender self-delete and an admin tombstone a
 *   member's message (member-on-other 403); PUT /messages/pin roomKind:"group" pins for an admin and
 *   403s pin_forbidden for a member (the chat-powers group lane end-to-end).
 *
 * Repos ride chatOverrides on the real Drizzle impls over the harness pool, chatOverrides.chatPowers
 * injects the REAL resolver over the REAL pg lookups (incl. the new chat_group_members roleOf) —
 * mirroring chat-pins-pg. Skips when Docker is unavailable; CI runs it for real.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedMediaAsset } from "../helpers/media-pg.js"
import { buildServer } from "../../src/server.js"
import { buildContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryThreadsRepository } from "../helpers/chat.js"
import type { ChatGatewayOverrides } from "../../src/routes/chat.routes.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { makeDrizzleChatRepository } from "../../src/services/chat-repository.drizzle.js"
import { makeDrizzleDmRepository } from "../../src/services/dm-repository.drizzle.js"
import { makeDrizzleBlocksRepository } from "../../src/services/blocks-repository.drizzle.js"
import { makeReportChatRepository } from "../../src/services/report-chat-repository.drizzle.js"
import { makeChatGroupRepository } from "../../src/services/chat-group-repository.drizzle.js"
import { makeConversationMutesRepository } from "../../src/services/conversation-mutes-repository.drizzle.js"
import { makeChatPowersResolver } from "../../src/services/chat-room-roles.js"
import { globalRoleOf } from "../../src/routes/chat-powers-wiring.js"
import type { PresignMedia } from "../../src/services/media-presign.js"

const pg = await withPg()

/** Deterministic offline presigner so avatar/attachment hydration needs no object store. */
const fakePresign: PresignMedia = (r2Key, thumbKey) =>
  Promise.resolve({
    url: `memory://${r2Key}`,
    ...(thumbKey !== null ? { thumbUrl: `memory://${thumbKey}` } : {}),
  })

describe.skipIf(!pg)("chat groups service + routes (integration)", () => {
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
    const groups = makeChatGroupRepository(h.sql, fakePresign)
    const overrides: ChatGatewayOverrides = {
      isMember: (cleanupId, userId) => cleanups.isMember(cleanupId, userId),
      threadsRepo: new InMemoryThreadsRepository(),
      dmRepo: dm,
      chatRepo: makeDrizzleChatRepository(h.sql, fakePresign),
      blocksRepo: makeDrizzleBlocksRepository(h.sql),
      reportChat,
      groups,
      conversationMutes: makeConversationMutesRepository(h.sql),
      chatPowers: makeChatPowersResolver({
        isDmParticipant: (threadId, userId) => dm.isParticipant(threadId, userId),
        cleanupRoleOf: (cleanupId, userId) => cleanups.roleOf(cleanupId, userId),
        reportChatRoleOf: (reportId, userId) => reportChat.roleOf(reportId, userId),
        globalRoleOf: (userId) => globalRoleOf(h.sql, userId),
        groupRoleOf: (groupId, userId) => groups.roleOf(groupId, userId),
      }),
    }
    container = buildContainer(env)
    app = await buildServer({
      env,
      container,
      authServices,
      chatOverrides: overrides,
    })
  })

  afterAll(async () => {
    await app.close()
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id
    `
    return u!.id
  }

  const token = (userId: string) => authServices.sessions.createSession(userId, [])

  const chat = () => makeDrizzleChatRepository(h.sql, fakePresign)

  // Rate limits are IP-keyed (plugins/rate-limit keyGenerator) and inject() defaults every request
  // to ONE address, so the suite's ~dozen POST /groups would trip the 10/hour create limit. A unique
  // per-request remoteAddress keeps the limiter out of these assertions (it is not under test here).
  let injectSeq = 0
  function inject(
    tok: string,
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    payload?: unknown,
  ) {
    injectSeq += 1
    return app.inject({
      method,
      url,
      remoteAddress: `10.42.${Math.floor(injectSeq / 250)}.${(injectSeq % 250) + 1}`,
      headers: { authorization: `Bearer ${tok}`, "x-client": "mobile" },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    })
  }

  /** Create a group over HTTP as `ownerId`; returns the ChatGroupDTO. */
  async function newGroup(
    ownerId: string,
    body: Record<string, unknown>,
  ): Promise<{ id: string; memberCount: number; myRole: string | null; muted: boolean }> {
    const res = await inject(await token(ownerId), "POST", "/v1/groups", body)
    expect(res.statusCode).toBe(201)
    return res.json()
  }

  /** Owner + admin + member fixture: owner creates, invites both, promotes one to admin. */
  async function groupWithAdminAndMember(): Promise<{
    groupId: string
    ownerId: string
    adminId: string
    memberId: string
  }> {
    const ownerId = await newUser("G Owner")
    const adminId = await newUser("G Admin")
    const memberId = await newUser("G Member")
    const dto = await newGroup(ownerId, { name: "Crew", memberIds: [adminId, memberId] })
    const promote = await inject(
      await token(ownerId),
      "PUT",
      `/v1/groups/${dto.id}/members/${adminId}/role`,
      { role: "admin" },
    )
    expect(promote.statusCode).toBe(200)
    return { groupId: dto.id, ownerId, adminId, memberId }
  }

  describe("POST /groups (create)", () => {
    it("seeds owner + members; skips self, dupes, and blocked-either-way pairs; finalizes the avatar", async () => {
      const ownerId = await newUser("Create Owner")
      const aId = await newUser("Create A")
      const bId = await newUser("Create B")
      const blockedId = await newUser("Create Blocked")
      // The BLOCKED user blocked the creator (either-way suppression).
      await h.sql`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (${blockedId}, ${ownerId})`
      // A published avatar upload for avatarUploadId -> avatar_media_id finalize. The worker's
      // processed bytes live at served_key, which is what the group DTO hands out.
      const uploadId = randomUUID()
      const avatar = await seedMediaAsset(h.sql, {
        uploadId,
        r2Key: `avatars/${uploadId}`,
        status: "ready",
        purpose: "report",
        width: 64,
        height: 64,
      })

      const dto = await inject(await token(ownerId), "POST", "/v1/groups", {
        name: "Block Party",
        description: "hello",
        visibility: "private",
        avatarUploadId: uploadId,
        // self + a dupe + a blocked pair, all silently skipped.
        memberIds: [aId, bId, aId, ownerId, blockedId],
      }).then((r) => {
        expect(r.statusCode).toBe(201)
        return r.json()
      })

      expect(dto.myRole).toBe("owner")
      expect(dto.muted).toBe(false)
      expect(dto.memberCount).toBe(3) // owner + a + b (blocked/self/dupe skipped)
      expect(dto.avatar).toMatchObject({ url: `memory://${avatar.servedKey}` })

      const members = await inject(await token(ownerId), "GET", `/v1/groups/${dto.id}/members`)
      expect(members.statusCode).toBe(200)
      const roster = members.json().members as Array<{ user: { id: string }; role: string }>
      // Documented ordering: owner first, then members by joined_at.
      expect(roster[0]).toMatchObject({ user: { id: ownerId }, role: "owner" })
      const ids = roster.map((m) => m.user.id)
      expect(ids).toHaveLength(3)
      expect(ids).toContain(aId)
      expect(ids).toContain(bId)
      expect(ids).not.toContain(blockedId)
    })
  })

  describe("GET /groups/:id (read gates)", () => {
    it("private: non-member 403 not_a_member; member 200 with myRole", async () => {
      const ownerId = await newUser("Priv Owner")
      const memberId = await newUser("Priv Member")
      const strangerId = await newUser("Priv Stranger")
      const dto = await newGroup(ownerId, { name: "Private Room", memberIds: [memberId] })

      const denied = await inject(await token(strangerId), "GET", `/v1/groups/${dto.id}`)
      expect(denied.statusCode).toBe(403)
      expect(denied.json().fields).toMatchObject({ code: "not_a_member" })

      const ok = await inject(await token(memberId), "GET", `/v1/groups/${dto.id}`)
      expect(ok.statusCode).toBe(200)
      expect(ok.json()).toMatchObject({ id: dto.id, myRole: "member", muted: false })
    })

    it("public: non-member 200 with myRole null (viewable pre-join)", async () => {
      const ownerId = await newUser("Pub Owner")
      const strangerId = await newUser("Pub Stranger")
      const dto = await newGroup(ownerId, { name: "Town Square", visibility: "public" })

      const res = await inject(await token(strangerId), "GET", `/v1/groups/${dto.id}`)
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.myRole ?? null).toBeNull()
      expect(body.visibility).toBe("public")
    })
  })

  describe("PATCH /groups/:id (update)", () => {
    it("admin updates name 200; member 403 update_forbidden", async () => {
      const { groupId, adminId, memberId } = await groupWithAdminAndMember()

      const ok = await inject(await token(adminId), "PATCH", `/v1/groups/${groupId}`, {
        name: "Crew v2",
      })
      expect(ok.statusCode).toBe(200)
      expect(ok.json().name).toBe("Crew v2")
      // UI contract: the update response always carries the caller's myRole (cache seeding).
      expect(ok.json().myRole).toBe("admin")

      const denied = await inject(await token(memberId), "PATCH", `/v1/groups/${groupId}`, {
        name: "Nope",
      })
      expect(denied.statusCode).toBe(403)
      expect(denied.json().fields).toMatchObject({ code: "update_forbidden" })
    })

    it("visibility change: admin 403 visibility_owner_only; owner 200", async () => {
      const { groupId, ownerId, adminId } = await groupWithAdminAndMember()

      const denied = await inject(await token(adminId), "PATCH", `/v1/groups/${groupId}`, {
        visibility: "public",
      })
      expect(denied.statusCode).toBe(403)
      expect(denied.json().fields).toMatchObject({ code: "visibility_owner_only" })

      const ok = await inject(await token(ownerId), "PATCH", `/v1/groups/${groupId}`, {
        visibility: "public",
      })
      expect(ok.statusCode).toBe(200)
      expect(ok.json().visibility).toBe("public")
    })
  })

  describe("PUT /groups/:id/members/:userId/role", () => {
    it("owner sets member->admin 200; an admin 403 role_owner_only", async () => {
      const { groupId, ownerId, adminId, memberId } = await groupWithAdminAndMember()

      const denied = await inject(
        await token(adminId),
        "PUT",
        `/v1/groups/${groupId}/members/${memberId}/role`,
        { role: "admin" },
      )
      expect(denied.statusCode).toBe(403)
      expect(denied.json().fields).toMatchObject({ code: "role_owner_only" })

      const ok = await inject(
        await token(ownerId),
        "PUT",
        `/v1/groups/${groupId}/members/${memberId}/role`,
        { role: "admin" },
      )
      expect(ok.statusCode).toBe(200)
      expect(ok.json()).toMatchObject({ user: { id: memberId }, role: "admin" })
    })
  })

  describe("DELETE /groups/:id/members/:userId (remove / leave)", () => {
    it("self-remove = leave 200; the owner's leave 409s owner_must_stay", async () => {
      const { groupId, ownerId, memberId } = await groupWithAdminAndMember()

      const left = await inject(
        await token(memberId),
        "DELETE",
        `/v1/groups/${groupId}/members/${memberId}`,
      )
      expect(left.statusCode).toBe(200)
      expect(left.json()).toEqual({ ok: true })
      // Gone: the private room now 403s them.
      const after = await inject(await token(memberId), "GET", `/v1/groups/${groupId}`)
      expect(after.statusCode).toBe(403)

      const ownerLeave = await inject(
        await token(ownerId),
        "DELETE",
        `/v1/groups/${groupId}/members/${ownerId}`,
      )
      expect(ownerLeave.statusCode).toBe(409)
      expect(ownerLeave.json().fields).toMatchObject({ code: "owner_must_stay" })
    })

    it("a STRANGER removing someone from a private group gets 403, never a membership-oracle 404", async () => {
      const { groupId, memberId } = await groupWithAdminAndMember()
      const strangerId = await newUser("Remove Stranger")
      const nonMemberId = await newUser("Remove Nobody")

      // Target IS a member: the stranger must not learn that — 403, not a role-specific error.
      const onMember = await inject(
        await token(strangerId),
        "DELETE",
        `/v1/groups/${groupId}/members/${memberId}`,
      )
      expect(onMember.statusCode).toBe(403)
      expect(onMember.json().fields).toMatchObject({ code: "remove_forbidden" })

      // Target is NOT a member: the response must be indistinguishable from the member case.
      const onNonMember = await inject(
        await token(strangerId),
        "DELETE",
        `/v1/groups/${groupId}/members/${nonMemberId}`,
      )
      expect(onNonMember.statusCode).toBe(403)
      expect(onNonMember.json().fields).toMatchObject({ code: "remove_forbidden" })
    })

    it("owner removes an admin 200; an admin removing an admin 403 remove_forbidden", async () => {
      const { groupId, ownerId, adminId, memberId } = await groupWithAdminAndMember()
      // Promote the member so there are two admins.
      await inject(await token(ownerId), "PUT", `/v1/groups/${groupId}/members/${memberId}/role`, {
        role: "admin",
      })

      const denied = await inject(
        await token(adminId),
        "DELETE",
        `/v1/groups/${groupId}/members/${memberId}`,
      )
      expect(denied.statusCode).toBe(403)
      expect(denied.json().fields).toMatchObject({ code: "remove_forbidden" })

      const ok = await inject(
        await token(ownerId),
        "DELETE",
        `/v1/groups/${groupId}/members/${adminId}`,
      )
      expect(ok.statusCode).toBe(200)
    })
  })

  describe("POST /groups/:id/members (add)", () => {
    it("member 403 add_members_forbidden; owner adds (dupes skipped) and gets the refreshed page", async () => {
      const { groupId, ownerId, memberId } = await groupWithAdminAndMember()
      const newbieId = await newUser("Add Newbie")

      const denied = await inject(await token(memberId), "POST", `/v1/groups/${groupId}/members`, {
        memberIds: [newbieId],
      })
      expect(denied.statusCode).toBe(403)
      expect(denied.json().fields).toMatchObject({ code: "add_members_forbidden" })

      const ok = await inject(await token(ownerId), "POST", `/v1/groups/${groupId}/members`, {
        // memberId is already in the room: the dupe is silently skipped.
        memberIds: [newbieId, memberId],
      })
      expect(ok.statusCode).toBe(200)
      const roster = ok.json().members as Array<{ user: { id: string }; role: string }>
      expect(roster.map((m) => m.user.id)).toContain(newbieId)
      expect(roster).toHaveLength(4) // owner + admin + member + newbie
    })

    it("an UNKNOWN uuid and a blocked pair are silently skipped (200, no FK 500)", async () => {
      const { groupId, ownerId } = await groupWithAdminAndMember()
      const newbieId = await newUser("Add Real")
      const blockedId = await newUser("Add Blocked")
      await h.sql`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (${ownerId}, ${blockedId})`
      const unknownId = randomUUID() // schema-valid, no users row — must not trip the membership FK

      const res = await inject(await token(ownerId), "POST", `/v1/groups/${groupId}/members`, {
        memberIds: [unknownId, blockedId, newbieId],
      })
      expect(res.statusCode).toBe(200)
      const ids = (res.json().members as Array<{ user: { id: string } }>).map((m) => m.user.id)
      expect(ids).toContain(newbieId)
      expect(ids).not.toContain(unknownId)
      expect(ids).not.toContain(blockedId)
      expect(ids).toHaveLength(4) // owner + admin + member + newbie
    })
  })

  describe("GET /groups/:id/members (keyset pagination)", () => {
    it("pages in the documented ordering and resumes at the cursor without dupes or gaps", async () => {
      const ownerId = await newUser("Page Owner")
      const invitees: string[] = []
      for (let i = 0; i < 5; i++) invitees.push(await newUser(`Page Member ${i}`))
      const dto = await newGroup(ownerId, { name: "Big Room", memberIds: invitees })

      const tok = await token(ownerId)
      const page1 = await inject(tok, "GET", `/v1/groups/${dto.id}/members?limit=3`)
      expect(page1.statusCode).toBe(200)
      const p1 = page1.json() as {
        members: Array<{ user: { id: string }; role: string }>
        nextCursor: string | null
      }
      expect(p1.members).toHaveLength(3)
      // Ordering: owner first, then members by joined_at ASC (insertion order within the create tx).
      expect(p1.members[0]).toMatchObject({ user: { id: ownerId }, role: "owner" })
      expect(p1.nextCursor).toBe(p1.members[2]!.user.id)

      const page2 = await inject(tok, "GET", `/v1/groups/${dto.id}/members?limit=3&cursor=${p1.nextCursor}`)
      expect(page2.statusCode).toBe(200)
      const p2 = page2.json() as {
        members: Array<{ user: { id: string } }>
        nextCursor: string | null
      }
      expect(p2.members).toHaveLength(3)
      expect(p2.nextCursor).toBeNull()

      // Resume correctness: the two pages tile the full roster exactly — no dupes, no gaps.
      const seen = [...p1.members, ...p2.members].map((m) => m.user.id)
      expect(new Set(seen).size).toBe(6)
      expect(seen.sort()).toEqual([ownerId, ...invitees].sort())
    })
  })

  describe("GET /groups/:id/messages (history)", () => {
    it("member 200 with items + pins on the initial page; non-member 403 (private)", async () => {
      const { groupId, ownerId, adminId, memberId } = await groupWithAdminAndMember()
      const strangerId = await newUser("Hist Stranger")
      const repo = chat()
      const m1 = await repo.insertMessage(
        { cleanupId: groupId, roomKind: "group", userId: memberId, body: "first" },
        randomUUID(),
      )
      await repo.insertMessage(
        { cleanupId: groupId, roomKind: "group", userId: ownerId, body: "second" },
        randomUUID(),
      )
      await repo.setGroupPinned(groupId, m1.id, adminId, true)

      const denied = await inject(await token(strangerId), "GET", `/v1/groups/${groupId}/messages`)
      expect(denied.statusCode).toBe(403)

      const ok = await inject(await token(memberId), "GET", `/v1/groups/${groupId}/messages`)
      expect(ok.statusCode).toBe(200)
      const body = ok.json()
      expect(body.items.map((m: { body: string }) => m.body)).toEqual(["second", "first"])
      expect(body.items[1]).toMatchObject({ id: m1.id, roomKind: "group", mine: true })
      expect((body.pins as Array<{ id: string }>).map((p) => p.id)).toEqual([m1.id])
    })
  })

  describe("DELETE /groups/:id/messages/:messageId", () => {
    it("sender self-deletes 200; admin tombstones a member's message 200; member-on-other 403", async () => {
      const { groupId, ownerId, adminId, memberId } = await groupWithAdminAndMember()
      const repo = chat()
      const mine = await repo.insertMessage(
        { cleanupId: groupId, roomKind: "group", userId: memberId, body: "my own" },
        randomUUID(),
      )
      const ownersMsg = await repo.insertMessage(
        { cleanupId: groupId, roomKind: "group", userId: ownerId, body: "owner words" },
        randomUUID(),
      )
      const target = await repo.insertMessage(
        { cleanupId: groupId, roomKind: "group", userId: memberId, body: "rule-breaking" },
        randomUUID(),
      )

      const self = await inject(
        await token(memberId),
        "DELETE",
        `/v1/groups/${groupId}/messages/${mine.id}`,
      )
      expect(self.statusCode).toBe(200)
      expect(self.json().deletedAt).toBeTruthy()

      const memberOnOther = await inject(
        await token(memberId),
        "DELETE",
        `/v1/groups/${groupId}/messages/${ownersMsg.id}`,
      )
      expect(memberOnOther.statusCode).toBe(403)
      expect(await repo.findGroupMessage(groupId, ownersMsg.id, ownerId)).not.toBeNull()

      const adminOnMember = await inject(
        await token(adminId),
        "DELETE",
        `/v1/groups/${groupId}/messages/${target.id}`,
      )
      expect(adminOnMember.statusCode).toBe(200)
      const dto = adminOnMember.json()
      expect(dto.deletedAt).toBeTruthy()
      expect(dto.mine).toBe(false) // the moderator is not the author
    })
  })

  describe("PUT /messages/pin roomKind:group (resolver lane)", () => {
    it("admin pins 200; member 403 pin_forbidden", async () => {
      const { groupId, adminId, memberId } = await groupWithAdminAndMember()
      const msg = await chat().insertMessage(
        { cleanupId: groupId, roomKind: "group", userId: memberId, body: "pin me" },
        randomUUID(),
      )

      const denied = await inject(await token(memberId), "PUT", "/v1/messages/pin", {
        roomKind: "group",
        roomId: groupId,
        messageId: msg.id,
        pinned: true,
      })
      expect(denied.statusCode).toBe(403)
      expect(denied.json().fields).toMatchObject({ code: "pin_forbidden" })

      const ok = await inject(await token(adminId), "PUT", "/v1/messages/pin", {
        roomKind: "group",
        roomId: groupId,
        messageId: msg.id,
        pinned: true,
      })
      expect(ok.statusCode).toBe(200)
      expect(ok.json().pinnedAt).toBeTruthy()
    })
  })
})
