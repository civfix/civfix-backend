/**
 * Postgres-backed AdminReportRepository (Phase 2): the production binding of the admin reports seam.
 *
 * Written against the raw postgres-js tag (`Sql`) like the Phase 1 report repo, because every read
 * decodes report geometry (ST_X/ST_Y) and the list aggregates flagged/confirmations/hasPhoto with
 * correlated EXISTS/COUNT subqueries that are clearest as hand-written SQL. Reads touch reports +
 * report_timeline + report_follows + media_assets + jurisdictions + jurisdiction_contacts + abuse_flags
 * + users (+ oauth_identities). Mutations run as single transactions so a status
 * change + its report_timeline row never drift.
 *
 * FLAGGED: a report is "flagged" when it has an OPEN abuse_flag (subject_type 'report', resolved_at
 * NULL). toggleFlag opens one (reason 'manual', source 'api') when none is open, else resolves the open
 * ones. CONFIRMATIONS: COUNT(report_follows) for the report. ROUTING CONTACT: resolved with the same
 * precedence the routing path uses (category-specific jurisdiction_contacts -> default row -> legacy
 * jurisdictions.contact_emails[]). NOTIFY REPORTER: inserts a notifications row (type 'report_update').
 *
 * AUDIT is the route's job (it holds the operator userId); this repo writes the effect + timeline only.
 */

import type postgres from "postgres"
import type { Queryable, Sql } from "../../db/client.js"
import { decodeCursor, encodeCursor, clampLimit } from "./pagination.js"
import { writeAudit } from "./audit.js"
import type {
  AdminReporterRecord,
  AdminReportMediaRecord,
  AdminReportRecord,
  AdminReportRepository,
  AdminReportRoutingRecord,
  AdminReportTimelineRecord,
  ListReportsArgs,
  NotifyReporterInput,
} from "./admin-report-service.js"
import type { AdminReportCounts, AdminReportStatus, ReportCategory } from "@civfix/shared"
import { likeContains } from "./like.js"

/** A composable SQL fragment (postgres.js Fragment); what a `sql\`...\`` expression yields. */
type SqlFragment = postgres.Fragment

/**
 * The report-search predicate (title / jurisdiction name / reporter display-name + handle, plus an exact
 * id match when `q` is a uuid), shared by listReports + countByBucket so the chip counts match the list
 * exactly. Assumes the query LEFT JOINs `jurisdictions j` and `users u`. Empty fragment when q is null.
 */
function searchReportsFragment(sql: Queryable, q: string | null): SqlFragment {
  if (q === null) return sql``
  // SECURITY: escape LIKE metacharacters so %/_ in q match literally (wildcard injection / trigram DoS).
  const like = likeContains(q)
  const idBranch = isUuid(q) ? sql`OR r.id = ${q}::uuid` : sql``
  return sql`AND (
    r.title ILIKE ${like} ESCAPE '\\'
    OR j.name ILIKE ${like} ESCAPE '\\'
    ${idBranch}
    OR u.display_name ILIKE ${like} ESCAPE '\\'
    OR (u.handle::text) ILIKE ${like} ESCAPE '\\'
  )`
}

/** Max media assets returned for a report detail. */
const MEDIA_CAP = 20

/** A reports list/detail row as selected back (geom decoded, reporter joined, aggregates computed). */
interface ReportRowSelect {
  id: string
  category: ReportCategory
  status: AdminReportStatus
  flagged: boolean
  title: string | null
  place: string | null
  address: string | null
  description: string | null
  lat: number
  lng: number
  confirmations: string
  has_photo: boolean
  created_at: Date
  reporter_id: string | null
  reporter_name: string | null
  reporter_handle: string | null
  reporter_email_verified: boolean | null
  reporter_has_oauth: boolean | null
  reporter_joined: Date | null
}

/** Project a selected report row into the structural record the service consumes. */
function toRecord(r: ReportRowSelect): AdminReportRecord {
  const reporter: AdminReporterRecord | null =
    r.reporter_id !== null
      ? {
          id: r.reporter_id,
          name: r.reporter_name ?? "Neighbor",
          handle: r.reporter_handle,
          emailVerified: r.reporter_email_verified ?? false,
          hasOauth: r.reporter_has_oauth ?? false,
          joinedAt: r.reporter_joined,
        }
      : null
  return {
    id: r.id,
    category: r.category,
    status: r.status,
    flagged: r.flagged,
    title: r.title ?? "Untitled report",
    place: r.place ?? "",
    reporter,
    confirmations: Number(r.confirmations ?? "0"),
    address: r.address ?? "",
    desc: r.description ?? "",
    lat: r.lat,
    lng: r.lng,
    hasPhoto: r.has_photo,
    createdAt: r.created_at,
  }
}

/**
 * The shared report SELECT (geom decoded, reporter joined, flagged/confirmations/hasPhoto computed). The
 * `extraWhere` clause narrows it (a single id for detail, the facet filters for the list). The address
 * label is the report's own reverse-geocoded `addr` (0011) when present, falling back to the
 * jurisdiction name when the report carries no address text (older rows / web submissions).
 */
function reportSelect(
  sql: Queryable,
  extraWhere: SqlFragment,
  orderLimit: SqlFragment,
): SqlFragment {
  return sql`
    SELECT
      r.id,
      r.category,
      r.status,
      EXISTS (
        SELECT 1 FROM abuse_flags af
        WHERE af.subject_type = 'report' AND af.subject_id = r.id::text AND af.resolved_at IS NULL
      ) AS flagged,
      r.title,
      j.name AS place,
      COALESCE(NULLIF(r.addr, ''), j.name) AS address,
      r.description,
      ST_Y(r.geom) AS lat,
      ST_X(r.geom) AS lng,
      (SELECT COUNT(*) FROM report_follows rf WHERE rf.report_id = r.id)::text AS confirmations,
      EXISTS (SELECT 1 FROM media_assets m WHERE m.report_id = r.id AND m.status = 'ready') AS has_photo,
      r.created_at,
      u.id AS reporter_id,
      u.display_name AS reporter_name,
      u.handle AS reporter_handle,
      u.email_verified AS reporter_email_verified,
      EXISTS (SELECT 1 FROM oauth_identities oi WHERE oi.user_id = u.id) AS reporter_has_oauth,
      u.created_at AS reporter_joined
    FROM reports r
    LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
    LEFT JOIN users u ON u.id = r.reporter_user_id
    WHERE r.deleted_at IS NULL
    ${extraWhere}
    ${orderLimit}
  `
}

export function makeDrizzleAdminReportRepository(sql: Sql): AdminReportRepository {
  return {
    async listReports(
      args: ListReportsArgs,
    ): Promise<{ records: AdminReportRecord[]; nextCursor: string | null }> {
      const limit = clampLimit(args.limit)
      const anchor = decodeCursor(args.cursor)

      const conds: SqlFragment[] = []
      // A design bucket maps to a SET of civfix statuses (e.g. Submitted = submitted|held|published), so
      // match with `= ANY(array)` rather than a single equality. postgres-js binds a JS string[] natively.
      if (args.statuses !== null && args.statuses.length > 0) {
        conds.push(sql`AND r.status = ANY(${args.statuses})`)
      }
      if (args.flaggedOnly) {
        conds.push(sql`AND EXISTS (
          SELECT 1 FROM abuse_flags af
          WHERE af.subject_type = 'report' AND af.subject_id = r.id::text AND af.resolved_at IS NULL
        )`)
      }
      // The search predicate (title/jurisdiction/reporter, + exact id on a uuid q) is shared with
      // countByBucket via searchReportsFragment (which escapes LIKE metachars) so the chips and the list
      // always agree AND both are protected against wildcard injection.
      if (args.q !== null) conds.push(searchReportsFragment(sql, args.q))
      if (anchor !== null) {
        conds.push(sql`AND (r.created_at, r.id) < (${anchor.createdAt}, ${anchor.id}::uuid)`)
      }
      const extraWhere = conds.reduce<SqlFragment>((acc, c) => sql`${acc} ${c}`, sql``)
      const orderLimit = sql`ORDER BY r.created_at DESC, r.id DESC LIMIT ${limit + 1}`

      const rows = (await reportSelect(sql, extraWhere, orderLimit)) as unknown as ReportRowSelect[]
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      const records = page.map(toRecord)
      const last = page[page.length - 1]
      const nextCursor =
        hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null
      return { records, nextCursor }
    },

    async countByBucket(args: { q: string | null }): Promise<AdminReportCounts> {
      // One aggregate over the searched, non-removed reports: a count per design bucket + the orthogonal
      // flagged count. Mirrors STATUS_BUCKETS (admin-report-service.ts) — keep the status sets in sync.
      const search = searchReportsFragment(sql, args.q)
      const rows = await sql<
        { submitted: string; in_progress: string; completed: string; flagged: string }[]
      >`
        SELECT
          COUNT(*) FILTER (WHERE r.status IN ('submitted', 'held', 'published'))::text AS submitted,
          COUNT(*) FILTER (WHERE r.status IN ('acknowledged', 'in_progress'))::text AS in_progress,
          COUNT(*) FILTER (WHERE r.status = 'resolved')::text AS completed,
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM abuse_flags af
            WHERE af.subject_type = 'report' AND af.subject_id = r.id::text AND af.resolved_at IS NULL
          ))::text AS flagged
        FROM reports r
        LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
        LEFT JOIN users u ON u.id = r.reporter_user_id
        WHERE r.deleted_at IS NULL
        ${search}
      `
      const row = rows[0]
      const submitted = Number(row?.submitted ?? "0")
      const inProgress = Number(row?.in_progress ?? "0")
      const completed = Number(row?.completed ?? "0")
      const flagged = Number(row?.flagged ?? "0")
      return { all: submitted + inProgress + completed, submitted, in_progress: inProgress, completed, flagged }
    },

    async getReport(id: string): Promise<AdminReportRecord | null> {
      const rows = (await reportSelect(
        sql,
        sql`AND r.id = ${id}`,
        sql`LIMIT 1`,
      )) as unknown as ReportRowSelect[]
      return rows[0] ? toRecord(rows[0]) : null
    },

    async listTimeline(id: string): Promise<AdminReportTimelineRecord[]> {
      const rows = await sql<
        {
          status: AdminReportStatus
          note: string | null
          who: string | null
          created_at: Date
        }[]
      >`
        SELECT
          t.status,
          t.note,
          COALESCE(u.display_name, u.handle) AS who,
          t.created_at
        FROM report_timeline t
        LEFT JOIN users u ON u.id = t.actor_id
        WHERE t.report_id = ${id}
        ORDER BY t.created_at ASC, t.id ASC
      `
      return rows.map((r) => ({
        status: r.status,
        note: r.note,
        who: r.who ?? "system",
        createdAt: r.created_at,
      }))
    },

    async getRouting(id: string): Promise<AdminReportRoutingRecord | null> {
      // Resolve the routing contact with the precedence the routing path uses: a category-specific
      // jurisdiction_contacts row -> the default (category NULL) row -> the legacy contact_emails[].
      const rows = await sql<
        {
          geoid: string | null
          place: string | null
          category: ReportCategory
          cat_email: string | null
          default_email: string | null
          legacy_email: string | null
        }[]
      >`
        SELECT
          j.geoid,
          j.name AS place,
          r.category,
          (SELECT jc.email FROM jurisdiction_contacts jc
             WHERE jc.geoid = j.geoid AND jc.category = r.category
               AND jc.email IS NOT NULL AND jc.email <> '' LIMIT 1) AS cat_email,
          (SELECT jc.email FROM jurisdiction_contacts jc
             WHERE jc.geoid = j.geoid AND jc.category IS NULL
               AND jc.email IS NOT NULL AND jc.email <> '' LIMIT 1) AS default_email,
          (SELECT j.contact_emails[1]) AS legacy_email
        FROM reports r
        LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
        WHERE r.id = ${id}
        LIMIT 1
      `
      const row = rows[0]
      if (!row) return null
      const contact = row.cat_email ?? row.default_email ?? row.legacy_email ?? null
      return {
        geoid: row.geoid,
        dept: row.place ?? "",
        place: row.place ?? "",
        contact,
        routed: contact !== null,
      }
    },

    async listMedia(id: string): Promise<AdminReportMediaRecord[]> {
      const rows = await sql<
        { id: string; kind: "image" | "video"; r2_key: string; thumb_key: string | null }[]
      >`
        SELECT id, kind, r2_key, thumb_key
        FROM media_assets
        WHERE report_id = ${id} AND status = 'ready'
        ORDER BY created_at ASC
        LIMIT ${MEDIA_CAP}
      `
      return rows.map((m) => ({
        id: m.id,
        kind: m.kind,
        // Raw object-store KEYS; the admin report SERVICE presigns them (deps.presignMedia over the Storage
        // seam) into browser-loadable URLs, exactly like the citizen report DTO's toMediaDTO. Only
        // status='ready' media is returned (in-flight/held/rejected assets excluded), so the detail's
        // "reporter photo" box never points at a non-renderable asset.
        r2Key: m.r2_key,
        thumbKey: m.thumb_key,
      }))
    },

    async setStatus(
      id: string,
      input: { status: AdminReportStatus; note: string; actorId: string | null },
    ): Promise<boolean> {
      return sql.begin(async (tx) => {
        const updated = await tx<{ id: string }[]>`
          UPDATE reports SET status = ${input.status}
          WHERE id = ${id} AND deleted_at IS NULL
          RETURNING id
        `
        if (updated.length === 0) return false
        await tx`
          INSERT INTO report_timeline (report_id, status, note, actor_id)
          VALUES (${id}, ${input.status}, ${input.note}, ${input.actorId})
        `
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "report.status_changed",
          target: `report:${id}`,
          meta: { status: input.status },
        })
        return true
      })
    },

    async toggleFlag(
      id: string,
      input: { reason: string | null; actorId: string | null },
    ): Promise<boolean | null> {
      return sql.begin(async (tx) => {
        const exists = await tx<{ status: AdminReportStatus }[]>`
          SELECT status FROM reports WHERE id = ${id} AND deleted_at IS NULL LIMIT 1
        `
        const report = exists[0]
        if (!report) return null

        const open = await tx<{ id: string }[]>`
          SELECT id FROM abuse_flags
          WHERE subject_type = 'report' AND subject_id = ${id} AND resolved_at IS NULL
        `
        let nowFlagged: boolean
        if (open.length > 0) {
          // Currently flagged -> resolve the open flag(s) (unflag).
          await tx`
            UPDATE abuse_flags SET resolved_at = now()
            WHERE subject_type = 'report' AND subject_id = ${id} AND resolved_at IS NULL
          `
          nowFlagged = false
        } else {
          await tx`
            INSERT INTO abuse_flags (subject_type, subject_id, reason, source)
            VALUES ('report', ${id}, 'manual', 'api')
          `
          nowFlagged = true
        }
        await tx`
          INSERT INTO report_timeline (report_id, status, note, actor_id)
          VALUES (
            ${id}, ${report.status},
            ${nowFlagged ? "Flagged for review" : "Flag cleared"},
            ${input.actorId}
          )
        `
        await writeAudit(tx, {
          actorId: input.actorId,
          action: nowFlagged ? "report.flagged" : "report.unflagged",
          target: `report:${id}`,
          meta: { reason: input.reason },
        })
        return nowFlagged
      })
    },

    async remove(id: string, input: { note: string; actorId: string | null }): Promise<boolean> {
      return sql.begin(async (tx) => {
        const updated = await tx<{ id: string }[]>`
          UPDATE reports SET status = 'rejected', deleted_at = now()
          WHERE id = ${id} AND deleted_at IS NULL
          RETURNING id
        `
        if (updated.length === 0) return false
        await tx`
          INSERT INTO report_timeline (report_id, status, note, actor_id)
          VALUES (${id}, 'rejected', ${input.note}, ${input.actorId})
        `
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "report.removed",
          target: `report:${id}`,
          meta: { note: input.note },
        })
        return true
      })
    },

    async notifyReporter(input: NotifyReporterInput): Promise<void> {
      await sql`
        INSERT INTO notifications (user_id, type, title, body, link)
        VALUES (${input.reporterUserId}, 'report_update', ${input.title}, ${input.body}, ${input.link})
      `
    },

    async appendFollowup(
      id: string,
      input: {
        note: string
        actorId: string | null
        to: "reporter" | "city"
        destination: string
      },
    ): Promise<void> {
      // The followup timeline row carries the report's current status (a follow-up is not a transition);
      // audit the follow-up in the same transaction so the timeline + audit row never drift.
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO report_timeline (report_id, status, note, actor_id)
          SELECT ${id}, r.status, ${input.note}, ${input.actorId}
          FROM reports r WHERE r.id = ${id}
        `
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "report.followup_sent",
          target: `report:${id}`,
          meta: { to: input.to, destination: input.destination },
        })
      })
    },
  }
}

/** Loose uuid shape check so a non-uuid `q` search never trips a Postgres cast error on `q::uuid`. */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}
