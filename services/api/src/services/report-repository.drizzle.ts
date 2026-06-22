/**
 * Postgres-backed ReportRepository (the production impl of the reports persistence seam).
 *
 * Written against the raw postgres-js tag (`Sql`) rather than the Drizzle query builder because every
 * report touches PostGIS geometry (ST_SetSRID(ST_MakePoint(lng,lat),4326) on write; ST_X/ST_Y on read),
 * which Drizzle does not model. Using one tag throughout also lets the create flow run as a SINGLE
 * postgres-js transaction (sql.begin), which is what guarantees the no-duplicate + no-orphan idempotency
 * contract.
 *
 * CREATE TRANSACTION (createReportTx) — all four steps in ONE transaction:
 *   1. INSERT the report row (geom from the point, geom_source verbatim, h3_cell precomputed).
 *   2. Attach media: set report_id ONLY when the asset is unattached or already ours (a foreign asset is
 *      never stolen; unknown ids no-op) — orphan-safe + theft-safe.
 *   3. INSERT the initial timeline row.
 *   4. Read the rows back, build the DTO snapshot, and INSERT it into idempotency_keys.response_snapshot.
 *   If UNIQUE(idempotency_key) on reports (or the PK on idempotency_keys) trips because a concurrent
 *   submit won the race, the transaction rolls back and we read + return the winner's stored snapshot as a
 *   "replayed" result (no duplicate row, no orphaned media, the original report id returned).
 */

import type postgres from "postgres"
import { AppError } from "@civfix/shared"
import type { ReportCategory, ReportDTO, ReportStatus, ReportType, ReportVisibility } from "@civfix/shared"
import type { Queryable, Sql } from "../db/client.js"
import { encodeTimeCursor, parseTimeCursor } from "../db/cursor-helpers.js"
import { allocateReportReferenceCode } from "../db/reference-code.js"
import { escapeLike } from "./admin/like.js"
import type {
  BBox,
  CreateReportTxArgs,
  CreateReportTxResult,
  ReportMapPoint,
  ReportMediaView,
  ReportRecord,
  ReportRepository,
  ReportTimelineView,
} from "./report-service.types.js"
import { REPORT_CREATE_SCOPE } from "./report-service.types.js"
import {
  reportColumns,
  selectPublicPins,
  toMapPoint,
  toMediaView,
  toRecord,
  toTimelineView,
  type MediaRowSelect,
  type ReportRowSelect,
  type TimelineRowSelect,
} from "./report-sql.js"

type SqlFragment = postgres.Fragment

const PG_UNIQUE_VIOLATION = "23505"

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  )
}

export function makeDrizzleReportRepository(sql: Sql): ReportRepository {
  // Typed as ReportDTO. Used by the fast path and the idempotency-race path.
  async function readSnapshot(key: string, scope: string): Promise<ReportDTO | null> {
    const rows = await sql<{ response_snapshot: ReportDTO }[]>`
      SELECT response_snapshot
      FROM idempotency_keys
      WHERE key = ${key} AND scope = ${scope}
      LIMIT 1
    `
    return rows[0]?.response_snapshot ?? null
  }

  // tag is passed (tx-scoped or the pool) so the create-tx reads share the transaction.
  async function loadMedia(tag: Queryable, reportId: string): Promise<ReportMediaView[]> {
    const rows = await tag<MediaRowSelect[]>`
      SELECT id, kind, codec, r2_key, thumb_key, status, width, height
      FROM media_assets
      WHERE report_id = ${reportId}
      ORDER BY created_at ASC
    `
    return rows.map(toMediaView)
  }

  async function loadTimeline(tag: Queryable, reportId: string): Promise<ReportTimelineView[]> {
    const rows = await tag<TimelineRowSelect[]>`
      SELECT status, note, kind, body, created_at
      FROM report_timeline
      WHERE report_id = ${reportId}
      ORDER BY created_at ASC, id ASC
    `
    return rows.map(toTimelineView)
  }

  // Batched media load for a page of report ids: one `report_id = ANY(...)` query grouped into a Map.
  // Ordering by (report_id, created_at) preserves the same per-report order as loadMedia. The returned
  // views are UNFILTERED (status filtering is applied by the caller, like loadMedia vs findMediaForReport).
  async function loadMediaForReports(reportIds: string[]): Promise<Map<string, ReportMediaView[]>> {
    const grouped = new Map<string, ReportMediaView[]>()
    if (reportIds.length === 0) return grouped
    const rows = await sql<(MediaRowSelect & { report_id: string })[]>`
      SELECT report_id, id, kind, codec, r2_key, thumb_key, status, width, height
      FROM media_assets
      WHERE report_id = ANY(${reportIds}::uuid[])
      ORDER BY report_id, created_at ASC
    `
    for (const m of rows) {
      const view = toMediaView(m)
      const list = grouped.get(m.report_id)
      if (list) list.push(view)
      else grouped.set(m.report_id, [view])
    }
    return grouped
  }

  // Batched timeline load for a page of report ids. report_timeline is NOT partitioned, so a flat ANY scan
  // over report_timeline_report_idx (report_id, created_at) is the right access path.
  async function loadTimelineForReports(reportIds: string[]): Promise<Map<string, ReportTimelineView[]>> {
    const grouped = new Map<string, ReportTimelineView[]>()
    if (reportIds.length === 0) return grouped
    const rows = await sql<(TimelineRowSelect & { report_id: string })[]>`
      SELECT report_id, status, note, kind, body, created_at
      FROM report_timeline
      WHERE report_id = ANY(${reportIds}::uuid[])
      ORDER BY report_id, created_at ASC, id ASC
    `
    for (const t of rows) {
      const view = toTimelineView(t)
      const list = grouped.get(t.report_id)
      if (list) list.push(view)
      else grouped.set(t.report_id, [view])
    }
    return grouped
  }

  return {
    async findIdempotentSnapshot(key: string, scope: string): Promise<ReportDTO | null> {
      return readSnapshot(key, scope)
    },

    async createReportTx(args: CreateReportTxArgs): Promise<CreateReportTxResult> {
      try {
        const snapshot = await sql.begin(async (tx) => {
          // D4 LOCK ORDER: allocate the reference code FIRST (the reference_counters upsert must precede
          // any reports row lock so every create path takes the counter lock before the report lock — a
          // consistent acquisition order rules out an ABBA deadlock). jurCode is resolved pre-tx (0 when the
          // report has no resolved jurisdiction, D5), so a NULL jurisdiction yields a "{TYPECODE}:0" scope.
          const referenceCode = await allocateReportReferenceCode(tx, args.type, args.jurCode)

          await tx`
            INSERT INTO reports (
              id, reporter_user_id, idempotency_key, geom, geom_source, jurisdiction_geoid,
              category, type, title, description, addr, status, visibility, h3_cell, reference_code,
              published_at
            ) VALUES (
              ${args.reportId},
              ${args.reporterUserId},
              ${args.idempotencyKey},
              ST_SetSRID(ST_MakePoint(${args.lng}, ${args.lat}), 4326),
              ${args.geomSource},
              ${args.jurisdictionGeoid},
              ${args.category},
              ${args.type},
              ${args.title},
              ${args.description},
              ${args.addr},
              ${args.status},
              ${args.visibility},
              ${args.h3Cell},
              ${referenceCode},
              ${args.publishedAt}
            )
          `

          // Set-based attach over all upload ids in ONE round-trip. A foreign asset (bound to another
          // report) is left untouched — never stolen. Unknown ids no-op. Skipped when there are no ids
          // (`IN ()` is invalid SQL).
          if (args.mediaUploadIds.length > 0) {
            await tx`
              UPDATE media_assets
              SET report_id = ${args.reportId}
              WHERE upload_id IN ${tx(args.mediaUploadIds)}
                AND (report_id IS NULL OR report_id = ${args.reportId})
            `
          }

          await tx`
            INSERT INTO report_timeline (report_id, status, note, actor_id)
            VALUES (${args.reportId}, ${args.status}, ${args.timelineNote}, ${args.reporterUserId})
          `

          const rows = await tx<ReportRowSelect[]>`
            SELECT ${reportColumns(tx)} FROM reports WHERE id = ${args.reportId} LIMIT 1
          `
          // The row was just inserted in this tx, so an empty result is an impossible-state corruption
          // rather than a normal miss — surface it as a 500 instead of a raw TypeError on a non-null assert.
          if (!rows[0]) throw AppError.internal("report row vanished mid-create-transaction")
          const record = toRecord(rows[0])
          const media = await loadMedia(tx, args.reportId)
          const timeline = await loadTimeline(tx, args.reportId)
          const dto = await args.buildSnapshot(record, media, timeline)

          // json() is a connection-independent value marker, so the outer `sql.json` is equivalent to a
          // tx-scoped one — the DTO lands as jsonb rather than being interpolated.
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
        if (isUniqueViolation(err)) {
          // A concurrent submit won the idempotency-key race. Normally the winner's snapshot is already
          // committed; return it as a "replayed" result. If the loser observed the conflict BEFORE the
          // winner's snapshot landed, stored is null — surface a typed conflict (retryable) rather than
          // re-throwing a raw 23505 as a 500.
          const stored = await readSnapshot(args.idempotency.key, args.idempotency.scope)
          if (stored) return { kind: "replayed", snapshot: stored }
          throw AppError.conflict("Report create is still settling; retry")
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

    async findReportByReferenceCode(code: string): Promise<ReportRecord | null> {
      // reference_code is UNIQUE (reports_reference_code_uidx), so this resolves at most one row — the
      // by-code half of the resolve-either getReport (issue #56). Soft-deleted rows are included so the
      // service can 404 them exactly like findReportById.
      const rows = await sql<ReportRowSelect[]>`
        SELECT ${reportColumns(sql)} FROM reports WHERE reference_code = ${code} LIMIT 1
      `
      return rows[0] ? toRecord(rows[0]) : null
    },

    async findMediaForReport(reportId: string, ownerView = false): Promise<ReportMediaView[]> {
      // PUBLIC read (a stranger): only `ready` media. A held(NSFW)/rejected asset must stay hidden (a
      // moderation bypass) and a `validating` asset has not been processed/moderated yet. OWNER EXCEPTION:
      // the owner ALSO sees their own in-flight `validating` uploads (the presigned r2_key already resolves
      // to the bytes they PUT) so a just-attached photo shows before the worker flips it to `ready`;
      // `held`/`rejected` stay hidden even from the owner. The create-tx snapshot reads loadMedia()
      // DIRECTLY (unfiltered) so a new report's `validating` media still lands in its frozen snapshot.
      const media = await loadMedia(sql, reportId)
      return media.filter((m) => m.status === "ready" || (ownerView && m.status === "validating"))
    },

    async countValidatingMediaForReport(reportId: string): Promise<number> {
      // Returns just a count, never the rows, so no unprocessed key/URL is read into the read path.
      // `held`/`rejected` are excluded (moderation outcomes, never "pending").
      const rows = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM media_assets
        WHERE report_id = ${reportId} AND status = 'validating'
      `
      return rows[0]?.n ?? 0
    },

    async findMediaForReports(
      reportIds: string[],
      ownerView = false,
    ): Promise<Map<string, ReportMediaView[]>> {
      const grouped = await loadMediaForReports(reportIds)
      for (const [id, media] of grouped) {
        grouped.set(
          id,
          media.filter((m) => m.status === "ready" || (ownerView && m.status === "validating")),
        )
      }
      return grouped
    },

    async findTimelineForReport(reportId: string): Promise<ReportTimelineView[]> {
      return loadTimeline(sql, reportId)
    },

    async findTimelineForReports(reportIds: string[]): Promise<Map<string, ReportTimelineView[]>> {
      return loadTimelineForReports(reportIds)
    },

    async isFollowing(userId: string, reportId: string): Promise<boolean> {
      const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM report_follows
        WHERE user_id = ${userId} AND report_id = ${reportId}
        LIMIT 1
      `
      return rows.length > 0
    },

    async findFollowedReportIds(userId: string, reportIds: string[]): Promise<Set<string>> {
      if (reportIds.length === 0) return new Set()
      const rows = await sql<{ report_id: string }[]>`
        SELECT report_id FROM report_follows
        WHERE user_id = ${userId} AND report_id = ANY(${reportIds}::uuid[])
      `
      return new Set(rows.map((r) => r.report_id))
    },

    async listMyReports(
      userId: string,
      cursor: string | null,
      limit: number,
    ): Promise<{ records: ReportRecord[]; nextCursor: string | null }> {
      // Keyset over (created_at DESC, id DESC). The (created_at, id) tuple makes the cursor a strict total
      // successor of the last row seen, so a page boundary that splits two reports sharing a created_at
      // can't drop a row.
      const anchor = parseTimeCursor(cursor)
      const cursorFilter: SqlFragment =
        anchor !== null
          ? sql`AND (created_at, id) < (${anchor.at}, ${anchor.id}::uuid)`
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
        hasMore && last ? encodeTimeCursor({ at: last.created_at, id: last.id }) : null
      return { records, nextCursor }
    },

    async findMapCandidates(
      bbox: BBox,
      categories: ReportCategory[] | null,
      types: ReportType[] | null,
      cap: number,
    ): Promise<ReportMapPoint[]> {
      // Published + public + not deleted points inside the bbox envelope. ST_Intersects + && is index-
      // assisted by reports_geom_gist; ORDER BY recency so a denser-than-cap area samples the newest.
      const categoryFilter: SqlFragment =
        categories !== null && categories.length > 0 ? sql`AND r.category IN ${sql(categories)}` : sql``
      const typeFilter: SqlFragment =
        types !== null && types.length > 0 ? sql`AND r.type IN ${sql(types)}` : sql``
      const extraFilters = sql`
        AND ST_Intersects(
              r.geom,
              ST_MakeEnvelope(${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north}, 4326)
            )
        ${categoryFilter}
        ${typeFilter}
      `
      const rows = await selectPublicPins(sql, extraFilters, sql`ORDER BY r.created_at DESC`, cap)
      return rows.map(toMapPoint)
    },

    async searchReports(args: {
      q: string | null
      categories: ReportCategory[] | null
      types: ReportType[] | null
      cursor: string | null
      limit: number
    }): Promise<{ points: ReportMapPoint[]; nextCursor: string | null }> {
      // Same status/visibility gate + first-visible-photo LATERAL as the map. Keyset reuses the EXACT
      // (created_at DESC, id DESC) order + "<iso>|<id>" cursor as listMyReports; fetches limit+1 to derive
      // nextCursor without a second COUNT.
      const anchor = parseTimeCursor(args.cursor)
      const cursorFilter: SqlFragment =
        anchor !== null
          ? sql`AND (r.created_at, r.id) < (${anchor.at}, ${anchor.id}::uuid)`
          : sql``
      const categoryFilter: SqlFragment =
        args.categories !== null && args.categories.length > 0
          ? sql`AND r.category IN ${sql(args.categories)}`
          : sql``
      const typeFilter: SqlFragment =
        args.types !== null && args.types.length > 0 ? sql`AND r.type IN ${sql(args.types)}` : sql``
      // ILIKE on title OR addr; escapeLike makes a user-typed % / _ match literally (pairs with ESCAPE
      // '\\', the like.ts contract). Skipped when q is null (no text narrowing).
      const textFilter: SqlFragment =
        args.q !== null
          ? (() => {
              const needle = `%${escapeLike(args.q)}%`
              return sql`AND (r.title ILIKE ${needle} ESCAPE '\\' OR r.addr ILIKE ${needle} ESCAPE '\\')`
            })()
          : sql``
      const extraFilters = sql`${categoryFilter} ${typeFilter} ${textFilter} ${cursorFilter}`
      const rows = await selectPublicPins(
        sql,
        extraFilters,
        sql`ORDER BY r.created_at DESC, r.id DESC`,
        args.limit + 1,
      )
      const hasMore = rows.length > args.limit
      const page = hasMore ? rows.slice(0, args.limit) : rows
      const last = page[page.length - 1]
      const nextCursor =
        hasMore && last ? encodeTimeCursor({ at: last.created_at, id: last.id }) : null
      return { points: page.map(toMapPoint), nextCursor }
    },

    async addFollow(userId: string, reportId: string): Promise<boolean> {
      if (!(await reportExists(sql, reportId))) return false
      // Idempotent upsert: re-following collides on PK(user_id, report_id) -> DO NOTHING.
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

    async resolveByOwner(
      reportId: string,
      userId: string,
      input: { status: ReportStatus; note: string },
    ): Promise<"updated" | "not_found" | "forbidden"> {
      // FOR UPDATE serializes concurrent owner toggles on the same report.
      return sql.begin(async (tx) => {
        const rows = await tx<{ reporter_user_id: string | null; deleted_at: Date | null }[]>`
          SELECT reporter_user_id, deleted_at
          FROM reports
          WHERE id = ${reportId}
          LIMIT 1
          FOR UPDATE
        `
        const row = rows[0]
        if (!row || row.deleted_at !== null) return "not_found"
        if (row.reporter_user_id !== userId) return "forbidden"

        await tx`UPDATE reports SET status = ${input.status} WHERE id = ${reportId}`
        await tx`
          INSERT INTO report_timeline (report_id, status, note, actor_id)
          VALUES (${reportId}, ${input.status}, ${input.note}, ${userId})
        `
        return "updated"
      })
    },

    async setVisibilityByOwner(
      reportId: string,
      userId: string,
      input: { visibility: ReportVisibility; note: string },
    ): Promise<"updated" | "not_found" | "forbidden"> {
      // FOR UPDATE serializes concurrent owner toggles. Status is deliberately NOT changed (a visibility
      // change is not a lifecycle transition), so the appended timeline row reuses the CURRENT status read
      // under the same lock.
      return sql.begin(async (tx) => {
        const rows = await tx<
          { reporter_user_id: string | null; deleted_at: Date | null; status: ReportStatus }[]
        >`
          SELECT reporter_user_id, deleted_at, status
          FROM reports
          WHERE id = ${reportId}
          LIMIT 1
          FOR UPDATE
        `
        const row = rows[0]
        if (!row || row.deleted_at !== null) return "not_found"
        if (row.reporter_user_id !== userId) return "forbidden"

        await tx`UPDATE reports SET visibility = ${input.visibility} WHERE id = ${reportId}`
        await tx`
          INSERT INTO report_timeline (report_id, status, note, actor_id)
          VALUES (${reportId}, ${row.status}, ${input.note}, ${userId})
        `
        return "updated"
      })
    },
  }
}

// True when a non-deleted report with this id exists.
async function reportExists(sql: Sql, reportId: string): Promise<boolean> {
  const rows = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM reports WHERE id = ${reportId} AND deleted_at IS NULL LIMIT 1
  `
  return rows.length > 0
}

export { REPORT_CREATE_SCOPE }
