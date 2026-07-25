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

import { and, eq, isNull, lt, ne, notExists, sql } from "drizzle-orm"
import { mediaAssets } from "../db/schema/media.js"
import { abuseFlags } from "../db/schema/moderation.js"
import { moderationItems } from "../db/schema/moderation_items.js"
import { reports } from "../db/schema/reports.js"
import { jurisdictions } from "../db/schema/jurisdictions.js"
import { users } from "../db/schema/users.js"
import { chatGroups } from "../db/schema/chat-groups.js"
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
   * Find orphan media: rows bound to NOTHING AT ALL and older than `olderThan`. Bounded by `limit` so a
   * sweep processes a capped batch per run.
   *
   * THE INVARIANT (read this before touching the predicate — the sweep DELETES the R2 objects, so a
   * wrong predicate is unrecoverable data loss, not a bug you can roll back):
   *
   *   An orphan is a media_assets row that NO subject anywhere in the product references, in EITHER
   *   direction, and that is old enough that none ever will. Every one of the following must hold.
   *
   * FORWARD bindings — a committing subject stamps its id ONTO the media row:
   *   report_id        reports (report-repository.drizzle.ts / anon-repository.drizzle.ts commit path)
   *   chat_message_id  chat + DM attachments (message-attachments.drizzle.ts; shared by both stacks)
   *   post_id          social-feed post media (post-repository.drizzle.ts, purpose='post')
   *
   *   `report_id IS NULL` ALONE IS NOT AN ORPHAN TEST. Every non-report lane leaves report_id NULL — the
   *   chat attach guard at message-attachments.drizzle.ts even REQUIRES it — so a report_id-only
   *   predicate matches every chat photo, every DM photo and every post photo in the database.
   *
   * REVERSE bindings — the SUBJECT points AT the media row, so the row's own columns look unbound:
   *   users.avatar_media_id        (drizzle/0019_user_avatar.sql, ON DELETE SET NULL)
   *   chat_groups.avatar_media_id  (drizzle/0047_chat_groups.sql, ON DELETE SET NULL)
   *
   *   ON DELETE SET NULL means a delete here does NOT fail loudly: the avatar column is silently NULLed
   *   and the user simply loses their picture. Nothing surfaces the loss. Hence the NOT EXISTS probes.
   *
   * OUT-OF-BAND bindings — referenced from jsonb, invisible to any column predicate:
   *   user_verification.documents[].mediaId (schema/user_verification.ts). Those uploads are the only
   *   rows stamped purpose='verification', so excluding that purpose is the (exact) proxy test.
   *
   * NOT a lane: media_assets.discussion_message_id was DROPPED in drizzle/0044_drop_report_discussion.sql
   * along with the discussion system, so it must NOT appear here (the column no longer exists).
   *
   * This mirrors, from the reaping side, the same lane enumeration services/media-authorization.ts makes
   * from the serving side. If a new binding lane is ever added, it must be added in BOTH places.
   */
  findOrphans(olderThan: Date, limit: number): Promise<OrphanRow[]>
  /** Delete a media_assets row by id. Idempotent (deleting a missing id is a no-op). */
  deleteById(id: string): Promise<void>
  /**
   * True if ANY OTHER media_assets row references this exact r2_key. The orphan sweep consults this
   * before deleting R2 objects so it never destroys media still referenced by a committed report (or
   * another pending row).
   *
   * (L14 correction: this doc previously claimed r2_key is content-addressed as
   * `uploads/yyyy/mm/<sha256>` and that identical bytes therefore dedupe to one shared object. They do
   * not — buildR2Key in media-intake-service.ts derives the key from the server-generated random
   * uploadId. Key sharing is rare rather than routine, but the check is cheap and correct, so it stays
   * as defense in depth.)
   */
  r2KeyReferencedByOthers(id: string, r2Key: string): Promise<boolean>
  /**
   * Phase 2 MODERATION PRODUCER HOOK (optional). Enqueue a moderation_items row for a report whose media
   * the worker just HELD. A `held` status now only ever means an NSFW policy hold (kind "image") - a
   * perceptual near-duplicate is non-blocking and stays `ready`, so the worker no longer auto-enqueues a
   * "duplicate" moderation item (issue #43; `kind: "duplicate"` remains a valid moderation kind for
   * manual/operator use). The report's media surfaces in the operator moderation detail. DEDUPED against
   * an existing OPEN item for the report so a re-delivered job does not double-enqueue. Optional on the
   * interface so the in-memory worker test fake need not implement it; the production impl below provides
   * it. It is wired in services/media-worker/src/jobs/media-checks.ts in the `result.status === "held"`
   * branch of runMediaChecksJob.
   *
   * This is intentionally a best-effort, non-fatal call (a moderation-enqueue failure must not flip an
   * already-correct media hold into a job failure), mirroring the existing best-effort abuse_flag insert.
   */
  enqueueHeldModerationItem?(input: {
    reportId: string
    reason: string
    kind?: "image" | "duplicate"
    note?: string | null
  }): Promise<void>
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
      // GOTCHA: media.checks is at-least-once (pg-boss retryLimit >= 2), so a re-delivered HELD/NSFW job
      // can insert a duplicate (subject_type, subject_id, reason) row — abuse_flags has only a non-unique
      // index, so ON CONFLICT cannot dedupe here. Duplicates are tolerated (the open-mod-queue dedupes by
      // subject); a UNIQUE backstop would need a migration (deferred).
      await db.insert(abuseFlags).values({
        subjectType: "media",
        subjectId: flag.subjectId,
        reason: flag.reason,
        source: flag.source ?? "worker",
      })
    },

    /**
     * "Bound to nothing at all, in either direction, and old enough that it never will be." See the
     * MediaWorkerRepo.findOrphans doc above for why each clause is load-bearing; do not drop one without
     * reading it. The two NOT EXISTS probes are index-backed (users_avatar_media_idx from
     * drizzle/0037_perf_indexes_audit.sql; chat_groups.avatar_media_id's FK index), so they are cheap
     * even at the drain-loop page sizes the sweep now uses.
     */
    async findOrphans(olderThan: Date, limit: number): Promise<OrphanRow[]> {
      const rows = await db
        .select({
          id: mediaAssets.id,
          r2Key: mediaAssets.r2Key,
          thumbKey: mediaAssets.thumbKey,
        })
        .from(mediaAssets)
        .where(
          and(
            // FORWARD bindings: report / chat+DM message / social post.
            isNull(mediaAssets.reportId),
            isNull(mediaAssets.chatMessageId),
            isNull(mediaAssets.postId),
            // REVERSE bindings: an avatar's owner points AT this row, and the FK is ON DELETE SET NULL,
            // so deleting it would silently strip the avatar rather than fail.
            notExists(
              db.select({ id: users.id }).from(users).where(eq(users.avatarMediaId, mediaAssets.id)),
            ),
            notExists(
              db
                .select({ id: chatGroups.id })
                .from(chatGroups)
                .where(eq(chatGroups.avatarMediaId, mediaAssets.id)),
            ),
            // OUT-OF-BAND binding: verification documents are referenced from a jsonb array
            // (user_verification.documents[].mediaId) that no column predicate can see; purpose is the
            // exact proxy for them.
            ne(mediaAssets.purpose, "verification"),
            lt(mediaAssets.createdAt, olderThan),
          ),
        )
        .limit(limit)
      return rows
    },

    async deleteById(id: string): Promise<void> {
      await db.delete(mediaAssets).where(eq(mediaAssets.id, id))
    },

    async r2KeyReferencedByOthers(id: string, r2Key: string): Promise<boolean> {
      const rows = await db
        .select({ id: mediaAssets.id })
        .from(mediaAssets)
        .where(and(eq(mediaAssets.r2Key, r2Key), ne(mediaAssets.id, id)))
        .limit(1)
      return rows.length > 0
    },

    async enqueueHeldModerationItem(input: {
      reportId: string
      reason: string
      kind?: "image" | "duplicate"
      note?: string | null
    }): Promise<void> {
      // Dedupe: skip when an OPEN moderation item already exists for this report (e.g. the anon
      // hold-then-publish path already enqueued one at submit, or a re-delivered worker job).
      const existing = await db
        .select({ id: moderationItems.id })
        .from(moderationItems)
        .where(
          and(
            eq(moderationItems.subjectType, "report"),
            eq(moderationItems.subjectId, input.reportId),
            eq(moderationItems.status, "open"),
          ),
        )
        .limit(1)
      if (existing[0]) return

      // Read the report's category + jurisdiction name + description so the moderation detail is useful.
      const ctx = await db
        .select({
          category: reports.category,
          description: reports.description,
          place: jurisdictions.name,
        })
        .from(reports)
        .leftJoin(jurisdictions, eq(jurisdictions.geoid, reports.jurisdictionGeoid))
        .where(eq(reports.id, input.reportId))
        .limit(1)
      const row = ctx[0]
      if (!row) return

      const kind = input.kind ?? "image"
      await db.insert(moderationItems).values({
        kind,
        subjectType: "report",
        subjectId: input.reportId,
        flag: kind === "duplicate" ? "Near-duplicate media" : "Held media (NSFW)",
        reason: input.reason,
        category: row.category,
        place: row.place,
        priority: "high",
        autoAction: "Hidden pending review",
        status: "open",
        meta: { reporter: "Anonymous", desc: row.description ?? "", note: input.note ?? null },
      })
    },
  }
}

/**
 * Create the NEXT-month partition of a monthly-partitioned message table if it is missing. Bounds follow
 * 0002_chat_partitioning.sql ([lower inclusive, upper exclusive), monthly, UTC). Idempotent (CREATE TABLE
 * IF NOT EXISTS) so it is safe to run every month. Takes a postgres-js tag so the worker can run it
 * without Drizzle. Returns the created (or already-present) partition's table name.
 *
 * The partition name + bounds are derived from a CLOCK, never from user input, so this fixed-shape DDL
 * has no injection surface (the only reason `sql.unsafe` is acceptable here).
 */
async function ensureNextMonthPartition(
  sqlTag: import("../db/client.js").Sql,
  parent: "chat_messages" | "dm_messages",
  now: Date,
): Promise<string> {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() // 0-based; NEXT month and the month after are the [from, to) bounds.
  const from = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0))
  const to = new Date(Date.UTC(y, m + 2, 1, 0, 0, 0))

  const yyyy = String(from.getUTCFullYear()).padStart(4, "0")
  const mm = String(from.getUTCMonth() + 1).padStart(2, "0")
  const table = `${parent}_${yyyy}_${mm}`
  const fromLit = `${yyyy}-${mm}-01 00:00:00+00`
  const toLit = `${String(to.getUTCFullYear()).padStart(4, "0")}-${String(
    to.getUTCMonth() + 1,
  ).padStart(2, "0")}-01 00:00:00+00`

  await sqlTag.unsafe(
    `CREATE TABLE IF NOT EXISTS ${table} PARTITION OF ${parent} ` +
      `FOR VALUES FROM ('${fromLit}') TO ('${toLit}')`,
  )
  return table
}

/** Create next month's chat_messages partition if missing. `now` is injectable for deterministic tests. */
export function ensureNextMonthChatPartition(
  sqlTag: import("../db/client.js").Sql,
  now: Date = new Date(),
): Promise<string> {
  return ensureNextMonthPartition(sqlTag, "chat_messages", now)
}

/** Create next month's dm_messages partition if missing. `now` is injectable for deterministic tests. */
export function ensureNextMonthDmPartition(
  sqlTag: import("../db/client.js").Sql,
  now: Date = new Date(),
): Promise<string> {
  return ensureNextMonthPartition(sqlTag, "dm_messages", now)
}

/**
 * Re-export the stable job name + payload type from the intake service so the worker imports the SAME
 * constant the API enqueues with (single source; a rename can never desync producer and consumer).
 */
export { MEDIA_CHECKS_JOB } from "./media-intake-service.js"
export type { MediaChecksJob } from "./media-intake-service.js"

/** Re-export so the worker can build the structural where-clause helpers if it ever needs them. */
export { and, eq, isNull, lt, ne, sql }
