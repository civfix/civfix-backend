/**
 * Drizzle-backed MediaRepository (the production implementation of the media-intake persistence seam).
 *
 * ALL media_assets access for the intake service flows through here so the service itself stays
 * infra-free and unit-testable with an in-memory repo. Keeps the orphan-safety contract intact: a
 * created/finalized row leaves report_id null (the worker cron sweeps never-attached orphans later).
 *
 * byte_size is a bigint(mode:number) column; file sizes are well within the 2^53 safe-integer range,
 * so reading it as a number is safe (matches the schema's documented mode).
 */

import { eq } from "drizzle-orm"
import { mediaAssets } from "../db/schema/media.js"
import type { Db } from "../db/client.js"
import type {
  MediaAssetView,
  MediaRepository,
  NewMediaAsset,
} from "./media-intake-service.js"
import type { MediaStatus } from "@civfix/shared"

/** Project a media_assets Drizzle row to the structural view the service consumes. */
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
        // report_id intentionally left null (orphan-safe until a report commits).
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
    ): Promise<MediaAssetView | null> {
      const rows = await db
        .update(mediaAssets)
        .set({ status })
        .where(eq(mediaAssets.uploadId, uploadId))
        .returning()
      const row = rows[0]
      return row ? toView(row) : null
    },
  }
}
