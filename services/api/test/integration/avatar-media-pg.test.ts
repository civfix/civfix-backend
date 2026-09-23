import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedMediaAsset, type SeededMedia } from "../helpers/media-pg.js"
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
  status?: "validating" | "ready" | "rejected" | "held"
  kind?: "image" | "video"
  reportId?: string
  postId?: string
  chatMessageId?: string
  purpose?: string
  ageHours?: number
  servedKey?: string | null
  finalizedAt?: Date | null
}

describe.skipIf(!pg)("CVX-004 avatar media validation (integration)", () => {
  const h = pg as PgHarness

  afterAll(async () => {
    await h.teardown()
  })

  async function seedMedia(over: SeedOptions = {}): Promise<SeededMedia> {
    return await seedMediaAsset(h.sql, {
      kind: over.kind ?? "image",
      status: over.status ?? "ready",
      byteSize: 1024,
      reportId: over.reportId ?? null,
      postId: over.postId ?? null,
      chatMessageId: over.chatMessageId ?? null,
      purpose: over.purpose ?? "report",
      createdAt: new Date(Date.now() - (over.ageHours ?? 0) * 3_600_000),
      ...(over.servedKey !== undefined ? { servedKey: over.servedKey } : {}),
      ...(over.finalizedAt !== undefined ? { finalizedAt: over.finalizedAt } : {}),
    })
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

  async function seedUser(): Promise<string> {
    const users = new PgUserStore(h.db)
    const user = await users.create(`avatar.holder.${randomUUID()}@example.com`, {
      displayName: "Avatar Holder",
    })
    return user.id
  }

  async function seedGroup(): Promise<string> {
    const ownerId = await seedUser()
    const [group] = await h.sql<{ id: string }[]>`
      INSERT INTO chat_groups (name, owner_id) VALUES ('Avatar Group', ${ownerId}) RETURNING id
    `
    return group!.id
  }

  async function claimUserAvatar(userId: string, mediaId: string): Promise<void> {
    await h.sql`UPDATE users SET avatar_media_id = ${mediaId} WHERE id = ${userId}`
  }

  async function claimGroupAvatar(groupId: string, mediaId: string): Promise<void> {
    await h.sql`UPDATE chat_groups SET avatar_media_id = ${mediaId} WHERE id = ${groupId}`
  }

  const rejects422 = { httpStatus: 422, code: "VALIDATION" }

  describe("resolveAvatarMediaOrThrow gate", () => {
    it("resolves a ready, unbound image to {id, r2Key, servedKey}", async () => {
      const media = await seedMedia()
      const ref = await resolveAvatarMediaOrThrow(h.sql, media.uploadId)
      expect(ref).toEqual({ id: media.id, r2Key: media.servedKey, servedKey: media.servedKey })
    })

    it("resolves a finalized-but-validating upload to its raw key (the bind may race the worker)", async () => {
      const media = await seedMedia({ status: "validating", finalizedAt: new Date() })
      const ref = await resolveAvatarMediaOrThrow(h.sql, media.uploadId)
      expect(ref).toEqual({ id: media.id, r2Key: media.r2Key, servedKey: null })
    })

    it("rejects a nonexistent uploadId (422)", async () => {
      await expect(resolveAvatarMediaOrThrow(h.sql, randomUUID())).rejects.toMatchObject(rejects422)
    })

    it("rejects a rejected upload (moderation cannot be laundered)", async () => {
      const media = await seedMedia({ status: "rejected" })
      await expect(resolveAvatarMediaOrThrow(h.sql, media.uploadId)).rejects.toMatchObject(
        rejects422,
      )
    })

    it("rejects a still-validating (unfinalized) upload", async () => {
      const media = await seedMedia({ status: "validating" })
      await expect(resolveAvatarMediaOrThrow(h.sql, media.uploadId)).rejects.toMatchObject(
        rejects422,
      )
    })

    it("rejects a ready asset the worker never published (served_key still NULL)", async () => {
      const media = await seedMedia({ servedKey: null })
      await expect(resolveAvatarMediaOrThrow(h.sql, media.uploadId)).rejects.toMatchObject(
        rejects422,
      )
    })

    it("rejects a non-image (video) upload", async () => {
      const media = await seedMedia({ kind: "video" })
      await expect(resolveAvatarMediaOrThrow(h.sql, media.uploadId)).rejects.toMatchObject(
        rejects422,
      )
    })

    it("rejects media bound to a chat/DM message (another user's private attachment)", async () => {
      const media = await seedMedia({ chatMessageId: randomUUID() })
      await expect(resolveAvatarMediaOrThrow(h.sql, media.uploadId)).rejects.toMatchObject(
        rejects422,
      )
    })

    it("rejects media bound to another user's post", async () => {
      const postId = await seedForeignPost()
      const media = await seedMedia({ postId })
      await expect(resolveAvatarMediaOrThrow(h.sql, media.uploadId)).rejects.toMatchObject(
        rejects422,
      )
    })

    it("rejects media bound to another user's report", async () => {
      const reportId = await seedForeignReport()
      const media = await seedMedia({ reportId })
      await expect(resolveAvatarMediaOrThrow(h.sql, media.uploadId)).rejects.toMatchObject(
        rejects422,
      )
    })

    it("F074: rejects an upload older than the claim window (a leaked id is not a permanent capability)", async () => {
      const media = await seedMedia({ ageHours: 7 })
      await expect(resolveAvatarMediaOrThrow(h.sql, media.uploadId)).rejects.toMatchObject(
        rejects422,
      )
    })

    it("F074: accepts an upload still inside the claim window", async () => {
      const media = await seedMedia({ ageHours: 5 })
      const ref = await resolveAvatarMediaOrThrow(h.sql, media.uploadId)
      expect(ref).toEqual({ id: media.id, r2Key: media.servedKey, servedKey: media.servedKey })
    })

    it("F074: rejects a verification document (it cannot be laundered into a public avatar)", async () => {
      const media = await seedMedia({ purpose: "verification" })
      await expect(resolveAvatarMediaOrThrow(h.sql, media.uploadId)).rejects.toMatchObject(
        rejects422,
      )
    })

    it("F074: rejects an uploadId already claimed as another user's avatar", async () => {
      const media = await seedMedia()
      const owner = await seedUser()
      await claimUserAvatar(owner, media.id)
      await expect(resolveAvatarMediaOrThrow(h.sql, media.uploadId)).rejects.toMatchObject(
        rejects422,
      )
      const stranger = await seedUser()
      await expect(
        resolveAvatarMediaOrThrow(h.sql, media.uploadId, { userId: stranger }),
      ).rejects.toMatchObject(rejects422)
    })

    it("F074: rejects an uploadId already claimed as a group's avatar", async () => {
      const media = await seedMedia()
      const group = await seedGroup()
      await claimGroupAvatar(group, media.id)
      await expect(resolveAvatarMediaOrThrow(h.sql, media.uploadId)).rejects.toMatchObject(
        rejects422,
      )
      const otherGroup = await seedGroup()
      await expect(
        resolveAvatarMediaOrThrow(h.sql, media.uploadId, { groupId: otherGroup }),
      ).rejects.toMatchObject(rejects422)
    })

    it("F074: the holder may re-apply the avatar it already has (a resubmitted profile save is idempotent)", async () => {
      const media = await seedMedia()
      const owner = await seedUser()
      await claimUserAvatar(owner, media.id)
      const ref = await resolveAvatarMediaOrThrow(h.sql, media.uploadId, { userId: owner })
      expect(ref).toEqual({ id: media.id, r2Key: media.servedKey, servedKey: media.servedKey })
    })

    it("F074: a group may re-apply the avatar it already has", async () => {
      const media = await seedMedia()
      const group = await seedGroup()
      await claimGroupAvatar(group, media.id)
      const ref = await resolveAvatarMediaOrThrow(h.sql, media.uploadId, { groupId: group })
      expect(ref).toEqual({ id: media.id, r2Key: media.servedKey, servedKey: media.servedKey })
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
      expect(updated.avatarUrl).toBe(`https://cdn.example.test/${media.servedKey}`)
      expect(await avatarMediaIdOf(id)).toBe(media.id)
    })

    it("binds a finalized-but-validating upload and leaves avatar_url for the worker to publish", async () => {
      const { store, id, handle } = await makeUser()
      const media = await seedMedia({ status: "validating", finalizedAt: new Date() })
      const updated = await store.updateProfile(id, {
        handle,
        displayName: "Avatar User",
        avatarUploadId: media.uploadId,
        presignAvatar: (key) => Promise.resolve(`https://cdn.example.test/${key}`),
      })
      expect(updated.avatarUrl).toBeNull()
      expect(await avatarMediaIdOf(id)).toBe(media.id)
    })

    it("rejects a nonexistent uploadId and leaves the avatar untouched", async () => {
      const { store, id, handle } = await makeUser()
      await expect(
        store.updateProfile(id, {
          handle,
          displayName: "Avatar User",
          avatarUploadId: randomUUID(),
        }),
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

    it("rejects a still-validating upload that was never finalized", async () => {
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

    it("F074: a second profile save with the SAME avatarUploadId still succeeds", async () => {
      const { store, id, handle } = await makeUser()
      const media = await seedMedia()
      await store.updateProfile(id, {
        handle,
        displayName: "Avatar User",
        avatarUploadId: media.uploadId,
      })
      expect(await avatarMediaIdOf(id)).toBe(media.id)
      const second = await store.updateProfile(id, {
        handle,
        displayName: "Avatar User Renamed",
        avatarUploadId: media.uploadId,
      })
      expect(second.displayName).toBe("Avatar User Renamed")
      expect(await avatarMediaIdOf(id)).toBe(media.id)
    })

    it("F074: another account cannot claim an avatar that is already someone's", async () => {
      const holder = await makeUser()
      const media = await seedMedia()
      await holder.store.updateProfile(holder.id, {
        handle: holder.handle,
        displayName: "Avatar User",
        avatarUploadId: media.uploadId,
      })
      const thief = await makeUser()
      await expect(
        thief.store.updateProfile(thief.id, {
          handle: thief.handle,
          displayName: "Avatar Thief",
          avatarUploadId: media.uploadId,
        }),
      ).rejects.toMatchObject(rejects422)
      expect(await avatarMediaIdOf(thief.id)).toBeNull()
      expect(await avatarMediaIdOf(holder.id)).toBe(media.id)
    })

    it("F074: rejects an upload older than the claim window", async () => {
      const { store, id, handle } = await makeUser()
      const media = await seedMedia({ ageHours: 7 })
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

    it("rejects a still-validating upload that was never finalized", async () => {
      const media = await seedMedia({ status: "validating" })
      await expect(groups().findMediaIdByUploadId(media.uploadId)).rejects.toMatchObject(rejects422)
    })

    it("accepts a finalized-but-validating upload", async () => {
      const media = await seedMedia({ status: "validating", finalizedAt: new Date() })
      expect(await groups().findMediaIdByUploadId(media.uploadId)).toBe(media.id)
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

    it("F074: rejects an avatar another group already holds, and stays idempotent for the holder", async () => {
      const media = await seedMedia()
      const holder = await seedGroup()
      await claimGroupAvatar(holder, media.id)
      await expect(groups().findMediaIdByUploadId(media.uploadId)).rejects.toMatchObject(rejects422)
      expect(await groups().findMediaIdByUploadId(media.uploadId, holder)).toBe(media.id)
    })
  })
})
