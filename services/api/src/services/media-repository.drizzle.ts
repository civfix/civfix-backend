import { and, eq, isNull, sql } from "drizzle-orm"
import { mediaAssets } from "../db/schema/media.js"
import type { Db } from "../db/client.js"
import type { MediaAssetView, MediaRepository, NewMediaAsset } from "./media-repository.js"

function toView(row: typeof mediaAssets.$inferSelect): MediaAssetView {
  return {
    id: row.id,
    uploadId: row.uploadId,
    kind: row.kind,
    codec: row.codec,
    r2Key: row.r2Key,
    servedKey: row.servedKey,
    thumbKey: row.thumbKey,
    status: row.status,
    width: row.width,
    height: row.height,
    byteSize: row.byteSize,
    purpose: row.purpose,
    reportId: row.reportId,
    chatMessageId: row.chatMessageId,
    postId: row.postId,
    finalizedAt: row.finalizedAt,
    createdAt: row.createdAt,
    uploader: row.uploader,
  }
}

export function makeDrizzleMediaRepository(db: Db): MediaRepository {
  return {
    async insert(row: NewMediaAsset): Promise<void> {
      await db.insert(mediaAssets).values({
        id: row.id,
        uploadId: row.uploadId,
        kind: row.kind,
        r2Key: row.r2Key,
        status: row.status,
        byteSize: row.byteSize,
        uploader: row.uploader,
      })
    },

    async findByUploadId(uploadId: string): Promise<MediaAssetView | null> {
      const rows = await db
        .select()
        .from(mediaAssets)
        .where(eq(mediaAssets.uploadId, uploadId))
        .limit(1)
      const row = rows[0]
      return row ? toView(row) : null
    },

    async findById(id: string): Promise<MediaAssetView | null> {
      const rows = await db.select().from(mediaAssets).where(eq(mediaAssets.id, id)).limit(1)
      const row = rows[0]
      return row ? toView(row) : null
    },

    async markFinalized(
      uploadId: string,
      uploadEtag: string | null,
    ): Promise<MediaAssetView | null> {
      const rows = await db
        .update(mediaAssets)
        .set({ finalizedAt: sql`now()`, uploadEtag })
        .where(and(eq(mediaAssets.uploadId, uploadId), isNull(mediaAssets.finalizedAt)))
        .returning()
      const row = rows[0]
      return row ? toView(row) : null
    },
  }
}
