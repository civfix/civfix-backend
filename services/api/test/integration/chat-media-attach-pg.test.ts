
import { TEST_TICKET_SIGNER } from "../helpers/ticket-signer.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedMediaAsset } from "../helpers/media-pg.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { makeDrizzleChatRepository } from "../../src/services/chat-repository.drizzle.js"
import { makeCleanupService } from "../../src/services/cleanup-service.js"
import type { PresignMedia } from "../../src/services/media-presign.js"

const pg = await withPg()

const fakePresign: PresignMedia = (r2Key, thumbKey) =>
  Promise.resolve({
    url: `https://cdn.test/${r2Key}`,
    ...(thumbKey !== null ? { thumbUrl: `https://cdn.test/${thumbKey}` } : {}),
  })

describe.skipIf(!pg)("chat media attach (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id
    `
    return u!.id
  }

  async function newReadyUpload(): Promise<string> {
    const uploadId = randomUUID()
    const media = await seedMediaAsset(h.sql, {
      uploadId,
      r2Key: `k/${uploadId}`,
      status: "ready",
      byteSize: 1024,
    })
    return media.uploadId
  }

  async function newCleanup(organizerId: string): Promise<string> {
    const service = makeCleanupService({
      tickets: TEST_TICKET_SIGNER,
      repo: makeDrizzleCleanupRepository(h.sql),
    })
    const dto = await service.createCleanup(
      {
        title: "Media sweep",
        type: "site",
        eventKind: "cleanup",
        lat: 34.05,
        lng: -118.25,
        scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        slots: [{ title: "General volunteers", capacity: null }],
      },
      organizerId,
    )
    return dto.id
  }

  it("F017/F072: a media-bearing send persists and stamps chat_message_id + chat_message_created_at", async () => {
    const organizerId = await newUser("Media Org")
    const cleanupId = await newCleanup(organizerId)
    const uploadId = await newReadyUpload()

    const chatRepo = makeDrizzleChatRepository(h.sql, fakePresign)
    const messageId = randomUUID()
    const dto = await chatRepo.insertMessage(
      { cleanupId, userId: organizerId, body: "photo", mediaUploadIds: [uploadId] },
      messageId,
    )
    expect(dto.attachments).toHaveLength(1)

    const [row] = await h.sql<{ chat_message_id: string | null; chat_message_created_at: Date | null }[]>`
      SELECT chat_message_id, chat_message_created_at FROM media_assets WHERE upload_id = ${uploadId}
    `
    expect(row!.chat_message_id).toBe(messageId)
    expect(row!.chat_message_created_at).not.toBeNull()
  })

  it("F017: an already-claimed upload is not re-claimed by a different message (claim exactly once)", async () => {
    const organizerId = await newUser("Media Once")
    const cleanupId = await newCleanup(organizerId)
    const uploadId = await newReadyUpload()

    const chatRepo = makeDrizzleChatRepository(h.sql, fakePresign)
    const firstId = randomUUID()
    await chatRepo.insertMessage(
      { cleanupId, userId: organizerId, body: "first", mediaUploadIds: [uploadId] },
      firstId,
    )

    const secondId = randomUUID()
    const second = await chatRepo.insertMessage(
      { cleanupId, userId: organizerId, body: "second", mediaUploadIds: [uploadId] },
      secondId,
    )
    expect(second.attachments ?? []).toHaveLength(0)

    const [row] = await h.sql<{ chat_message_id: string | null }[]>`
      SELECT chat_message_id FROM media_assets WHERE upload_id = ${uploadId}
    `
    expect(row!.chat_message_id).toBe(firstId)
  })

  it("F087e: a VALIDATING upload attaches only once finalize has stamped the watermark", async () => {
    const organizerId = await newUser("Media Finalize")
    const cleanupId = await newCleanup(organizerId)

    // Presigned but never finalized: no bytes, no media.checks job. Attaching it would bind the row
    // (hiding it from the orphan sweep) while its NULL watermark keeps it out of the stuck sweep too.
    const uploadId = randomUUID()
    await seedMediaAsset(h.sql, {
      uploadId,
      r2Key: `k/${uploadId}`,
      status: "validating",
      byteSize: 1024,
    })

    const chatRepo = makeDrizzleChatRepository(h.sql, fakePresign)
    const refused = await chatRepo.insertMessage(
      { cleanupId, userId: organizerId, body: "too early", mediaUploadIds: [uploadId] },
      randomUUID(),
    )
    expect(refused.attachments ?? []).toHaveLength(0)
    const [unbound] = await h.sql<{ chat_message_id: string | null }[]>`
      SELECT chat_message_id FROM media_assets WHERE upload_id = ${uploadId}
    `
    expect(unbound!.chat_message_id).toBeNull()

    // Finalized (still validating, still in the pipeline) -> attachable, exactly as before.
    await h.sql`UPDATE media_assets SET finalized_at = now() WHERE upload_id = ${uploadId}`
    const messageId = randomUUID()
    await chatRepo.insertMessage(
      { cleanupId, userId: organizerId, body: "now ok", mediaUploadIds: [uploadId] },
      messageId,
    )
    const [bound] = await h.sql<{ chat_message_id: string | null }[]>`
      SELECT chat_message_id FROM media_assets WHERE upload_id = ${uploadId}
    `
    expect(bound!.chat_message_id).toBe(messageId)
  })
})
