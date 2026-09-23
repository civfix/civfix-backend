import { and, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm"
import { mediaAssets } from "../db/schema/media.js"
import { mediaBoundElsewhere } from "./media-bindings.js"
import { mediaReapTombstones } from "../db/schema/media_reap_tombstones.js"
import { abuseFlags } from "../db/schema/moderation.js"
import { moderationItems } from "../db/schema/moderation_items.js"
import { reports } from "../db/schema/reports.js"
import { jurisdictions } from "../db/schema/jurisdictions.js"
import { users } from "../db/schema/users.js"
import type { Db, Queryable, Sql } from "../db/client.js"
import type { MediaKind, MediaStatus } from "@civfix/shared"
import type { NearDuplicateResult } from "@civfix/shared/interfaces"

export { normalizeEtag, readEtag } from "./media-etag.js"
export type { StorageHeadWithEtag } from "./media-etag.js"

export type WorkerAbuseReason = "nsfw" | "phash_dup" | "gps"

const ANONYMOUS_REPORTER = "Anonymous"
const DUPLICATE_MODERATION_FLAG = "Near-duplicate media"
const HELD_MODERATION_FLAG = "Held media (NSFW)"
const HELD_MODERATION_AUTO_ACTION = "Hidden pending review"

export const PARTITION_MONTHS_AHEAD = 2

export interface MediaWorkerAsset {
  id: string
  uploadId: string
  reportId: string | null
  kind: MediaKind
  r2Key: string
  servedKey: string | null
  thumbKey: string | null
  status: MediaStatus
  byteSize: number | null
}

export interface MediaResultPatch {
  status: MediaStatus
  codec?: string | null
  width?: number | null
  height?: number | null
  phash?: string | null
  servedKey?: string | null
  thumbKey?: string | null
  byteSize?: number | null
}

export interface NewAbuseFlag {
  subjectId: string
  reason: WorkerAbuseReason
  source?: "worker" | "api" | "user_report"
}

export interface OrphanRow {
  id: string
  r2Key: string
  servedKey: string | null
  thumbKey: string | null
}

export interface StuckMediaRow {
  id: string
  uploadId: string
  r2Key: string
  servedKey: string | null
  thumbKey: string | null
  kind: MediaKind
  checkCount: number
  uploadEtag: string | null
}

export interface LeakedObjectRow {
  r2Key: string
  mediaId: string | null
  attempts: number
}

export interface LegacyServedKeyAdoption {
  adopted: number
  remaining: number
}

export interface MediaWorkerRepository {
  findById(id: string): Promise<MediaWorkerAsset | null>
  findByUploadId(uploadId: string): Promise<MediaWorkerAsset | null>
  applyResult(id: string, patch: MediaResultPatch): Promise<MediaWorkerAsset | null>
  insertAbuseFlag(flag: NewAbuseFlag): Promise<void>
  findOrphans(olderThan: Date, limit: number): Promise<OrphanRow[]>
  findStuckValidating(olderThan: Date, limit: number): Promise<StuckMediaRow[]>
  terminalizeStuck(id: string): Promise<MediaWorkerAsset | null>
  deleteOrphan(id: string, olderThan: Date): Promise<OrphanRow | null>
  adoptLegacyServedKeys(olderThan: Date, limit: number): Promise<LegacyServedKeyAdoption>
  r2KeyReferencedByOthers(id: string, r2Key: string): Promise<boolean>
  findPhashDuplicate?(
    hash: string,
    opts?: { excludeAssetId?: string; excludeReportId?: string },
  ): Promise<NearDuplicateResult>
  enqueueHeldModerationItem?(input: {
    reportId: string
    reason: string
    kind?: "image" | "duplicate"
    note?: string | null
  }): Promise<void>
  refreshAvatarUrls?(mediaId: string, avatarUrl: string): Promise<number>

  recordLeakedObjects?(input: {
    mediaId: string | null
    keys: string[]
    error?: string | null
  }): Promise<void>
  listLeakedObjects?(limit: number, maxAttempts: number): Promise<LeakedObjectRow[]>
  clearLeakedObject?(r2Key: string): Promise<void>
}

function toAsset(row: typeof mediaAssets.$inferSelect): MediaWorkerAsset {
  return {
    id: row.id,
    uploadId: row.uploadId,
    reportId: row.reportId,
    kind: row.kind,
    r2Key: row.r2Key,
    servedKey: row.servedKey,
    thumbKey: row.thumbKey,
    status: row.status,
    byteSize: row.byteSize,
  }
}

export function makeDrizzleMediaWorkerRepository(db: Db, tag: Sql): MediaWorkerRepository {
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
      const set: Partial<typeof mediaAssets.$inferInsert> = { status: patch.status }
      if (patch.codec !== undefined) set.codec = patch.codec
      if (patch.width !== undefined) set.width = patch.width
      if (patch.height !== undefined) set.height = patch.height
      if (patch.phash !== undefined) set.phash = patch.phash
      if (patch.servedKey !== undefined) set.servedKey = patch.servedKey
      if (patch.thumbKey !== undefined) set.thumbKey = patch.thumbKey
      if (patch.byteSize !== undefined) set.byteSize = patch.byteSize

      const rows = await db
        .update(mediaAssets)
        .set(set)
        .where(and(eq(mediaAssets.id, id), eq(mediaAssets.status, "validating")))
        .returning()
      const row = rows[0]
      return row ? toAsset(row) : null
    },

    async insertAbuseFlag(flag: NewAbuseFlag): Promise<void> {
      await db
        .insert(abuseFlags)
        .values({
          subjectType: "media",
          subjectId: flag.subjectId,
          reason: flag.reason,
          source: flag.source ?? "worker",
        })
        .onConflictDoNothing({
          target: [abuseFlags.subjectType, abuseFlags.subjectId, abuseFlags.reason],
          where: sql`resolved_at is null and source = 'worker'`,
        })
    },

    async adoptLegacyServedKeys(olderThan: Date, limit: number): Promise<LegacyServedKeyAdoption> {
      const candidates = await db
        .select({ id: mediaAssets.id })
        .from(mediaAssets)
        .where(
          and(
            eq(mediaAssets.status, "ready"),
            isNull(mediaAssets.servedKey),
            lt(mediaAssets.createdAt, olderThan),
          ),
        )
        .limit(limit)
      if (candidates.length === 0) {
        const residual = await db
          .select({ id: mediaAssets.id })
          .from(mediaAssets)
          .where(and(eq(mediaAssets.status, "ready"), isNull(mediaAssets.servedKey)))
          .limit(1)
        return { adopted: 0, remaining: residual.length }
      }
      const rows = await db
        .update(mediaAssets)
        .set({ servedKey: sql`${mediaAssets.r2Key}` })
        .where(
          and(
            inArray(
              mediaAssets.id,
              candidates.map((c) => c.id),
            ),
            eq(mediaAssets.status, "ready"),
            isNull(mediaAssets.servedKey),
            lt(mediaAssets.createdAt, olderThan),
          ),
        )
        .returning({ id: mediaAssets.id })
      return { adopted: rows.length, remaining: candidates.length }
    },

    async findOrphans(olderThan: Date, limit: number): Promise<OrphanRow[]> {
      const rows = await tag<OrphanRow[]>`
        SELECT ${ORPHAN_COLUMNS_SQL(tag)}
          FROM media_assets
         WHERE ${orphanPredicate(tag, olderThan)}
         LIMIT ${limit}
      `
      return [...rows]
    },

    async deleteOrphan(id: string, olderThan: Date): Promise<OrphanRow | null> {
      const rows = await tag<OrphanRow[]>`
        DELETE FROM media_assets
         WHERE media_assets.id = ${id}::uuid
           AND (${orphanPredicate(tag, olderThan)})
        RETURNING ${ORPHAN_COLUMNS_SQL(tag)}
      `
      return rows[0] ?? null
    },

    async findStuckValidating(olderThan: Date, limit: number): Promise<StuckMediaRow[]> {
      const stuck = and(
        eq(mediaAssets.status, "validating"),
        isNotNull(mediaAssets.finalizedAt),
        lt(mediaAssets.finalizedAt, olderThan),
      )
      return db.transaction(async (tx) => {
        const candidates = await tx
          .select({ id: mediaAssets.id })
          .from(mediaAssets)
          .where(stuck)
          .orderBy(sql`${mediaAssets.stuckCheckedAt} asc nulls first`, mediaAssets.finalizedAt)
          .limit(limit)
          .for("update", { skipLocked: true })
        if (candidates.length === 0) return []

        return tx
          .update(mediaAssets)
          .set({
            stuckCheckedAt: sql`now()`,
            stuckCheckCount: sql`${mediaAssets.stuckCheckCount} + 1`,
          })
          .where(
            and(
              inArray(
                mediaAssets.id,
                candidates.map((c) => c.id),
              ),
              stuck,
            ),
          )
          .returning({
            id: mediaAssets.id,
            uploadId: mediaAssets.uploadId,
            r2Key: mediaAssets.r2Key,
            servedKey: mediaAssets.servedKey,
            thumbKey: mediaAssets.thumbKey,
            kind: mediaAssets.kind,
            checkCount: mediaAssets.stuckCheckCount,
            uploadEtag: mediaAssets.uploadEtag,
          })
      })
    },

    async terminalizeStuck(id: string): Promise<MediaWorkerAsset | null> {
      const rows = await db
        .update(mediaAssets)
        .set({ status: "rejected" })
        .where(and(eq(mediaAssets.id, id), eq(mediaAssets.status, "validating")))
        .returning()
      const row = rows[0]
      return row ? toAsset(row) : null
    },

    async refreshAvatarUrls(mediaId: string, avatarUrl: string): Promise<number> {
      const rows = await tag<{ id: string }[]>`
        UPDATE users
        SET avatar_url = ${avatarUrl}
        WHERE avatar_media_id = ${mediaId}::uuid
          AND deleted_at IS NULL
        RETURNING id
      `
      return rows.length
    },

    async r2KeyReferencedByOthers(id: string, r2Key: string): Promise<boolean> {
      const rows = await db
        .select({ id: mediaAssets.id })
        .from(mediaAssets)
        .where(and(eq(mediaAssets.r2Key, r2Key), ne(mediaAssets.id, id)))
        .limit(1)
      return rows.length > 0
    },

    async findPhashDuplicate(
      hash: string,
      opts?: { excludeAssetId?: string; excludeReportId?: string },
    ): Promise<NearDuplicateResult> {
      const excludeId = opts?.excludeAssetId ?? null
      const excludeReportId = opts?.excludeReportId ?? null
      const rows = await tag<{ report_id: string | null }[]>`
        SELECT report_id
        FROM media_assets
        WHERE phash = ${hash}
          AND report_id IS NOT NULL
          ${excludeId !== null ? tag`AND id <> ${excludeId}` : tag``}
          ${excludeReportId !== null ? tag`AND report_id IS DISTINCT FROM ${excludeReportId}` : tag``}
        ORDER BY created_at ASC
        LIMIT 1
      `
      const ofReportId = rows[0]?.report_id ?? null
      if (ofReportId !== null) return { dup: true, ofReportId }
      return { dup: false }
    },

    async enqueueHeldModerationItem(input: {
      reportId: string
      reason: string
      kind?: "image" | "duplicate"
      note?: string | null
    }): Promise<void> {
      if (await foldIntoOpenModerationItem(db, input.reportId)) return

      const row = await loadModerationContext(db, input.reportId)
      if (!row) return

      const kind = input.kind ?? "image"
      const inserted = await db
        .insert(moderationItems)
        .values({
          kind,
          subjectType: "report",
          subjectId: input.reportId,
          flag: kind === "duplicate" ? DUPLICATE_MODERATION_FLAG : HELD_MODERATION_FLAG,
          reason: input.reason,
          category: row.category,
          place: row.place,
          priority: "high",
          autoAction: HELD_MODERATION_AUTO_ACTION,
          status: "open",
          meta: {
            reporter: row.reporterName ?? ANONYMOUS_REPORTER,
            reporterUserId: row.reporterUserId ?? null,
            desc: row.description ?? "",
            note: input.note ?? null,
          },
        })
        .onConflictDoNothing({
          target: [moderationItems.subjectType, moderationItems.subjectId],
          where: sql`status = 'open'`,
        })
        .returning({ id: moderationItems.id })
      if (inserted.length === 0) await foldIntoOpenModerationItem(db, input.reportId)
    },

    async recordLeakedObjects(input: {
      mediaId: string | null
      keys: string[]
      error?: string | null
    }): Promise<void> {
      const keys = [...new Set(input.keys)]
      if (keys.length === 0) return
      await db
        .insert(mediaReapTombstones)
        .values(
          keys.map((r2Key) => ({
            r2Key,
            mediaId: input.mediaId,
            lastError: input.error ?? null,
          })),
        )
        .onConflictDoUpdate({
          target: mediaReapTombstones.r2Key,
          set: {
            attempts: sql`${mediaReapTombstones.attempts} + 1`,
            lastError: sql`excluded.last_error`,
            lastAttemptAt: sql`now()`,
          },
        })
    },

    async listLeakedObjects(limit: number, maxAttempts: number): Promise<LeakedObjectRow[]> {
      return db
        .select({
          r2Key: mediaReapTombstones.r2Key,
          mediaId: mediaReapTombstones.mediaId,
          attempts: mediaReapTombstones.attempts,
        })
        .from(mediaReapTombstones)
        .where(lt(mediaReapTombstones.attempts, maxAttempts))
        .orderBy(mediaReapTombstones.createdAt)
        .limit(limit)
    },

    async clearLeakedObject(r2Key: string): Promise<void> {
      await db.delete(mediaReapTombstones).where(eq(mediaReapTombstones.r2Key, r2Key))
    },
  }
}

// A held source folding into an open item means the owner's takedown is no longer its only origin, so
// removing it must strike the author again.
async function foldIntoOpenModerationItem(db: Db, reportId: string): Promise<boolean> {
  const folded = await db
    .update(moderationItems)
    .set({ meta: sql`${moderationItems.meta} - 'ownerTakedown'` })
    .where(
      and(
        eq(moderationItems.subjectType, "report"),
        eq(moderationItems.subjectId, reportId),
        eq(moderationItems.status, "open"),
      ),
    )
    .returning({ id: moderationItems.id })
  return folded.length > 0
}

async function loadModerationContext(db: Db, reportId: string) {
  const ctx = await db
    .select({
      category: reports.category,
      description: reports.description,
      place: jurisdictions.name,
      reporterName: users.displayName,
      reporterUserId: users.id,
    })
    .from(reports)
    .leftJoin(jurisdictions, eq(jurisdictions.geoid, reports.jurisdictionGeoid))
    .leftJoin(users, eq(users.id, reports.reporterUserId))
    .where(eq(reports.id, reportId))
    .limit(1)
  return ctx[0]
}

const ORPHAN_COLUMNS_SQL = (tag: Queryable) => tag`
  media_assets.id AS "id",
  media_assets.r2_key AS "r2Key",
  media_assets.served_key AS "servedKey",
  media_assets.thumb_key AS "thumbKey"
`

export function orphanPredicate(tag: Queryable, olderThan: Date) {
  return tag`
    media_assets.report_id IS NULL
    AND media_assets.chat_message_id IS NULL
    AND media_assets.post_id IS NULL
    AND media_assets.purpose <> 'verification'
    AND media_assets.created_at < ${olderThan}
    AND NOT (${mediaBoundElsewhere(tag, null)})
  `
}

type MessageParent = "chat_messages" | "dm_messages"

async function ensureMonthPartition(
  sqlTag: Sql,
  parent: MessageParent,
  year: number,
  monthIndex0: number,
): Promise<string> {
  const from = new Date(Date.UTC(year, monthIndex0, 1, 0, 0, 0))
  const to = new Date(Date.UTC(year, monthIndex0 + 1, 1, 0, 0, 0))

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

async function ensureNextMonthPartition(
  sqlTag: Sql,
  parent: MessageParent,
  now: Date,
): Promise<string> {
  return ensureMonthPartition(sqlTag, parent, now.getUTCFullYear(), now.getUTCMonth() + 1)
}

async function ensurePartitionWindow(
  sqlTag: Sql,
  parent: MessageParent,
  now: Date,
  monthsAhead: number,
): Promise<string[]> {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const tables: string[] = []
  for (let i = 0; i <= monthsAhead; i++) {
    tables.push(await ensureMonthPartition(sqlTag, parent, y, m + i))
  }
  return tables
}

export function ensureNextMonthChatPartition(sqlTag: Sql, now: Date = new Date()): Promise<string> {
  return ensureNextMonthPartition(sqlTag, "chat_messages", now)
}

export function ensureNextMonthDmPartition(sqlTag: Sql, now: Date = new Date()): Promise<string> {
  return ensureNextMonthPartition(sqlTag, "dm_messages", now)
}

export function ensureChatPartitionWindow(
  sqlTag: Sql,
  now: Date = new Date(),
  monthsAhead = PARTITION_MONTHS_AHEAD,
): Promise<string[]> {
  return ensurePartitionWindow(sqlTag, "chat_messages", now, monthsAhead)
}

export function ensureDmPartitionWindow(
  sqlTag: Sql,
  now: Date = new Date(),
  monthsAhead = PARTITION_MONTHS_AHEAD,
): Promise<string[]> {
  return ensurePartitionWindow(sqlTag, "dm_messages", now, monthsAhead)
}

export type { MediaChecksJob } from "./media-intake-service.js"
