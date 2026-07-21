/**
 * Postgres-backed AdminReportRepository: the production binding of the admin reports seam, hand-written
 * over the raw postgres-js tag (`Sql`) because reads decode geometry (ST_X/ST_Y) and aggregate
 * flagged/confirmations/hasPhoto with correlated EXISTS/COUNT subqueries. Mutations run as single
 * transactions so a status change + its report_timeline row never drift.
 *
 * FLAGGED: a report is "flagged" when it has an OPEN abuse_flag (subject_type 'report', resolved_at
 * NULL). ROUTING CONTACT precedence: category-specific jurisdiction_contacts -> default (category NULL)
 * row -> legacy jurisdictions.contact_emails[]. AUDIT is the route's job (it holds the operator userId);
 * this repo writes the effect + timeline only.
 */

import type postgres from "postgres"
import type { Queryable, Sql } from "../../db/client.js"
import { decodeCursor, clampLimit, paginate } from "./pagination.js"
import { isUuid } from "../../db/cursor-helpers.js"
import { writeAudit } from "./audit.js"
import { STATUS_BUCKETS } from "./admin-report-status.js"
import {
  REPORT_VERIFIED_THRESHOLD,
  type AdminReporterRecord,
  type AdminReportMediaRecord,
  type AdminReportRecord,
  type AdminReportRepository,
  type AdminReportRoutingRecord,
  type AdminReportTimelineRecord,
  type ListReportsArgs,
  type NotifyReporterInput,
} from "./admin-report-service.js"
import type {
  AdminReportCounts,
  AdminReportStatus,
  ReportCategory,
  ReportOutreachStatus,
  ReportTimelineItem,
} from "@civfix/shared"
import { likeContains } from "./like.js"

/** A composable SQL fragment (postgres.js Fragment); what a `sql\`...\`` expression yields. */
type SqlFragment = postgres.Fragment

// A bucket count saturates at this cap so countByBucket scans at most ~cap*3 rows instead of running an
// exact COUNT(*) over an unbounded reports table on every chip refresh (the chip just needs "this many or
// more"). Above the cap the counts are an estimate.
const FACET_COUNT_CAP = 999

/** A report is flagged when it has an OPEN abuse_flag (subject_type 'report', resolved_at NULL). */
function flaggedReportExpr(sql: Queryable): SqlFragment {
  return sql`EXISTS (
    SELECT 1 FROM abuse_flags af
    WHERE af.subject_type = 'report' AND af.subject_id = r.id::text AND af.resolved_at IS NULL
  )`
}

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
  reference_code: string | null
  verification_verdict: "approved" | "rejected" | null
  verified_at: Date | null
  reporter_report_verified: boolean | null
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
    referenceCode: r.reference_code,
    verificationVerdict: r.verification_verdict,
    verifiedAt: r.verified_at,
    reporterReportVerified: r.reporter_report_verified,
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
      ${flaggedReportExpr(sql)} AS flagged,
      r.title,
      j.name AS place,
      COALESCE(NULLIF(r.addr, ''), j.name) AS address,
      r.description,
      ST_Y(r.geom) AS lat,
      ST_X(r.geom) AS lng,
      -- confirmations was the report_follows count; that table was dropped with the discussion system.
      -- Kept as a stable admin DTO field (always 0 now) so the admin UI neighbors-confirmed row still parses.
      '0'::text AS confirmations,
      EXISTS (SELECT 1 FROM media_assets m WHERE m.report_id = r.id AND m.status = 'ready') AS has_photo,
      r.created_at,
      r.reference_code,
      r.verification_verdict,
      r.verified_at,
      -- The reporter's earned report-verified flag (D7); null for an anonymous report (no user_moderation
      -- row joins), false when the reporter has a user row but no moderation row yet.
      CASE WHEN u.id IS NULL THEN NULL ELSE COALESCE(um.report_verified, false) END AS reporter_report_verified,
      u.id AS reporter_id,
      u.display_name AS reporter_name,
      u.handle AS reporter_handle,
      u.email_verified AS reporter_email_verified,
      EXISTS (SELECT 1 FROM oauth_identities oi WHERE oi.user_id = u.id) AS reporter_has_oauth,
      u.created_at AS reporter_joined
    FROM reports r
    LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
    LEFT JOIN users u ON u.id = r.reporter_user_id
    LEFT JOIN user_moderation um ON um.user_id = r.reporter_user_id
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
      const anchor = decodeCursor(args.cursor, true)

      const conds: SqlFragment[] = []
      // A design bucket maps to a SET of civfix statuses (e.g. Submitted = submitted|held|published), so
      // match with `= ANY(array)` rather than a single equality. postgres-js binds a JS string[] natively.
      if (args.statuses !== null && args.statuses.length > 0) {
        conds.push(sql`AND r.status = ANY(${args.statuses})`)
      }
      if (args.flaggedOnly) conds.push(sql`AND ${flaggedReportExpr(sql)}`)
      if (args.q !== null) conds.push(searchReportsFragment(sql, args.q))
      if (anchor !== null) {
        conds.push(sql`AND (r.created_at, r.id) < (${anchor.createdAt}, ${anchor.id}::uuid)`)
      }
      const extraWhere = conds.reduce<SqlFragment>((acc, c) => sql`${acc} ${c}`, sql``)
      const orderLimit = sql`ORDER BY r.created_at DESC, r.id DESC LIMIT ${limit + 1}`

      const rows = (await reportSelect(sql, extraWhere, orderLimit)) as unknown as ReportRowSelect[]
      const { items, nextCursor } = paginate(rows, limit, (r) => ({ at: r.created_at, id: r.id }))
      return { records: items.map(toRecord), nextCursor }
    },

    async countByBucket(args: { q: string | null }): Promise<AdminReportCounts> {
      // One aggregate over the searched, non-removed reports: a count per design bucket + the orthogonal
      // flagged count, each capped at FACET_COUNT_CAP so a huge table doesn't force an O(rows) exact count
      // on a hot chip refresh. The FILTER predicates derive from the canonical STATUS_BUCKETS, so the
      // chips and the list can't drift.
      const search = searchReportsFragment(sql, args.q)
      const cap = FACET_COUNT_CAP
      const rows = await sql<
        { submitted: string; in_progress: string; completed: string; flagged: string }[]
      >`
        SELECT
          LEAST(COUNT(*) FILTER (WHERE r.status = ANY(${STATUS_BUCKETS.submitted})), ${cap})::text AS submitted,
          LEAST(COUNT(*) FILTER (WHERE r.status = ANY(${STATUS_BUCKETS.in_progress})), ${cap})::text AS in_progress,
          LEAST(COUNT(*) FILTER (WHERE r.status = ANY(${STATUS_BUCKETS.completed})), ${cap})::text AS completed,
          LEAST(COUNT(*) FILTER (WHERE ${flaggedReportExpr(sql)}), ${cap})::text AS flagged
        FROM (
          SELECT r.id, r.status
          FROM reports r
          LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
          LEFT JOIN users u ON u.id = r.reporter_user_id
          WHERE r.deleted_at IS NULL
          ${search}
          LIMIT ${cap * 3 + 1}
        ) r
      `
      const row = rows[0]
      const submitted = Number(row?.submitted ?? "0")
      const inProgress = Number(row?.in_progress ?? "0")
      const completed = Number(row?.completed ?? "0")
      const flagged = Number(row?.flagged ?? "0")
      const all = Math.min(submitted + inProgress + completed, cap)
      return { all, submitted, in_progress: inProgress, completed, flagged }
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
          forward_subject_template: string | null
          forward_body_template: string | null
        }[]
      >`
        SELECT
          j.geoid,
          j.name AS place,
          r.category,
          j.forward_subject_template,
          j.forward_body_template,
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
        forwardSubjectTemplate: row.forward_subject_template,
        forwardBodyTemplate: row.forward_body_template,
      }
    },

    async getOutreach(id: string): Promise<{
      status: ReportOutreachStatus
      threadId: string | null
      routedTo: string | null
      routedAt: string | null
    }> {
      // The newest per-report mail thread (report_id = id) + its OUT-message aggregates (latest to_addr,
      // earliest created_at) and whether any inbound reply has landed. One row (or none -> not_sent).
      const rows = await sql<
        {
          thread_id: string
          thread_status: string
          has_inbound: boolean
          routed_to: string | null
          routed_at: Date | null
        }[]
      >`
        SELECT
          t.id AS thread_id,
          t.status AS thread_status,
          EXISTS (
            SELECT 1 FROM mail_messages m WHERE m.thread_id = t.id AND m.direction = 'in'
          ) AS has_inbound,
          (
            SELECT m.to_addr FROM mail_messages m
            WHERE m.thread_id = t.id AND m.direction = 'out' AND m.to_addr IS NOT NULL AND m.to_addr <> ''
            ORDER BY m.created_at DESC, m.id DESC LIMIT 1
          ) AS routed_to,
          (
            SELECT MIN(m.created_at) FROM mail_messages m
            WHERE m.thread_id = t.id AND m.direction = 'out'
          ) AS routed_at
        FROM mail_threads t
        WHERE t.report_id = ${id}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT 1
      `
      const row = rows[0]
      if (!row) {
        return { status: "not_sent", threadId: null, routedTo: null, routedAt: null }
      }
      return {
        status: mapOutreachStatus(row.thread_status, row.has_inbound),
        threadId: row.thread_id,
        routedTo: row.routed_to,
        routedAt: row.routed_at ? row.routed_at.toISOString() : null,
      }
    },

    async appendSystemTimeline(
      id: string,
      input: { note: string; kind: ReportTimelineItem["kind"]; body?: string | null },
    ): Promise<void> {
      // A non-transition system row at the report's CURRENT status, actor NULL, no audit (used by the
      // inbound reply side-effects). D13: persist `kind` + the full `body` (0031 added both columns) so the
      // public timeline can tag the entry + render the full reply collapsibly; `note` stays the preview.
      await sql`
        INSERT INTO report_timeline (report_id, status, note, kind, body, actor_id)
        SELECT ${id}, r.status, ${input.note}, ${input.kind ?? null}, ${input.body ?? null}, NULL
        FROM reports r WHERE r.id = ${id}
      `
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
      // Raw object-store keys; the service presigns them over the Storage seam. Only status='ready'
      // assets are returned so the detail never points at a non-renderable upload.
      return rows.map((m) => ({
        id: m.id,
        kind: m.kind,
        r2Key: m.r2_key,
        thumbKey: m.thumb_key,
      }))
    },

    async setStatus(
      id: string,
      input: {
        status: AdminReportStatus
        note: string
        actorId: string | null
        kind?: ReportTimelineItem["kind"]
        body?: string | null
      },
    ): Promise<boolean> {
      return sql.begin(async (tx) => {
        const updated = await tx<{ id: string }[]>`
          UPDATE reports SET status = ${input.status}
          WHERE id = ${id} AND deleted_at IS NULL
          RETURNING id
        `
        if (updated.length === 0) return false
        // D13: an inbound city reply that also advances the report persists kind + the full body alongside
        // the transition; a plain operator transition passes neither (both default NULL).
        await tx`
          INSERT INTO report_timeline (report_id, status, note, kind, body, actor_id)
          VALUES (${id}, ${input.status}, ${input.note}, ${input.kind ?? null}, ${input.body ?? null}, ${input.actorId})
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

    async setReportVerdict(
      id: string,
      input: { verdict: "approved" | "rejected"; actorId: string | null },
    ): Promise<boolean> {
      return sql.begin(async (tx) => {
        // Write the verdict cols (idempotent: re-setting the same verdict re-stamps verified_by/at). Returns
        // the reporter so an approved verdict can recompute that reporter's approved-count in the SAME tx.
        const updated = await tx<{ reporter_user_id: string | null }[]>`
          UPDATE reports
          SET verification_verdict = ${input.verdict},
              verified_by = ${input.actorId},
              verified_at = now()
          WHERE id = ${id} AND deleted_at IS NULL
          RETURNING reporter_user_id
        `
        const row = updated[0]
        if (!row) return false
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "report.verdict_set",
          target: `report:${id}`,
          meta: { verdict: input.verdict },
        })

        // Only an `approved` verdict for a non-anon reporter can earn report_verified. A `rejected` verdict
        // never counts and never resets an earned flag (D7). An anonymous report writes the verdict above
        // (bookkeeping) but the count query filters reporter_user_id IS NOT NULL, so it never flips.
        const reporter = row.reporter_user_id
        if (input.verdict !== "approved" || reporter === null) return true

        // Recompute the reporter's approved, non-deleted report count. Re-approving an already-approved
        // report is a no-op (the recompute is idempotent). At/above the threshold, flip report_verified to
        // true if not already set — UPSERTing the user_moderation row (it is created lazily) and relying on
        // its NOT NULL column defaults for the rest, exactly like the D8 grandfather / setUserReportVerified.
        const counted = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n
          FROM reports
          WHERE reporter_user_id = ${reporter}
            AND verification_verdict = 'approved'
            AND deleted_at IS NULL
        `
        const approvedCount = counted[0]?.n ?? 0
        if (approvedCount < REPORT_VERIFIED_THRESHOLD) return true

        await tx`
          INSERT INTO user_moderation (user_id, report_verified, report_verified_at, report_verified_by, updated_at)
          VALUES (${reporter}, true, now(), ${input.actorId}, now())
          ON CONFLICT (user_id) DO UPDATE SET
            report_verified = true,
            report_verified_at = COALESCE(user_moderation.report_verified_at, now()),
            report_verified_by = COALESCE(user_moderation.report_verified_by, ${input.actorId}),
            updated_at = now()
          WHERE user_moderation.report_verified = false
        `
        return true
      })
    },
  }
}

/**
 * Map a per-report mail thread's status + whether an inbound reply landed onto the report's outreach
 * status. Precedence: bounced > replied (inbound message OR thread 'replied') > delivered
 * (delivered/opened) > sent. Imported by the memory repo so the two stay in lockstep.
 */
export function mapOutreachStatus(
  threadStatus: string,
  hasInbound: boolean,
): ReportOutreachStatus {
  if (threadStatus === "bounced") return "bounced"
  if (hasInbound || threadStatus === "replied") return "replied"
  if (threadStatus === "delivered" || threadStatus === "opened") return "delivered"
  return "sent"
}
