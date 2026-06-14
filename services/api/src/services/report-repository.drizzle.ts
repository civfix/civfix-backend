/**
 * Postgres-backed ReportRepository (the production implementation of the reports persistence seam).
 *
 * ALL reports/media-attach/timeline/idempotency/follow access flows through here so the report service
 * stays infra-free and unit-testable with an in-memory repo. It is written against the raw postgres-js
 * tag (`Sql`) rather than the Drizzle query builder because every report touches PostGIS geometry
 * (ST_SetSRID(ST_MakePoint(lng,lat),4326) on write; ST_X/ST_Y on read), which Drizzle does not model.
 * Using one tag throughout also lets the create flow run as a SINGLE postgres-js transaction
 * (sql.begin), which is what guarantees the no-duplicate + no-orphan idempotency contract.
 *
 * CREATE TRANSACTION (createReportTx):
 *   1. INSERT the report row (geom from the point, geom_source verbatim, status/visibility as decided
 *      by the service, h3_cell precomputed).
 *   2. For each mediaUploadId: attach the matching media_asset by setting report_id, but ONLY when it is
 *      not already bound to a different report (report_id IS NULL OR report_id = this report). An
 *      unknown id is ignored (the asset may have been swept); a foreign id is left untouched (never
 *      stolen). This keeps media attachment orphan-safe and prevents cross-report theft.
 *   3. INSERT the initial timeline row (status the report was created at).
 *   4. Read the row back (decoding geom -> lat/lng) + the attached media + the timeline, build the DTO
 *      snapshot via the caller's builder, and INSERT it into idempotency_keys.response_snapshot.
 *   All four happen in ONE transaction. If the UNIQUE(idempotency_key) on reports (or the PK on
 *   idempotency_keys) trips because a concurrent submit won the race, the transaction rolls back and we
 *   read + return the winner's stored snapshot as a "replayed" result (no duplicate row, no orphaned
 *   media, the original report id returned).
 */

import type { Queryable, Sql } from "../db/client.js"
import type {
  BBox,
  CreateReportTxArgs,
  CreateReportTxResult,
  ReportMapPoint,
  ReportMediaView,
  ReportRecord,
  ReportRepository,
  ReportTimelineView,
} from "./report-service.js"
import { REPORT_CREATE_SCOPE } from "./report-service.js"
import type { ReportDTO, ReportCategory, ReportStatus } from "@civfix/shared"

/** Postgres unique-violation SQLSTATE; surfaced on the idempotency-key race. */
const PG_UNIQUE_VIOLATION = "23505"

/** Shape of a report row as selected back (geom decoded to lng/lat via ST_X/ST_Y). */
interface ReportRowSelect {
  id: string
  reporter_user_id: string | null
  anon_session_id: string | null
  category: ReportCategory
  title: string | null
  description: string | null
  addr: string | null
  status: ReportStatus
  visibility: "public" | "hidden"
  lng: number
  lat: number
  geom_source: "device" | "exif" | "manual"
  jurisdiction_geoid: string | null
  created_at: Date
  published_at: Date | null
  deleted_at: Date | null
}

/** Project a selected report row to the structural ReportRecord the service consumes. */
function toRecord(r: ReportRowSelect): ReportRecord {
  return {
    id: r.id,
    reporterUserId: r.reporter_user_id,
    anonSessionId: r.anon_session_id,
    category: r.category,
    title: r.title,
    description: r.description,
    addr: r.addr,
    status: r.status,
    visibility: r.visibility,
    lat: r.lat,
    lng: r.lng,
    geomSource: r.geom_source,
    jurisdictionGeoid: r.jurisdiction_geoid,
    createdAt: r.created_at,
    publishedAt: r.published_at,
    deletedAt: r.deleted_at,
  }
}

/** The SELECT list (with geom decoded) shared by every report read. */
function reportColumns(sql: Queryable) {
  return sql`
    id, reporter_user_id, anon_session_id, category, title, description, addr, status, visibility,
    ST_X(geom) AS lng, ST_Y(geom) AS lat, geom_source, jurisdiction_geoid,
    created_at, published_at, deleted_at
  `
}

/** Is this a postgres unique-violation error? */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  )
}

export function makeDrizzleReportRepository(sql: Sql): ReportRepository {
  /** Read a stored idempotency snapshot (typed as ReportDTO). Used by the fast path and the race path. */
  async function readSnapshot(key: string, scope: string): Promise<ReportDTO | null> {
    const rows = await sql<{ response_snapshot: ReportDTO }[]>`
      SELECT response_snapshot
      FROM idempotency_keys
      WHERE key = ${key} AND scope = ${scope}
      LIMIT 1
    `
    return rows[0]?.response_snapshot ?? null
  }

  /** Load media attached to a report (tx-scoped tag passed so reads share the transaction). */
  async function loadMedia(tag: Queryable, reportId: string): Promise<ReportMediaView[]> {
    const rows = await tag<
      {
        id: string
        kind: "image" | "video"
        codec: string | null
        r2_key: string
        thumb_key: string | null
        status: "validating" | "ready" | "rejected" | "held"
        width: number | null
        height: number | null
      }[]
    >`
      SELECT id, kind, codec, r2_key, thumb_key, status, width, height
      FROM media_assets
      WHERE report_id = ${reportId}
      ORDER BY created_at ASC
    `
    return rows.map((m) => ({
      id: m.id,
      kind: m.kind,
      codec: m.codec,
      r2Key: m.r2_key,
      thumbKey: m.thumb_key,
      status: m.status,
      width: m.width,
      height: m.height,
    }))
  }

  /** Load the ordered timeline for a report. */
  async function loadTimeline(tag: Queryable, reportId: string): Promise<ReportTimelineView[]> {
    const rows = await tag<{ status: ReportStatus; note: string | null; created_at: Date }[]>`
      SELECT status, note, created_at
      FROM report_timeline
      WHERE report_id = ${reportId}
      ORDER BY created_at ASC, id ASC
    `
    return rows.map((t) => ({ status: t.status, note: t.note, createdAt: t.created_at }))
  }

  return {
    async findIdempotentSnapshot(key: string, scope: string): Promise<ReportDTO | null> {
      return readSnapshot(key, scope)
    },

    async createReportTx(args: CreateReportTxArgs): Promise<CreateReportTxResult> {
      try {
        const snapshot = await sql.begin(async (tx) => {
          // 1) Insert the report. geom is built from the point in SQL; geom_source stored verbatim.
          await tx`
            INSERT INTO reports (
              id, reporter_user_id, idempotency_key, geom, geom_source, jurisdiction_geoid,
              category, title, description, addr, status, visibility, h3_cell, published_at
            ) VALUES (
              ${args.reportId},
              ${args.reporterUserId},
              ${args.idempotencyKey},
              ST_SetSRID(ST_MakePoint(${args.lng}, ${args.lat}), 4326),
              ${args.geomSource},
              ${args.jurisdictionGeoid},
              ${args.category},
              ${args.title},
              ${args.description},
              ${args.addr},
              ${args.status},
              ${args.visibility},
              ${args.h3Cell},
              ${args.publishedAt}
            )
          `

          // 2) Attach media: set report_id ONLY when the asset is unattached or already ours. A foreign
          // asset (bound to another report) is left untouched - never stolen. Unknown ids no-op.
          for (const uploadId of args.mediaUploadIds) {
            await tx`
              UPDATE media_assets
              SET report_id = ${args.reportId}
              WHERE upload_id = ${uploadId}
                AND (report_id IS NULL OR report_id = ${args.reportId})
            `
          }

          // 3) Initial timeline entry (the status the report was created at).
          await tx`
            INSERT INTO report_timeline (report_id, status, note, actor_id)
            VALUES (${args.reportId}, ${args.status}, ${args.timelineNote}, ${args.reporterUserId})
          `

          // 4) Read the persisted state back (inside the tx) and build + persist the snapshot.
          const rows = await tx<ReportRowSelect[]>`
            SELECT ${reportColumns(tx)} FROM reports WHERE id = ${args.reportId} LIMIT 1
          `
          const record = toRecord(rows[0]!)
          const media = await loadMedia(tx, args.reportId)
          const timeline = await loadTimeline(tx, args.reportId)
          const dto = await args.buildSnapshot(record, media, timeline)

          // The DTO is JSON-serializable (only strings/numbers/booleans/arrays/objects). Wrap it with the
          // postgres-js json() helper so it lands as a jsonb value rather than being interpolated. json()
          // is a connection-independent value marker, so the outer `sql.json` is equivalent inside the tx.
          await tx`
            INSERT INTO idempotency_keys (key, scope, user_or_anon, response_snapshot)
            VALUES (
              ${args.idempotency.key},
              ${args.idempotency.scope},
              ${args.idempotency.userOrAnon},
              ${sql.json(dto as Parameters<typeof sql.json>[0])}
            )
          `
          return dto
        })
        return { kind: "created", snapshot }
      } catch (err) {
        // A concurrent submit won the idempotency-key race: the transaction rolled back. Return the
        // winner's stored snapshot so the caller still sees the original report (no duplicate/orphan).
        if (isUniqueViolation(err)) {
          const stored = await readSnapshot(args.idempotency.key, args.idempotency.scope)
          if (stored) return { kind: "replayed", snapshot: stored }
        }
        throw err
      }
    },

    async findReportById(id: string): Promise<ReportRecord | null> {
      const rows = await sql<ReportRowSelect[]>`
        SELECT ${reportColumns(sql)} FROM reports WHERE id = ${id} LIMIT 1
      `
      return rows[0] ? toRecord(rows[0]) : null
    },

    async findMediaForReport(reportId: string): Promise<ReportMediaView[]> {
      // PUBLIC read path (GET /reports/:id + my-reports): only `ready` media is servable. getMedia
      // serves bytes for ready assets only, so a held(NSFW)/rejected/validating asset would yield a
      // broken URL and, for held/rejected, leak moderated content (a moderation bypass). The create-tx
      // snapshot reads loadMedia() DIRECTLY (unfiltered) so a new report's just-attached `validating`
      // media still lands in its frozen idempotency snapshot.
      const media = await loadMedia(sql, reportId)
      return media.filter((m) => m.status === "ready")
    },

    async findTimelineForReport(reportId: string): Promise<ReportTimelineView[]> {
      return loadTimeline(sql, reportId)
    },

    async isFollowing(userId: string, reportId: string): Promise<boolean> {
      const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM report_follows
        WHERE user_id = ${userId} AND report_id = ${reportId}
        LIMIT 1
      `
      return rows.length > 0
    },

    async listMyReports(
      userId: string,
      cursor: string | null,
      limit: number,
    ): Promise<{ records: ReportRecord[]; nextCursor: string | null }> {
      // Keyset pagination over the SAME total order as the ORDER BY: (created_at DESC, id DESC). The
      // cursor encodes BOTH columns ("<iso>|<id>") and the filter uses a row-value comparison
      // (created_at, id) < (cursorCreatedAt, cursorId), exactly like chat-repository.drizzle history.
      // This is the fix for the page-boundary skip: filtering on created_at alone could drop a row when
      // two of a user's reports share the same created_at across a boundary; the (created_at, id) tuple
      // makes the keyset a strict, total successor of the last row seen.
      const anchor = parseMyReportsCursor(cursor)
      const cursorFilter =
        anchor !== null
          ? sql`AND (created_at, id) < (${anchor.createdAt}, ${anchor.id}::uuid)`
          : sql``
      const rows = await sql<ReportRowSelect[]>`
        SELECT ${reportColumns(sql)}
        FROM reports
        WHERE reporter_user_id = ${userId}
          AND deleted_at IS NULL
          ${cursorFilter}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}
      `
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      const records = page.map(toRecord)
      const last = page[page.length - 1]
      const nextCursor =
        hasMore && last ? `${last.created_at.toISOString()}|${last.id}` : null
      return { records, nextCursor }
    },

    async findMapCandidates(
      bbox: BBox,
      categories: ReportCategory[] | null,
      cap: number,
    ): Promise<ReportMapPoint[]> {
      // Published + public + not deleted points inside the bbox envelope. ORDER BY recency so that when
      // the area is denser than the cap, the newest reports are the ones sampled.
      const categoryFilter =
        categories !== null && categories.length > 0
          ? sql`AND category IN ${sql(categories)}`
          : sql``
      const rows = await sql<
        { id: string; lng: number; lat: number; category: ReportCategory; status: ReportStatus }[]
      >`
        SELECT id, ST_X(geom) AS lng, ST_Y(geom) AS lat, category, status
        FROM reports
        WHERE status = 'published'
          AND visibility = 'public'
          AND deleted_at IS NULL
          AND ST_Intersects(
                geom,
                ST_MakeEnvelope(${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north}, 4326)
              )
          ${categoryFilter}
        ORDER BY created_at DESC
        LIMIT ${cap}
      `
      return rows.map((r) => ({
        id: r.id,
        lat: r.lat,
        lng: r.lng,
        category: r.category,
        status: r.status,
      }))
    },

    async addFollow(userId: string, reportId: string): Promise<boolean> {
      if (!(await reportExists(sql, reportId))) return false
      // Idempotent upsert: re-following is a no-op (the PK(user_id, report_id) collides -> DO NOTHING).
      await sql`
        INSERT INTO report_follows (user_id, report_id)
        VALUES (${userId}, ${reportId})
        ON CONFLICT (user_id, report_id) DO NOTHING
      `
      return true
    },

    async removeFollow(userId: string, reportId: string): Promise<boolean> {
      if (!(await reportExists(sql, reportId))) return false
      await sql`
        DELETE FROM report_follows WHERE user_id = ${userId} AND report_id = ${reportId}
      `
      return true
    },
  }
}

/**
 * Parse a listMyReports keyset cursor "<iso>|<id>" into its anchor, or null when absent/malformed. For
 * resilience an OLD timestamp-only cursor (no "|id") is still accepted: it falls back to a max-uuid id
 * so the row-value comparison degrades to the previous created_at-only behavior rather than 500ing.
 */
function parseMyReportsCursor(cursor: string | null): { createdAt: Date; id: string } | null {
  if (cursor === null) return null
  const idx = cursor.indexOf("|")
  if (idx < 0) {
    // Legacy/timestamp-only cursor: anchor at the latest possible id for that instant.
    const at = new Date(cursor)
    if (Number.isNaN(at.getTime())) return null
    return { createdAt: at, id: "ffffffff-ffff-ffff-ffff-ffffffffffff" }
  }
  const iso = cursor.slice(0, idx)
  const id = cursor.slice(idx + 1)
  const at = new Date(iso)
  if (Number.isNaN(at.getTime()) || id.length === 0) return null
  return { createdAt: at, id }
}

/** True when a non-deleted report with this id exists. */
async function reportExists(sql: Sql, reportId: string): Promise<boolean> {
  const rows = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM reports WHERE id = ${reportId} AND deleted_at IS NULL LIMIT 1
  `
  return rows.length > 0
}

// Re-export so callers can import the scope constant from the repo module too.
export { REPORT_CREATE_SCOPE }
