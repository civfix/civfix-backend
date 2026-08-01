import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { PgUserStore } from "../../src/auth/pg-stores.js"
import { makeChatGroupRepository } from "../../src/services/chat-group-repository.drizzle.js"
import { resolveAvatarMediaOrThrow } from "../../src/services/avatar-media.js"
import type { PresignMedia } from "../../src/services/media-presign.js"

const pg = await withPg()

const fakePresign: PresignMedia = (r2Key, thumbKey) =>
  Promise.resolve({
    url: `memory://${r2Key}`,
    ...(thumbKey !== null ? { thumbUrl: `memory://${thumbKey}` } : {}),
  })

interface SeedOptions {
  status?: string
  kind?: string
  reportId?: string
  postId?: string
  chatMessageId?: string
}

describe.skipIf(!pg)("CVX-004 avatar media validation (integration)", () => {
  const h = pg as PgHarness

  afterAll(async () => {
    await h.teardown()
  })

  async function seedMedia(
    over: SeedOptions = {},
  ): Promise<{ id: string; uploadId: string; r2Key: string }> {
    const uploadId = randomUUID()
    const r2Key = `uploads/2026/01/${uploadId}`
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO media_assets (
        upload_id, kind, r2_key, status, byte_size, report_id, post_id, chat_message_id
      )
      VALUES (
        ${uploadId}, ${over.kind ?? "image"}, ${r2Key}, ${over.status ?? "ready"}, 1024,
        ${over.reportId ?? null}, ${over.postId ?? null}, ${over.chatMessageId ?? null}
      )
      RETURNING id
    `
    return { id: row!.id, uploadId, r2Key }
  }

  async function seedForeignReport(): Promise<string> {
    const users = new PgUserStore(h.db)
    const reporter = await users.create(`report.owner.${randomUUID()}@example.com`, {
      displayName: "Report Owner",
    })
    const [report] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (
        reporter_user_id, idempotency_key, geom, geom_source, category, type, status, h3_cell
      )
      VALUES (
        ${reporter.id}, ${randomUUID()},
        ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'dump', 'submitted', 'h0'
      )
      RETURNING id
    `
    return report!.id
  }

  async function seedForeignPost(): Promise<string> {
    const users = new PgUserStore(h.db)
    const owner = await users.create(`post.owner.${randomUUID()}@example.com`, {
      displayName: "Post Owner",
    })
    const [post] = await h.sql<{ id: string }[]>`
      INSERT INTO posts (author_id, kind, body) VALUES (${owner.id}, 'post', 'has a photo') RETURNING id
    `
    return post!.id
  }

  const rejects422 = { httpStatus: 422, code: "VALIDATION" }

  describe("resolveAvatarMediaOrThrow gate", () => {
    it("resolves a ready, unbound image to {id, r2Key}", async () => {
      const media = await seedMedia()
      const ref = await resolveAvatarMediaOrThrow(h.sql, media.uploadId)
      expect(ref).toEqual({ id: media.id, r2Key: media.r2Key })
    })

    it("rejects a nonexistent uploadId (422)", async () => {
      await expect(resolveAvatarMediaOrThrow(h.sql, randomUUID())).rejects.toMatchObject(rejects422)
    })

    it("rejects a rejected upload (moderation cannot be laundered)", async () => {
      const media = await seedMedia({ status: "rejected" })
      await expect(resolveAvatarMediaOrThrow(h.sql, media.uploadId)).rejects.toMatchObject(rejects422)
    })

    it("rejects a still-validating (unfinalized) upload", async () => {
      const media = await seedMedia({ status: "validating" })
      await expect(resolveAvatarMediaOrThrow(h.sql, media.uploadId)).rejects.toMatchObject(rejects422)
    })

    it("rejects a non-image (video) upload", async () => {
      const media = await seedMedia({ kind: "video" })
      await expect(resolveAvatarMediaOrThrow(h.sql, media.uploadId)).rejects.toMatchObject(rejects422)
    })

    it("rejects media bound to a chat/DM message (another user's private attachment)", async () => {
      const media = await seedMedia({ chatMessageId: randomUUID() })
      await expect(resolveAvatarMediaOrThrow(h.sql, media.uploadId)).rejects.toMatchObject(rejects422)
    })

    it("rejects media bound to another user's post", async () => {
      const postId = await seedForeignPost()
      const media = await seedMedia({ postId })
      await expect(resolveAvatarMediaOrThrow(h.sql, media.uploadId)).rejects.toMatchObject(rejects422)
    })

    it("rejects media bound to another user's report", async () => {
      const reportId = await seedForeignReport()
      const media = await seedMedia({ reportId })
      await expect(resolveAvatarMediaOrThrow(h.sql, media.uploadId)).rejects.toMatchObject(rejects422)
    })
  })

  describe("profile avatar (PgUserStore.updateProfile)", () => {
    async function makeUser(): Promise<{ store: PgUserStore; id: string; handle: string }> {
      const store = new PgUserStore(h.db)
      const user = await store.create(`avatar.user.${randomUUID()}@example.com`, {
        displayName: "Avatar User",
      })
      return { store, id: user.id, handle: user.handle ?? `u_${randomUUID().slice(0, 8)}` }
    }

    async function avatarMediaIdOf(userId: string): Promise<string | null> {
      const [row] = await h.sql<{ avatar_media_id: string | null }[]>`
        SELECT avatar_media_id FROM users WHERE id = ${userId}
      `
      return row!.avatar_media_id
    }

    it("accepts a ready, unbound image and canonicalizes avatar_url", async () => {
      const { store, id, handle } = await makeUser()
      const media = await seedMedia()
      const updated = await store.updateProfile(id, {
        handle,
        displayName: "Avatar User",
        avatarUploadId: media.uploadId,
        presignAvatar: (key) => Promise.resolve(`https://cdn.example.test/${key}`),
      })
      expect(updated.avatarUrl).toBe(`https://cdn.example.test/${media.r2Key}`)
      expect(await avatarMediaIdOf(id)).toBe(media.id)
    })

    it("rejects a nonexistent uploadId and leaves the avatar untouched", async () => {
      const { store, id, handle } = await makeUser()
      await expect(
        store.updateProfile(id, { handle, displayName: "Avatar User", avatarUploadId: randomUUID() }),
      ).rejects.toMatchObject(rejects422)
      expect(await avatarMediaIdOf(id)).toBeNull()
    })

    it("rejects a rejected upload", async () => {
      const { store, id, handle } = await makeUser()
      const media = await seedMedia({ status: "rejected" })
      await expect(
        store.updateProfile(id, {
          handle,
          displayName: "Avatar User",
          avatarUploadId: media.uploadId,
        }),
      ).rejects.toMatchObject(rejects422)
      expect(await avatarMediaIdOf(id)).toBeNull()
    })

    it("rejects a still-validating upload", async () => {
      const { store, id, handle } = await makeUser()
      const media = await seedMedia({ status: "validating" })
      await expect(
        store.updateProfile(id, {
          handle,
          displayName: "Avatar User",
          avatarUploadId: media.uploadId,
        }),
      ).rejects.toMatchObject(rejects422)
      expect(await avatarMediaIdOf(id)).toBeNull()
    })

    it("rejects a foreign user's private (chat-bound) media", async () => {
      const { store, id, handle } = await makeUser()
      const media = await seedMedia({ chatMessageId: randomUUID() })
      await expect(
        store.updateProfile(id, {
          handle,
          displayName: "Avatar User",
          avatarUploadId: media.uploadId,
        }),
      ).rejects.toMatchObject(rejects422)
      expect(await avatarMediaIdOf(id)).toBeNull()
    })

    it("rejects another user's report-bound media", async () => {
      const { store, id, handle } = await makeUser()
      const reportId = await seedForeignReport()
      const media = await seedMedia({ reportId })
      await expect(
        store.updateProfile(id, {
          handle,
          displayName: "Avatar User",
          avatarUploadId: media.uploadId,
        }),
      ).rejects.toMatchObject(rejects422)
      expect(await avatarMediaIdOf(id)).toBeNull()
    })
  })

  describe("group avatar (findMediaIdByUploadId)", () => {
    const groups = () => makeChatGroupRepository(h.sql, fakePresign)

    it("resolves a ready, unbound image to its media id", async () => {
      const media = await seedMedia()
      expect(await groups().findMediaIdByUploadId(media.uploadId)).toBe(media.id)
    })

    it("rejects a nonexistent uploadId (422)", async () => {
      await expect(groups().findMediaIdByUploadId(randomUUID())).rejects.toMatchObject(rejects422)
    })

    it("rejects a rejected upload", async () => {
      const media = await seedMedia({ status: "rejected" })
      await expect(groups().findMediaIdByUploadId(media.uploadId)).rejects.toMatchObject(rejects422)
    })

    it("rejects a still-validating upload", async () => {
      const media = await seedMedia({ status: "validating" })
      await expect(groups().findMediaIdByUploadId(media.uploadId)).rejects.toMatchObject(rejects422)
    })

    it("rejects a foreign user's private (chat-bound) media", async () => {
      const media = await seedMedia({ chatMessageId: randomUUID() })
      await expect(groups().findMediaIdByUploadId(media.uploadId)).rejects.toMatchObject(rejects422)
    })

    it("rejects another user's report-bound media", async () => {
      const reportId = await seedForeignReport()
      const media = await seedMedia({ reportId })
      await expect(groups().findMediaIdByUploadId(media.uploadId)).rejects.toMatchObject(rejects422)
    })
  })
})
