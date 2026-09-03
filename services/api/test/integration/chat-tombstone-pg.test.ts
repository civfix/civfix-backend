import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { ChatMessageDTO } from "@civfix/shared"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { makeDrizzleChatRepository } from "../../src/services/chat-repository.drizzle.js"
import { makeDrizzleDmRepository } from "../../src/services/dm-repository.drizzle.js"
import { recordChatMentions } from "../../src/services/chat-mentions.drizzle.js"
import type { PresignMedia } from "../../src/services/media-presign.js"

const pg = await withPg()

const presign: PresignMedia = (r2Key, thumbKey) =>
  Promise.resolve({
    url: `https://cdn.test/${r2Key}`,
    ...(thumbKey !== null ? { thumbUrl: `https://cdn.test/${thumbKey}` } : {}),
  })

function expectTombstone(m: ChatMessageDTO | undefined): void {
  expect(m, "the deleted anchor must ride in the around window").toBeTruthy()
  const t = m as ChatMessageDTO
  expect(t.deletedAt).toBeTruthy()
  expect(t.body ?? null).toBeNull()
  expect(t.attachments ?? []).toEqual([])
  expect(t.reactions ?? []).toEqual([])
  expect(t.mentions ?? []).toEqual([])
  expect(t.poll ?? null).toBeNull()
  expect(t.editedAt ?? null).toBeNull()
  expect(t.pinnedAt ?? null).toBeNull()
  expect(t.cityMention ?? null).toBeNull()
}

describe.skipIf(!pg)("soft-deleted messages hydrate as tombstones (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  const chat = () => makeDrizzleChatRepository(h.sql, presign)
  const dm = () => makeDrizzleDmRepository(h.sql, presign)

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${testHandle()}) RETURNING id
    `
    return u!.id
  }

  async function newReadyUpload(): Promise<string> {
    const uploadId = randomUUID()
    await h.sql`
      INSERT INTO media_assets (upload_id, kind, r2_key, status, byte_size)
      VALUES (${uploadId}, 'image', ${`k/${uploadId}`}, 'ready', 1024)
    `
    return uploadId
  }

  async function newCleanup(organizerId: string): Promise<string> {
    const [c] = await h.sql<{ id: string }[]>`
      INSERT INTO cleanups (organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (
        ${organizerId}, 'site', 'Tombstone sweep',
        ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326),
        ${new Date(Date.now() + 7 * 86_400_000)}, 'scheduled'
      )
      RETURNING id
    `
    return c!.id
  }

  async function newReport(): Promise<string> {
    const [r] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, h3_cell)
      VALUES (${randomUUID()}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'dump', 'submitted', 'h0')
      RETURNING id
    `
    return r!.id
  }

  async function newGroup(ownerId: string): Promise<string> {
    const [g] = await h.sql<{ id: string }[]>`
      INSERT INTO chat_groups (name, owner_id, kind, visibility)
      VALUES ('Tombstone Room', ${ownerId}, 'group', 'private')
      RETURNING id
    `
    await h.sql`
      INSERT INTO chat_group_members (group_id, user_id, role) VALUES (${g!.id}, ${ownerId}, 'owner')
    `
    return g!.id
  }

  async function seedLoadedMessage(
    roomId: string,
    senderId: string,
    peerId: string,
    roomKind?: "report" | "group",
  ): Promise<string> {
    const repo = chat()
    const uploadId = await newReadyUpload()
    const id = randomUUID()
    const sent = await repo.insertMessage(
      {
        cleanupId: roomId,
        ...(roomKind !== undefined ? { roomKind } : {}),
        userId: senderId,
        body: "doxxing text and a photo",
        mediaUploadIds: [uploadId],
      },
      id,
    )
    expect(sent.attachments).toHaveLength(1)
    await repo.toggleReaction(id, peerId, "heart")
    await recordChatMentions(h.sql, id, [peerId])
    return id
  }

  it("cleanup room: the around anchor leaks no body, attachments, reactions or mentions", async () => {
    const organizerId = await newUser("Tomb Cleanup Org")
    const peerId = await newUser("Tomb Cleanup Peer")
    const cleanupId = await newCleanup(organizerId)
    const repo = chat()
    const victim = await seedLoadedMessage(cleanupId, organizerId, peerId)
    await repo.insertMessage({ cleanupId, userId: organizerId, body: "after" }, randomUUID())

    expect(await repo.editMessage(cleanupId, victim, organizerId, "doxxing text and a photo")).not.toBeNull()
    expect(await repo.setPinned(cleanupId, victim, organizerId, true)).not.toBeNull()

    const live = await repo.history(cleanupId, undefined, 20, peerId, victim)
    const before = live.items.find((m) => m.id === victim)
    expect(before?.editedAt).toBeTruthy()
    expect(before?.pinnedAt).toBeTruthy()
    expect(before?.body).toBe("doxxing text and a photo")
    expect(before?.attachments).toHaveLength(1)
    expect(before?.reactions).toHaveLength(1)
    expect(before?.mentions).toHaveLength(1)

    expect(await repo.softDelete(cleanupId, victim, organizerId)).not.toBeNull()

    const page = await repo.history(cleanupId, undefined, 20, peerId, victim)
    expectTombstone(page.items.find((m) => m.id === victim))
  })

  it("the softDelete response itself is the same tombstone projection", async () => {
    const organizerId = await newUser("Tomb Response Org")
    const peerId = await newUser("Tomb Response Peer")
    const cleanupId = await newCleanup(organizerId)
    const repo = chat()
    const victim = await seedLoadedMessage(cleanupId, organizerId, peerId)

    const deleted = await repo.softDelete(cleanupId, victim, organizerId)
    expectTombstone(deleted ?? undefined)
  })

  it("report room: an UNAUTHENTICATED viewer gets a bare tombstone (reportMessages is auth: optional)", async () => {
    const senderId = await newUser("Tomb Report Sender")
    const peerId = await newUser("Tomb Report Peer")
    const reportId = await newReport()
    const repo = chat()
    const victim = await seedLoadedMessage(reportId, senderId, peerId, "report")
    await repo.insertMessage(
      { cleanupId: reportId, roomKind: "report", userId: senderId, body: "after" },
      randomUUID(),
    )

    expect(await repo.softDeleteReport(reportId, victim, senderId)).not.toBeNull()

    const anon = await repo.reportHistory(reportId, undefined, 20, null, victim)
    expectTombstone(anon.items.find((m) => m.id === victim))
  })

  it("group room: the around anchor is a bare tombstone", async () => {
    const ownerId = await newUser("Tomb Group Owner")
    const peerId = await newUser("Tomb Group Peer")
    const groupId = await newGroup(ownerId)
    const repo = chat()
    const victim = await seedLoadedMessage(groupId, ownerId, peerId, "group")

    expect(await repo.softDeleteGroup(groupId, victim, ownerId)).not.toBeNull()

    const page = await repo.groupHistory(groupId, undefined, 20, ownerId, victim)
    expectTombstone(page.items.find((m) => m.id === victim))
  })

  it("dm thread: an unsent message leaks nothing to the peer's around jump", async () => {
    const a = await newUser("Tomb DM A")
    const b = await newUser("Tomb DM B")
    const repo = dm()
    const thread = await repo.openOrCreateThread(a, b)
    const uploadId = await newReadyUpload()
    const sent = await repo.persist({
      threadId: thread.id,
      senderId: a,
      body: "private photo",
      mediaUploadIds: [uploadId],
    })
    expect(sent.attachments).toHaveLength(1)
    await repo.toggleReaction(sent.id, b, "heart")
    await recordChatMentions(h.sql, sent.id, [b])

    expect(await repo.softDelete(thread.id, sent.id, a)).not.toBeNull()

    const page = await repo.history(thread.id, undefined, 20, b, sent.id)
    expectTombstone(page.items.find((m) => m.id === sent.id))
  })
})
