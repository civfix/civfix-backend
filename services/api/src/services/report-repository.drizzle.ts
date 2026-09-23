import type postgres from "postgres"
import { AppError } from "@civfix/shared"
import type {
  ReportCategory,
  ReportDTO,
  ReportStatus,
  ReportType,
  ReportVisibility,
} from "@civfix/shared"
import type { Queryable, Sql } from "../db/client.js"
import {
  keysetInstant,
  keysetPredicate,
  paginateKeyset,
  parseKeysetCursor,
} from "../db/cursor-helpers.js"
import { isPubliclyVisibleStatus, ownerStatusTransition } from "./report-visibility.js"
import { allocateReportReferenceCode } from "../db/reference-code.js"
import { escapeLike } from "./admin/like.js"
import type {
  BBox,
  CreateReportTxArgs,
  CreateReportTxResult,
  OwnerToggleStatus,
  ReportMapPoint,
  ReportMediaView,
  ReportRecord,
  ReportRepository,
  ReportTimelineView,
  ReportVisibilityTimelineKind,
} from "./report-service.types.js"
import { REPORT_CREATE_SCOPE } from "./report-service.types.js"
import { servedKeyExpr, servableMediaFilter } from "./media-served-key.js"
import { claimableAsReportMedia } from "./media-bindings.js"
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
import { touchUserActivity } from "../db/sql/user-activity.js"

type SqlFragment = postgres.Fragment

const PG_UNIQUE_VIOLATION = "23505"

const REPORT_SEARCH_MIN_QUERY_LENGTH = 3

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  )
}

function notOwnerOutcome(row: {
  status: ReportStatus
  visibility: ReportVisibility
}): "not_found" | "forbidden" {
  const publiclyVisible = isPubliclyVisibleStatus(row.status) && row.visibility === "public"
  return publiclyVisible ? "forbidden" : "not_found"
}

export function makeDrizzleReportRepository(sql: Sql): ReportRepository {
  async function readSnapshot(
    key: string,
    scope: string,
    userOrAnon: string | null,
  ): Promise<ReportDTO | null> {
    const rows = await sql<{ response_snapshot: ReportDTO }[]>`
      SELECT response_snapshot
      FROM idempotency_keys
      WHERE key = ${key}
        AND scope = ${scope}
        AND user_or_anon IS NOT DISTINCT FROM ${userOrAnon}
      LIMIT 1
    `
    return rows[0]?.response_snapshot ?? null
  }

  async function loadMedia(tag: Queryable, reportId: string): Promise<ReportMediaView[]> {
    const rows = await tag<MediaRowSelect[]>`
      SELECT id, kind, codec, ${servedKeyExpr(tag, "media_assets")} AS r2_key,
             thumb_key, status, width, height
      FROM media_assets
      WHERE report_id = ${reportId}
        AND ${servableMediaFilter(tag, "media_assets")}
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

  async function loadMediaForReports(reportIds: string[]): Promise<Map<string, ReportMediaView[]>> {
    const grouped = new Map<string, ReportMediaView[]>()
    if (reportIds.length === 0) return grouped
    const rows = await sql<(MediaRowSelect & { report_id: string })[]>`
      SELECT report_id, id, kind, codec, ${servedKeyExpr(sql, "media_assets")} AS r2_key,
             thumb_key, status, width, height
      FROM media_assets
      WHERE report_id = ANY(${reportIds}::uuid[])
        AND ${servableMediaFilter(sql, "media_assets")}
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

  async function loadTimelineForReports(
    reportIds: string[],
  ): Promise<Map<string, ReportTimelineView[]>> {
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
    async findIdempotentSnapshot(
      key: string,
      scope: string,
      userOrAnon: string | null,
    ): Promise<ReportDTO | null> {
      return readSnapshot(key, scope, userOrAnon)
    },

    async createReportTx(args: CreateReportTxArgs): Promise<CreateReportTxResult> {
      try {
        const snapshot = await sql.begin(async (tx) => {
          const referenceCode = await allocateReportReferenceCode(tx, args.type, args.jurCode)

          await tx`
            INSERT INTO reports (
              id, reporter_user_id, idempotency_key, geom, geom_source, jurisdiction_geoid,
              category, type, title, description, addr, addr_source, addr_precision, status,
              visibility, h3_cell, reference_code,
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
              ${args.addrSource},
              ${args.addrPrecision},
              ${args.status},
              ${args.visibility},
              ${args.h3Cell},
              ${referenceCode},
              ${args.publishedAt}
            )
          `

          if (args.mediaUploadIds.length > 0) {
            // An asset bound to a post, a chat/DM message or any other owner is never re-bindable to a
            // report, or the holder of an uploadId could cross-publish private media into a public
            // report gallery.
            const claimed = await tx<{ upload_id: string }[]>`
              UPDATE media_assets
              SET report_id = ${args.reportId}
              WHERE upload_id IN ${tx(args.mediaUploadIds)}
                AND (report_id IS NULL OR report_id = ${args.reportId})
                AND post_id IS NULL AND chat_message_id IS NULL
                AND ${claimableAsReportMedia(tx)}
                AND (status = 'ready' OR (status = 'validating' AND finalized_at IS NOT NULL))
              RETURNING upload_id
            `
            if (claimed.length !== new Set(args.mediaUploadIds).size) {
              throw AppError.validation({
                mediaUploadIds: "One or more media uploads are unavailable.",
              })
            }
          }

          await tx`
            INSERT INTO report_timeline (report_id, status, note, actor_id)
            VALUES (${args.reportId}, ${args.status}, ${args.timelineNote}, ${args.reporterUserId})
          `

          const rows = await tx<ReportRowSelect[]>`
            SELECT ${reportColumns(tx)} FROM reports WHERE id = ${args.reportId} LIMIT 1
          `
          if (!rows[0]) throw AppError.internal("report row vanished mid-create-transaction")
          const record = toRecord(rows[0])
          if (args.reporterUserId !== null) {
            await touchUserActivity(tx, {
              userId: args.reporterUserId,
              lng: record.lng,
              lat: record.lat,
              at: record.createdAt,
            })
          }
          const media = await loadMedia(tx, args.reportId)
          const timeline = await loadTimeline(tx, args.reportId)
          const dto = await args.buildSnapshot(record, media, timeline)

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
          const stored = await readSnapshot(
            args.idempotency.key,
            args.idempotency.scope,
            args.idempotency.userOrAnon,
          )
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
      const rows = await sql<ReportRowSelect[]>`
        SELECT ${reportColumns(sql)} FROM reports WHERE reference_code = ${code} LIMIT 1
      `
      return rows[0] ? toRecord(rows[0]) : null
    },

    async findMediaForReport(reportId: string, ownerView = false): Promise<ReportMediaView[]> {
      const media = await loadMedia(sql, reportId)
      return media.filter((m) => m.status === "ready" || (ownerView && m.status === "validating"))
    },

    async countValidatingMediaForReport(reportId: string): Promise<number> {
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

    async listMyReports(
      userId: string,
      cursor: string | null,
      limit: number,
    ): Promise<{ records: ReportRecord[]; nextCursor: string | null }> {
      const anchor = parseKeysetCursor(cursor)
      const cursorFilter: SqlFragment =
        anchor !== null ? sql`AND ${keysetPredicate(sql, sql`created_at`, sql`id`, anchor)}` : sql``
      const rows = await sql<(ReportRowSelect & { cursor_at: string | null })[]>`
        SELECT ${reportColumns(sql)}, ${keysetInstant(sql, sql`created_at`)} AS cursor_at
        FROM reports
        WHERE reporter_user_id = ${userId}
          AND deleted_at IS NULL
          ${cursorFilter}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}
      `
      const { items, nextCursor } = paginateKeyset(rows, limit, (r) => ({
        atText: r.cursor_at,
        id: r.id,
      }))
      return { records: items.map(toRecord), nextCursor }
    },

    async findMapCandidates(
      bbox: BBox,
      categories: ReportCategory[] | null,
      types: ReportType[] | null,
      cap: number,
    ): Promise<ReportMapPoint[]> {
      const categoryFilter: SqlFragment =
        categories !== null && categories.length > 0
          ? sql`AND r.category IN ${sql(categories)}`
          : sql``
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
      if (args.q !== null && args.q.length < REPORT_SEARCH_MIN_QUERY_LENGTH) {
        return { points: [], nextCursor: null }
      }
      const anchor = parseKeysetCursor(args.cursor)
      const cursorFilter: SqlFragment =
        anchor !== null
          ? sql`AND ${keysetPredicate(sql, sql`r.created_at`, sql`r.id`, anchor)}`
          : sql``
      const categoryFilter: SqlFragment =
        args.categories !== null && args.categories.length > 0
          ? sql`AND r.category IN ${sql(args.categories)}`
          : sql``
      const typeFilter: SqlFragment =
        args.types !== null && args.types.length > 0 ? sql`AND r.type IN ${sql(args.types)}` : sql``
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
      const { items, nextCursor } = paginateKeyset(rows, args.limit, (r) => ({
        atText: r.cursor_at,
        id: r.id,
      }))
      return { points: items.map(toMapPoint), nextCursor }
    },

    async resolveByOwner(
      reportId: string,
      userId: string,
      input: { status: OwnerToggleStatus; note: string },
    ): Promise<"updated" | "unchanged" | "not_found" | "forbidden" | "invalid_state"> {
      return sql.begin(async (tx) => {
        const rows = await tx<
          {
            reporter_user_id: string | null
            deleted_at: Date | null
            status: ReportStatus
            visibility: ReportVisibility
          }[]
        >`
          SELECT reporter_user_id, deleted_at, status, visibility
          FROM reports
          WHERE id = ${reportId}
          LIMIT 1
          FOR UPDATE
        `
        const row = rows[0]
        if (!row || row.deleted_at !== null) return "not_found"
        if (row.reporter_user_id !== userId) return notOwnerOutcome(row)
        const transition = ownerStatusTransition(row.status, input.status)
        if (transition !== "apply") return transition

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
      input: { visibility: ReportVisibility; note: string; kind: ReportVisibilityTimelineKind },
    ): Promise<"updated" | "unchanged" | "not_found" | "forbidden"> {
      return sql.begin(async (tx) => {
        const rows = await tx<
          {
            reporter_user_id: string | null
            deleted_at: Date | null
            status: ReportStatus
            visibility: ReportVisibility
          }[]
        >`
          SELECT reporter_user_id, deleted_at, status, visibility
          FROM reports
          WHERE id = ${reportId}
          LIMIT 1
          FOR UPDATE
        `
        const row = rows[0]
        if (!row || row.deleted_at !== null) return "not_found"
        if (row.reporter_user_id !== userId) return notOwnerOutcome(row)
        if (row.visibility === input.visibility) return "unchanged"

        await tx`UPDATE reports SET visibility = ${input.visibility} WHERE id = ${reportId}`
        await tx`
          INSERT INTO report_timeline (report_id, status, note, kind, actor_id)
          VALUES (${reportId}, ${row.status}, ${input.note}, ${input.kind}, ${userId})
        `
        return "updated"
      })
    },
  }
}

export { REPORT_CREATE_SCOPE }
