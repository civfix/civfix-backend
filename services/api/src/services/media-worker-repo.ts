
import { and, eq, inArray, isNotNull, isNull, lt, ne, notExists, sql } from "drizzle-orm"
import { mediaAssets } from "../db/schema/media.js"
import { mediaReapTombstones } from "../db/schema/media_reap_tombstones.js"
import { abuseFlags } from "../db/schema/moderation.js"
import { moderationItems } from "../db/schema/moderation_items.js"
import { reports } from "../db/schema/reports.js"
import { jurisdictions } from "../db/schema/jurisdictions.js"
import { users } from "../db/schema/users.js"
import { chatGroups } from "../db/schema/chat-groups.js"
import type { Db } from "../db/client.js"
import type { MediaKind, MediaStatus } from "@civfix/shared"

export { normalizeEtag, readEtag } from "./media-etag.js"
export type { StorageHeadWithEtag } from "./media-etag.js"

export type WorkerAbuseReason = "nsfw" | "phash_dup" | "gps"

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
}

export interface LeakedObjectRow {
  r2Key: string
  mediaId: string | null
  attempts: number
}

export interface MediaWorkerRepo {
  findById(id: string): Promise<MediaWorkerAsset | null>
  findByUploadId(uploadId: string): Promise<MediaWorkerAsset | null>
  applyResult(id: string, patch: MediaResultPatch): Promise<MediaWorkerAsset | null>
  insertAbuseFlag(flag: NewAbuseFlag): Promise<void>
  findOrphans(olderThan: Date, limit: number): Promise<OrphanRow[]>
  findStuckValidating(olderThan: Date, limit: number): Promise<StuckMediaRow[]>
  terminalizeStuck(id: string): Promise<MediaWorkerAsset | null>
  deleteOrphan(id: string, olderThan: Date): Promise<OrphanRow | null>
  adoptLegacyServedKeys(olderThan: Date, limit: number): Promise<number>
  r2KeyReferencedByOthers(id: string, r2Key: string): Promise<boolean>
  enqueueHeldModerationItem?(input: {
    reportId: string
    reason: string
    kind?: "image" | "duplicate"
    note?: string | null
  }): Promise<void>

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

    async adoptLegacyServedKeys(olderThan: Date, limit: number): Promise<number> {
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
      if (candidates.length === 0) return 0
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
      return rows.length
    },

    async findOrphans(olderThan: Date, limit: number): Promise<OrphanRow[]> {
      return db.select(ORPHAN_COLUMNS).from(mediaAssets).where(orphanPredicate(db, olderThan)).limit(limit)
    },

    async deleteOrphan(id: string, olderThan: Date): Promise<OrphanRow | null> {
      const rows = await db
        .delete(mediaAssets)
        .where(and(eq(mediaAssets.id, id), orphanPredicate(db, olderThan)))
        .returning(ORPHAN_COLUMNS)
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
      await db
        .insert(moderationItems)
        .values({
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
        .onConflictDoNothing({
          target: [moderationItems.subjectType, moderationItems.subjectId],
          where: sql`status = 'open'`,
        })
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

const ORPHAN_COLUMNS = {
  id: mediaAssets.id,
  r2Key: mediaAssets.r2Key,
  servedKey: mediaAssets.servedKey,
  thumbKey: mediaAssets.thumbKey,
}

function orphanPredicate(db: Db, olderThan: Date) {
  return and(
    isNull(mediaAssets.reportId),
    isNull(mediaAssets.chatMessageId),
    isNull(mediaAssets.postId),
    notExists(
      db.select({ id: users.id }).from(users).where(eq(users.avatarMediaId, mediaAssets.id)),
    ),
    notExists(
      db
        .select({ id: chatGroups.id })
        .from(chatGroups)
        .where(eq(chatGroups.avatarMediaId, mediaAssets.id)),
    ),
    ne(mediaAssets.purpose, "verification"),
    lt(mediaAssets.createdAt, olderThan),
  )
}

type MessageParent = "chat_messages" | "dm_messages"

async function ensureMonthPartition(
  sqlTag: import("../db/client.js").Sql,
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
  sqlTag: import("../db/client.js").Sql,
  parent: MessageParent,
  now: Date,
): Promise<string> {
  return ensureMonthPartition(sqlTag, parent, now.getUTCFullYear(), now.getUTCMonth() + 1)
}

async function ensurePartitionWindow(
  sqlTag: import("../db/client.js").Sql,
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

export function ensureNextMonthChatPartition(
  sqlTag: import("../db/client.js").Sql,
  now: Date = new Date(),
): Promise<string> {
  return ensureNextMonthPartition(sqlTag, "chat_messages", now)
}

export function ensureNextMonthDmPartition(
  sqlTag: import("../db/client.js").Sql,
  now: Date = new Date(),
): Promise<string> {
  return ensureNextMonthPartition(sqlTag, "dm_messages", now)
}

export function ensureChatPartitionWindow(
  sqlTag: import("../db/client.js").Sql,
  now: Date = new Date(),
  monthsAhead = 2,
): Promise<string[]> {
  return ensurePartitionWindow(sqlTag, "chat_messages", now, monthsAhead)
}

export function ensureDmPartitionWindow(
  sqlTag: import("../db/client.js").Sql,
  now: Date = new Date(),
  monthsAhead = 2,
): Promise<string[]> {
  return ensurePartitionWindow(sqlTag, "dm_messages", now, monthsAhead)
}

export { MEDIA_CHECKS_JOB } from "./media-intake-service.js"
export type { MediaChecksJob } from "./media-intake-service.js"

export { and, eq, isNull, lt, ne, sql }
