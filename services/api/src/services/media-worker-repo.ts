/**
 * Media-worker persistence seam (the WRITE half of the media pipeline).
 *
 * The API-side media-intake-service.MediaRepository is intentionally tiny (insert / find / setStatus):
 * the cheap intake path never touches bytes. The WORKER, by contrast, writes back the results of
 * untrusted-byte processing (dimensions, codec, phash, thumb_key, final status), raises abuse_flags,
 * and runs the orphan sweep. That richer surface lives HERE so there is a SINGLE source of truth for
 * media_assets / abuse_flags access shared by the API package and the worker package (the worker imports
 * this via the "@civfix/api/media-repo" export).
 *
 * Everything is expressed as a small structural interface (MediaWorkerRepo) so the worker's pure
 * processing function and its job handlers can be unit-tested with an in-memory fake and NO database.
 * makeDrizzleMediaWorkerRepo is the production implementation over the shared Drizzle client.
 *
 * byte_size is a bigint(mode:number) column; file sizes are well within the 2^53 safe-integer range
 * (MAX_VIDEO_BYTES is 50 MB), so reading/writing it as a number is safe and matches the schema.
 */

import { and, eq, isNull, lt, sql } from "drizzle-orm"
import { mediaAssets } from "../db/schema/media.js"
import { abuseFlags } from "../db/schema/moderation.js"
import type { Db } from "../db/client.js"
import type { MediaKind, MediaStatus } from "@civfix/shared"

/** abuse_flags.reason values the worker raises. Mirrors the shared AbuseReason enum subset. */
export type WorkerAbuseReason = "nsfw" | "phash_dup" | "gps"

/** The media_assets fields the worker reads to decide how to process an asset. */
export interface MediaWorkerAsset {
  id: string
  uploadId: string
  reportId: string | null
  kind: MediaKind
  r2Key: string
  thumbKey: string | null
  status: MediaStatus
  byteSize: number | null
}

/** The processing results the worker writes back onto a media_assets row. */
export interface MediaResultPatch {
  status: MediaStatus
  codec?: string | null
  width?: number | null
  height?: number | null
  phash?: string | null
  thumbKey?: string | null
  /** Re-measured byte size of the processed (stripped/remuxed) object, when known. */
  byteSize?: number | null
}

/** A row to insert into abuse_flags. subjectType is always "media" for the worker. */
export interface NewAbuseFlag {
  subjectId: string
  reason: WorkerAbuseReason
  /** Defaults to "worker". */
  source?: "worker" | "api" | "user_report"
}

/** A never-attached orphan candidate surfaced by the sweep. */
export interface OrphanRow {
  id: string
  r2Key: string
  thumbKey: string | null
}

/**
 * Persistence seam used by the media-worker. Implemented by makeDrizzleMediaWorkerRepo in production
 * and by an in-memory fake in unit tests.
 */
export interface MediaWorkerRepo {
  findById(id: string): Promise<MediaWorkerAsset | null>
  findByUploadId(uploadId: string): Promise<MediaWorkerAsset | null>
  /** Apply the processing result to a row by id. Returns the updated asset (null if it vanished). */
  applyResult(id: string, patch: MediaResultPatch): Promise<MediaWorkerAsset | null>
  /** Insert an abuse_flag (subject_type = "media"). Idempotency is not required by callers. */
  insertAbuseFlag(flag: NewAbuseFlag): Promise<void>
  /**
   * Find orphan media: report_id IS NULL and created_at < `olderThan`. Bounded by `limit` so a sweep
   * processes a capped batch per run.
   */
  findOrphans(olderThan: Date, limit: number): Promise<OrphanRow[]>
  /** Delete a media_assets row by id. Idempotent (deleting a missing id is a no-op). */
  deleteById(id: string): Promise<void>
}

function toAsset(row: typeof mediaAssets.$inferSelect): MediaWorkerAsset {
  return {
    id: row.id,
    uploadId: row.uploadId,
    reportId: row.reportId,
    kind: row.kind,
    r2Key: row.r2Key,
    thumbKey: row.thumbKey,
    status: row.status,
    byteSize: row.byteSize,
  }
}

/** Production MediaWorkerRepo over the shared Drizzle client. */
export function makeDrizzleMediaWorkerRepo(db: Db): MediaWorkerRepo {
  return {
    async findById(id: string): Promise<MediaWorkerAsset | null> {
      const rows = await db.select().from(mediaAssets).where(eq(mediaAssets.id, id)).limit(1)
      const row = rows[0]
      return row ? toAsset(row) : null
    },

    async findByUploadId(uploadId: string): Promise<MediaWorkerAsset | null> {
      const rows = await db
        .select()
        .from(mediaAssets)
        .where(eq(mediaAssets.uploadId, uploadId))
        .limit(1)
      const row = rows[0]
      return row ? toAsset(row) : null
    },

    async applyResult(id: string, patch: MediaResultPatch): Promise<MediaWorkerAsset | null> {
      // Build the update set explicitly so undefined fields are not written (leaving columns intact).
      const set: Partial<typeof mediaAssets.$inferInsert> = { status: patch.status }
      if (patch.codec !== undefined) set.codec = patch.codec
      if (patch.width !== undefined) set.width = patch.width
      if (patch.height !== undefined) set.height = patch.height
      if (patch.phash !== undefined) set.phash = patch.phash
      if (patch.thumbKey !== undefined) set.thumbKey = patch.thumbKey
      if (patch.byteSize !== undefined) set.byteSize = patch.byteSize

      const rows = await db.update(mediaAssets).set(set).where(eq(mediaAssets.id, id)).returning()
      const row = rows[0]
      return row ? toAsset(row) : null
    },

    async insertAbuseFlag(flag: NewAbuseFlag): Promise<void> {
      await db.insert(abuseFlags).values({
        subjectType: "media",
        subjectId: flag.subjectId,
        reason: flag.reason,
        source: flag.source ?? "worker",
      })
    },

    async findOrphans(olderThan: Date, limit: number): Promise<OrphanRow[]> {
      const rows = await db
        .select({
          id: mediaAssets.id,
          r2Key: mediaAssets.r2Key,
          thumbKey: mediaAssets.thumbKey,
        })
        .from(mediaAssets)
        .where(and(isNull(mediaAssets.reportId), lt(mediaAssets.createdAt, olderThan)))
        .limit(limit)
      return rows
    },

    async deleteById(id: string): Promise<void> {
      await db.delete(mediaAssets).where(eq(mediaAssets.id, id))
    },
  }
}

/**
 * Create next month's chat_messages partition if missing. Mirrors the bounds convention in
 * 0002_chat_partitioning.sql ([lower inclusive, upper exclusive), monthly, UTC). Idempotent:
 * CREATE TABLE IF NOT EXISTS. Takes a postgres-js tag so the worker can run it without Drizzle.
 *
 * `now` defaults to the current time; injectable for deterministic tests. Returns the created (or
 * already-present) partition's table name.
 */
export async function ensureNextMonthChatPartition(
  sqlTag: import("../db/client.js").Sql,
  now: Date = new Date(),
): Promise<string> {
  // First day of NEXT month (UTC), and the month after, as the [from, to) bounds.
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() // 0-based
  const from = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0))
  const to = new Date(Date.UTC(y, m + 2, 1, 0, 0, 0))

  const yyyy = String(from.getUTCFullYear()).padStart(4, "0")
  const mm = String(from.getUTCMonth() + 1).padStart(2, "0")
  const table = `chat_messages_${yyyy}_${mm}`
  const fromLit = `${yyyy}-${mm}-01 00:00:00+00`
  const toYyyy = String(to.getUTCFullYear()).padStart(4, "0")
  const toMm = String(to.getUTCMonth() + 1).padStart(2, "0")
  const toLit = `${toYyyy}-${toMm}-01 00:00:00+00`

  // Table/partition identifiers are derived from a clock, never from user input, so this fixed-shape
  // DDL has no injection surface. IF NOT EXISTS makes it safe to run every month.
  await sqlTag.unsafe(
    `CREATE TABLE IF NOT EXISTS ${table} PARTITION OF chat_messages ` +
      `FOR VALUES FROM ('${fromLit}') TO ('${toLit}')`,
  )
  return table
}

/**
 * Re-export the stable job name + payload type from the intake service so the worker imports the SAME
 * constant the API enqueues with (single source; a rename can never desync producer and consumer).
 */
export { MEDIA_CHECKS_JOB } from "./media-intake-service.js"
export type { MediaChecksJob } from "./media-intake-service.js"

/** Re-export so the worker can build the structural where-clause helpers if it ever needs them. */
export { and, eq, isNull, lt, sql }
