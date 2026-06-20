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
import type { ReportDTO, ReportCategory, ReportStatus, ReportType } from "@civfix/shared"

/** Postgres unique-violation SQLSTATE; surfaced on the idempotency-key race. */
const PG_UNIQUE_VIOLATION = "23505"

/** Shape of a report row as selected back (geom decoded to lng/lat via ST_X/ST_Y). */
interface ReportRowSelect {
  id: string
  reporter_user_id: string | null
  anon_session_id: string | null
  category: ReportCategory
  type: ReportType
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
    type: r.type,
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
    id, reporter_user_id, anon_session_id, category, type, title, description, addr, status, visibility,
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

  /**
   * Batched media load for a page of report ids: one `report_id = ANY(...)` query (mirrors the
   * notification repo's `ANY(${ids}::uuid[])` idiom), grouped into a Map<reportId, media[]>. Selecting
   * report_id and ordering by (report_id, created_at) preserves the same per-report `created_at ASC`
   * order as the single-report loadMedia. The returned views are UNFILTERED (status filtering is applied
   * by the caller, exactly like loadMedia vs findMediaForReport).
   */
  async function loadMediaForReports(
    reportIds: string[],
  ): Promise<Map<string, ReportMediaView[]>> {
    const grouped = new Map<string, ReportMediaView[]>()
    if (reportIds.length === 0) return grouped
    const rows = await sql<
      {
        report_id: string
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
      SELECT report_id, id, kind, codec, r2_key, thumb_key, status, width, height
      FROM media_assets
      WHERE report_id = ANY(${reportIds}::uuid[])
      ORDER BY report_id, created_at ASC
    `
    for (const m of rows) {
      const view: ReportMediaView = {
        id: m.id,
        kind: m.kind,
        codec: m.codec,
        r2Key: m.r2_key,
        thumbKey: m.thumb_key,
        status: m.status,
        width: m.width,
        height: m.height,
      }
      const list = grouped.get(m.report_id)
      if (list) list.push(view)
      else grouped.set(m.report_id, [view])
    }
    return grouped
  }

  /**
   * Batched timeline load for a page of report ids: one `report_id = ANY(...)` query grouped into a
   * Map<reportId, timeline[]>. Ordering by (report_id, created_at ASC, id ASC) preserves the same
   * per-report order as loadTimeline. report_timeline is NOT partitioned, so a flat ANY scan over
   * report_timeline_report_idx (report_id, created_at) is the right access path.
   */
  async function loadTimelineForReports(
    reportIds: string[],
  ): Promise<Map<string, ReportTimelineView[]>> {
    const grouped = new Map<string, ReportTimelineView[]>()
    if (reportIds.length === 0) return grouped
    const rows = await sql<
      { report_id: string; status: ReportStatus; note: string | null; created_at: Date }[]
    >`
      SELECT report_id, status, note, created_at
      FROM report_timeline
      WHERE report_id = ANY(${reportIds}::uuid[])
      ORDER BY report_id, created_at ASC, id ASC
    `
    for (const t of rows) {
      const view: ReportTimelineView = { status: t.status, note: t.note, createdAt: t.created_at }
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
          // 1) Insert the report. geom is built from the point in SQL; geom_source stored verbatim.
          await tx`
            INSERT INTO reports (
              id, reporter_user_id, idempotency_key, geom, geom_source, jurisdiction_geoid,
              category, type, title, description, addr, status, visibility, h3_cell, published_at
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
              ${args.publishedAt}
            )
          `

          // 2) Attach media: set report_id ONLY when the asset is unattached or already ours. A foreign
          // asset (bound to another report) is left untouched - never stolen. Unknown ids no-op.
          // Set-based UPDATE over all upload ids in ONE round-trip (postgres-js array binding) instead of a
          // per-id loop, so attaching N photos costs one statement inside the create tx rather than N.
          // Skipped when there are no ids, since `IN ()` is invalid SQL. Semantics unchanged.
          if (args.mediaUploadIds.length > 0) {
            await tx`
              UPDATE media_assets
              SET report_id = ${args.reportId}
              WHERE upload_id IN ${tx(args.mediaUploadIds)}
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

    async findMediaForReport(reportId: string, ownerView = false): Promise<ReportMediaView[]> {
      // PUBLIC read path (GET /reports/:id for a stranger): only `ready` media is shown. A held(NSFW)/
      // rejected asset must stay hidden (showing it would leak moderated content - a moderation bypass),
      // and a `validating` asset has not been processed/moderated yet.
      // OWNER EXCEPTION (ownerView): when the viewer IS the report's owner, ALSO include their own
      // in-flight `validating` uploads so they immediately see a photo they just attached, before the
      // async media.checks worker flips it to `ready` (the presigned r2_key URL already resolves to the
      // bytes the client PUT). `held`/`rejected` stay hidden even from the owner - those are deliberate
      // moderation removals. The create-tx snapshot reads loadMedia() DIRECTLY (unfiltered) so a new
      // report's just-attached `validating` media still lands in its frozen idempotency snapshot.
      const media = await loadMedia(sql, reportId)
      return media.filter((m) => m.status === "ready" || (ownerView && m.status === "validating"))
    },

    async countValidatingMediaForReport(reportId: string): Promise<number> {
      // Total in-flight (`validating`) media for the report, for ALL viewers — backs the DTO's
      // `mediaPending`. `held`/`rejected` are deliberately excluded (moderation outcomes, never "pending").
      // Returns just a count, never the rows, so no unprocessed key/URL is ever read into the read path.
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
      // Same status visibility as findMediaForReport, applied per group after the single batched read.
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

    async findTimelineForReports(
      reportIds: string[],
    ): Promise<Map<string, ReportTimelineView[]>> {
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
      // One query for the whole page: which of these report ids does the user follow? Mirrors the
      // single isFollowing probe (PK(user_id, report_id)) but batched over the page via ANY(uuid[]).
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
      types: ReportType[] | null,
      cap: number,
    ): Promise<ReportMapPoint[]> {
      // Published + public + not deleted points inside the bbox envelope. ORDER BY recency so that when
      // the area is denser than the cap, the newest reports are the ones sampled.
      const categoryFilter =
        categories !== null && categories.length > 0
          ? sql`AND r.category IN ${sql(categories)}`
          : sql``
      // Fine-grained type filter (0021): applied ALONGSIDE the category filter (AND), mirroring it.
      const typeFilter =
        types !== null && types.length > 0 ? sql`AND r.type IN ${sql(types)}` : sql``
      // First-photo preview per pin: a LATERAL subquery picks the report's earliest VISIBLE (`ready`)
      // media — the same status visibility the public detail read uses (held/rejected/validating stay
      // hidden) — ordered exactly like findMediaForReport (created_at ASC, id ASC). We project its key
      // pair (thumb_key, r2_key); the service presigns it into the pin's thumbUrl (the repo never signs).
      // LEFT JOIN LATERAL so a report with no visible media still returns one row with null keys (no pin
      // is dropped). title comes straight off the report row.
      const rows = await sql<
        {
          id: string
          lng: number
          lat: number
          category: ReportCategory
          type: ReportType
          status: ReportStatus
          title: string | null
          description: string | null
          thumb_key: string | null
          r2_key: string | null
        }[]
      >`
        SELECT
          r.id,
          ST_X(r.geom) AS lng,
          ST_Y(r.geom) AS lat,
          r.category,
          r.type,
          r.status,
          r.title,
          r.description,
          m.thumb_key,
          m.r2_key
        FROM reports r
        LEFT JOIN LATERAL (
          SELECT thumb_key, r2_key
          FROM media_assets
          WHERE report_id = r.id
            AND kind = 'image'
            AND status = 'ready'
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        ) m ON true
        WHERE r.status = 'published'
          AND r.visibility = 'public'
          AND r.deleted_at IS NULL
          AND ST_Intersects(
                r.geom,
                ST_MakeEnvelope(${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north}, 4326)
              )
          ${categoryFilter}
          ${typeFilter}
        ORDER BY r.created_at DESC
        LIMIT ${cap}
      `
      return rows.map((r) => ({
        id: r.id,
        lat: r.lat,
        lng: r.lng,
        category: r.category,
        type: r.type,
        status: r.status,
        title: r.title,
        description: r.description,
        thumbKey: r.thumb_key,
        r2Key: r.r2_key,
      }))
    },

    async searchReports(args: {
      q: string | null
      categories: ReportCategory[] | null
      types: ReportType[] | null
      cursor: string | null
      limit: number
    }): Promise<{ points: ReportMapPoint[]; nextCursor: string | null }> {
      // Public report search. Same status/visibility gate as the map (published + public + not deleted) and
      // the SAME first-visible-photo LATERAL preview. Two optional narrowings:
      //   - q: a case-insensitive substring match on title OR address (ILIKE). The needle is escaped so a
      //     user-typed % / _ is matched literally (not a wildcard), then wrapped in %…%.
      //   - categories: an IN (...) over the report category.
      // Keyset pagination reuses the EXACT (created_at DESC, id DESC) total order + "<iso>|<id>" row-value
      // cursor as listMyReports, and fetches limit+1 to compute nextCursor without a second COUNT.
      const anchor = parseMyReportsCursor(args.cursor)
      const cursorFilter =
        anchor !== null
          ? sql`AND (r.created_at, r.id) < (${anchor.createdAt}, ${anchor.id}::uuid)`
          : sql``
      const categoryFilter =
        args.categories !== null && args.categories.length > 0
          ? sql`AND r.category IN ${sql(args.categories)}`
          : sql``
      // Fine-grained type filter (0021): applied ALONGSIDE the category filter (AND), mirroring it.
      const typeFilter =
        args.types !== null && args.types.length > 0
          ? sql`AND r.type IN ${sql(args.types)}`
          : sql``
      // ILIKE text filter on title OR addr. Escape the LIKE metacharacters (\, %, _) in the user needle so a
      // literal % / _ does not act as a wildcard, then surround with %…% for a substring match. ESCAPE '\'
      // makes the backslash the explicit escape char. Skipped entirely when q is null (no text narrowing).
      const textFilter =
        args.q !== null
          ? (() => {
              const needle = `%${args.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
              return sql`AND (r.title ILIKE ${needle} ESCAPE '\' OR r.addr ILIKE ${needle} ESCAPE '\')`
            })()
          : sql``
      const rows = await sql<
        {
          id: string
          lng: number
          lat: number
          category: ReportCategory
          type: ReportType
          status: ReportStatus
          title: string | null
          description: string | null
          thumb_key: string | null
          r2_key: string | null
          created_at: Date
        }[]
      >`
        SELECT
          r.id,
          ST_X(r.geom) AS lng,
          ST_Y(r.geom) AS lat,
          r.category,
          r.type,
          r.status,
          r.title,
          r.description,
          m.thumb_key,
          m.r2_key,
          r.created_at
        FROM reports r
        LEFT JOIN LATERAL (
          SELECT thumb_key, r2_key
          FROM media_assets
          WHERE report_id = r.id
            AND kind = 'image'
            AND status = 'ready'
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        ) m ON true
        WHERE r.status = 'published'
          AND r.visibility = 'public'
          AND r.deleted_at IS NULL
          ${categoryFilter}
          ${typeFilter}
          ${textFilter}
          ${cursorFilter}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${args.limit + 1}
      `
      const hasMore = rows.length > args.limit
      const page = hasMore ? rows.slice(0, args.limit) : rows
      const last = page[page.length - 1]
      const nextCursor = hasMore && last ? `${last.created_at.toISOString()}|${last.id}` : null
      const points: ReportMapPoint[] = page.map((r) => ({
        id: r.id,
        lat: r.lat,
        lng: r.lng,
        category: r.category,
        type: r.type,
        status: r.status,
        title: r.title,
        description: r.description,
        thumbKey: r.thumb_key,
        r2Key: r.r2_key,
      }))
      return { points, nextCursor }
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

    async resolveByOwner(
      reportId: string,
      userId: string,
      input: { status: ReportStatus; note: string },
    ): Promise<"updated" | "not_found" | "forbidden"> {
      // One transaction: lock + read the row to check ownership, then flip the status and append the
      // timeline entry atomically. FOR UPDATE serializes concurrent owner toggles on the same report.
      return sql.begin(async (tx) => {
        const rows = await tx<{ reporter_user_id: string | null; deleted_at: Date | null }[]>`
          SELECT reporter_user_id, deleted_at
          FROM reports
          WHERE id = ${reportId}
          LIMIT 1
          FOR UPDATE
        `
        const row = rows[0]
        // Missing OR soft-deleted -> not_found (a deleted report is gone for everyone, including the owner).
        if (!row || row.deleted_at !== null) return "not_found"
        // Only the human reporter who created it can change its status here.
        if (row.reporter_user_id !== userId) return "forbidden"

        await tx`UPDATE reports SET status = ${input.status} WHERE id = ${reportId}`
        await tx`
          INSERT INTO report_timeline (report_id, status, note, actor_id)
          VALUES (${reportId}, ${input.status}, ${input.note}, ${userId})
        `
        return "updated"
      })
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
  // id is cast `${anchor.id}::uuid` downstream; reject a non-UUID (would 22P02 -> 500), degrade to start.
  if (Number.isNaN(at.getTime()) || !CURSOR_UUID_RE.test(id)) return null
  return { createdAt: at, id }
}

/** Canonical UUID shape, validated before a cursor id reaches a `::uuid` cast. */
const CURSOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True when a non-deleted report with this id exists. */
async function reportExists(sql: Sql, reportId: string): Promise<boolean> {
  const rows = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM reports WHERE id = ${reportId} AND deleted_at IS NULL LIMIT 1
  `
  return rows.length > 0
}

// Re-export so callers can import the scope constant from the repo module too.
export { REPORT_CREATE_SCOPE }
