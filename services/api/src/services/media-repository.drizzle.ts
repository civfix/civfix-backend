
import { and, eq } from "drizzle-orm"
import { mediaAssets } from "../db/schema/media.js"
import type { Db } from "../db/client.js"
import type {
  MediaAssetView,
  MediaRepository,
  NewMediaAsset,
} from "./media-intake-service.js"
import type { MediaStatus } from "@civfix/shared"

function toView(row: typeof mediaAssets.$inferSelect): MediaAssetView {
  return {
    id: row.id,
    uploadId: row.uploadId,
    kind: row.kind,
    codec: row.codec,
    r2Key: row.r2Key,
    thumbKey: row.thumbKey,
    status: row.status,
    width: row.width,
    height: row.height,
    byteSize: row.byteSize,
    purpose: row.purpose,
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

    async setStatusByUploadId(
      uploadId: string,
      status: MediaStatus,
      expectedStatus?: MediaStatus,
    ): Promise<MediaAssetView | null> {
      const predicate =
        expectedStatus === undefined
          ? eq(mediaAssets.uploadId, uploadId)
          : and(eq(mediaAssets.uploadId, uploadId), eq(mediaAssets.status, expectedStatus))
      const rows = await db.update(mediaAssets).set({ status }).where(predicate).returning()
      const row = rows[0]
      return row ? toView(row) : null
    },
  }
}
