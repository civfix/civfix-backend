import type { FastifyBaseLogger } from "fastify"
import type { Queryable, Sql } from "../../db/client.js"
import {
  decodeCursor,
  clampLimit,
  keysetInstant,
  keysetPredicate,
  paginateKeyset,
} from "./pagination.js"
import { isUuid } from "../../db/cursor-helpers.js"
import { writeAudit } from "./audit.js"
import {
  andAll,
  firstUsableLegacyContactExpr,
  ilikeAnyOf,
  usableContactRowExpr,
  type SqlFragment,
} from "./sql-fragments.js"
import { personSelect, toPersonRecord } from "./admin-person.js"
import { STATUS_BUCKETS, toTimelineKind } from "./admin-report-status.js"
import {
  REPORT_VERIFIED_THRESHOLD,
  type AdminReporterRecord,
  type AdminReportMediaRecord,
  type AdminReportRecord,
  type AdminReportRepository,
  type AdminReportRoutingRecord,
  type AdminReportTimelineRecord,
  type ListReportsArgs,
  type ReportOutreachState,
} from "./admin-report-types.js"
import type {
  AdminReportCounts,
  AdminReportStatus,
  ReportCategory,
  ReportOutreachStatus,
  ReportTimelineItem,
  ReportVisibility,
} from "@civfix/shared"
import {
  ROUTE_CLAIM_STALE_SECONDS,
  ROUTE_DEADLINE_INFLIGHT_SECONDS,
} from "./outbound-send-policy.js"
import { sendFailedExpr, sendInFlightExpr } from "./outbound-send-sql.js"

export { ROUTE_CLAIM_STALE_SECONDS, ROUTE_DEADLINE_INFLIGHT_SECONDS }

const ROUTE_LOCK_NAMESPACE = 0x7cf17e01

export function flaggedReportExpr(sql: Queryable): SqlFragment {
  return sql`EXISTS (
    SELECT 1 FROM abuse_flags af
    WHERE af.subject_type = 'report' AND af.subject_id = r.id::text AND af.resolved_at IS NULL
  )`
}

function searchReportsFragment(sql: Queryable, q: string | null): SqlFragment {
  if (q === null) return sql``
  const exact: SqlFragment[] = [sql`r.reference_code = upper(btrim(${q}))`]
  if (isUuid(q)) exact.push(sql`r.id = ${q}::uuid`)
  return sql`AND ${ilikeAnyOf(
    sql,
    [sql`r.title`, sql`r.addr`, sql`j.name`, sql`u.display_name`, sql`u.handle::text`],
    q,
    exact,
  )}`
}

const MEDIA_CAP = 20

const UNTITLED_REPORT_TITLE = "Untitled report"
const UNNAMED_REPORTER_NAME = "Neighbor"

interface ReportRowSelect {
  id: string
  category: ReportCategory
  status: AdminReportStatus
  visibility: ReportVisibility
  flagged: boolean
  title: string | null
  place: string | null
  address: string | null
  description: string | null
  lat: number
  lng: number
  confirmations: string
  has_photo: boolean
  preview_id: string | null
  preview_kind: "image" | "video" | null
  preview_key: string | null
  preview_thumb_key: string | null
  created_at: Date
  cursor_at: string | null
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

function toRecord(r: ReportRowSelect): AdminReportRecord {
  const reporter: AdminReporterRecord | null = toPersonRecord(
    {
      id: r.reporter_id,
      name: r.reporter_name,
      handle: r.reporter_handle,
      emailVerified: r.reporter_email_verified,
      hasOauth: r.reporter_has_oauth,
      joinedAt: r.reporter_joined,
    },
    UNNAMED_REPORTER_NAME,
  )
  return {
    id: r.id,
    category: r.category,
    status: r.status,
    visibility: r.visibility,
    flagged: r.flagged,
    title: r.title ?? UNTITLED_REPORT_TITLE,
    place: r.place ?? "",
    reporter,
    confirmations: Number(r.confirmations ?? "0"),
    address: r.address ?? "",
    desc: r.description ?? "",
    lat: r.lat,
    lng: r.lng,
    hasPhoto: r.has_photo,
    previewMedia:
      r.preview_id !== null && r.preview_kind !== null && r.preview_key !== null
        ? {
            id: r.preview_id,
            kind: r.preview_kind,
            r2Key: r.preview_key,
            thumbKey: r.preview_thumb_key,
          }
        : null,
    createdAt: r.created_at,
    referenceCode: r.reference_code,
    verificationVerdict: r.verification_verdict,
    verifiedAt: r.verified_at,
    reporterReportVerified: r.reporter_report_verified,
  }
}

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
      r.visibility,
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
      EXISTS (SELECT 1 FROM media_assets m WHERE m.report_id = r.id AND m.status = 'ready' AND m.served_key IS NOT NULL) AS has_photo,
      pm.id AS preview_id,
      pm.kind AS preview_kind,
      pm.served_key AS preview_key,
      pm.thumb_key AS preview_thumb_key,
      r.created_at,
      ${keysetInstant(sql, sql`r.created_at`)} AS cursor_at,
      r.reference_code,
      r.verification_verdict,
      r.verified_at,
      -- The reporter's earned report-verified flag; null for an anonymous report (no user_moderation
      -- row joins), false when the reporter has a user row but no moderation row yet.
      CASE WHEN u.id IS NULL THEN NULL ELSE COALESCE(um.report_verified, false) END AS reporter_report_verified,
      ${personSelect(sql, "u", "reporter")}
    FROM reports r
    LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
    LEFT JOIN users u ON u.id = r.reporter_user_id
    LEFT JOIN user_moderation um ON um.user_id = r.reporter_user_id
    LEFT JOIN LATERAL (
      SELECT pa.id, pa.kind, pa.served_key, pa.thumb_key
      FROM media_assets pa
      WHERE pa.report_id = r.id AND pa.status = 'ready' AND pa.served_key IS NOT NULL
      ORDER BY (pa.kind = 'image') DESC, pa.created_at ASC, pa.id ASC
      LIMIT 1
    ) pm ON TRUE
    WHERE r.deleted_at IS NULL
    ${extraWhere}
    ${orderLimit}
  `
}

export function makeDrizzleAdminReportRepository(
  sql: Sql,
  opts: { logger?: Pick<FastifyBaseLogger, "warn"> } = {},
): AdminReportRepository {
  return {
    async listReports(
      args: ListReportsArgs,
    ): Promise<{ records: AdminReportRecord[]; nextCursor: string | null }> {
      const limit = clampLimit(args.limit)
      const anchor = decodeCursor(args.cursor, true)

      const conds: SqlFragment[] = []
      if (args.statuses !== null && args.statuses.length > 0) {
        conds.push(sql`AND r.status = ANY(${args.statuses})`)
      }
      if (args.flaggedOnly) conds.push(sql`AND ${flaggedReportExpr(sql)}`)
      if (args.needsVerificationOnly) conds.push(sql`AND r.verification_verdict IS NULL`)
      if (args.q !== null) conds.push(searchReportsFragment(sql, args.q))
      if (anchor !== null) {
        conds.push(sql`AND ${keysetPredicate(sql, sql`r.created_at`, sql`r.id`, anchor)}`)
      }
      const extraWhere = andAll(sql, conds)
      const orderLimit = sql`ORDER BY r.created_at DESC, r.id DESC LIMIT ${limit + 1}`

      const rows = (await reportSelect(sql, extraWhere, orderLimit)) as unknown as ReportRowSelect[]
      const { items, nextCursor } = paginateKeyset(rows, limit, (r) => ({
        atText: r.cursor_at,
        id: r.id,
      }))
      return { records: items.map(toRecord), nextCursor }
    },

    async countByBucket(args: { q: string | null }): Promise<AdminReportCounts> {
      const search = searchReportsFragment(sql, args.q)
      const flaggedSearch = searchReportsFragment(sql, args.q)
      const rows = await sql<
        {
          submitted: string
          in_progress: string
          completed: string
          flagged: string
          needs_verification: string
        }[]
      >`
        SELECT
          COUNT(*) FILTER (WHERE r.status = ANY(${STATUS_BUCKETS.submitted}))::text AS submitted,
          COUNT(*) FILTER (
            WHERE r.status = ANY(${STATUS_BUCKETS.submitted}) AND r.verification_verdict IS NULL
          )::text AS needs_verification,
          COUNT(*) FILTER (WHERE r.status = ANY(${STATUS_BUCKETS.in_progress}))::text AS in_progress,
          COUNT(*) FILTER (WHERE r.status = ANY(${STATUS_BUCKETS.completed}))::text AS completed,
          (
            SELECT COUNT(DISTINCT af.subject_id)
            FROM abuse_flags af
            JOIN reports r ON r.id::text = af.subject_id
            LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
            LEFT JOIN users u ON u.id = r.reporter_user_id
            WHERE af.subject_type = 'report'
              AND af.resolved_at IS NULL
              AND r.deleted_at IS NULL
              ${flaggedSearch}
          )::text AS flagged
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
      const needsVerification = Number(row?.needs_verification ?? "0")
      const all = submitted + inProgress + completed
      return { all, submitted, in_progress: inProgress, completed, flagged, needsVerification }
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
          kind: string | null
          who: string | null
          created_at: Date
        }[]
      >`
        SELECT
          t.status,
          t.note,
          t.kind,
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
        kind: toTimelineKind(r.kind),
        who: r.who ?? "system",
        createdAt: r.created_at,
      }))
    },

    async getRouting(id: string): Promise<AdminReportRoutingRecord | null> {
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
               AND ${usableContactRowExpr(sql, "jc")} LIMIT 1) AS cat_email,
          (SELECT jc.email FROM jurisdiction_contacts jc
             WHERE jc.geoid = j.geoid AND jc.category IS NULL
               AND ${usableContactRowExpr(sql, "jc")} LIMIT 1) AS default_email,
          ${firstUsableLegacyContactExpr(sql, "j")} AS legacy_email
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

    async getOutreach(id: string): Promise<ReportOutreachState> {
      const rows = await sql<
        {
          thread_id: string
          thread_status: string
          has_inbound: boolean
          routed_to: string | null
          routed_at: Date | null
          packet_sent: boolean
          send_failed: boolean
          send_in_flight: boolean
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
          ) AS routed_at,
          EXISTS (
            SELECT 1 FROM mail_messages m
            WHERE m.thread_id = t.id AND m.direction = 'out'
              AND COALESCE(m.kind, 'packet') = 'packet'
          ) AS packet_sent,
          (${sendFailedExpr(sql, sql`t.id`)}) AS send_failed,
          (${sendInFlightExpr(sql, sql`t.id`)}) AS send_in_flight
        FROM mail_threads t
        WHERE t.report_id = ${id}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT 1
      `
      const row = rows[0]
      if (!row) {
        return {
          status: "not_sent",
          threadId: null,
          routedTo: null,
          routedAt: null,
          packetSent: false,
          sendFailed: false,
          sendInFlight: false,
        }
      }
      return {
        status: mapOutreachStatus(row.thread_status, row.has_inbound),
        threadId: row.thread_id,
        routedTo: row.routed_to,
        routedAt: row.routed_at ? row.routed_at.toISOString() : null,
        packetSent: row.packet_sent,
        sendFailed: row.send_failed,
        sendInFlight: row.send_in_flight,
      }
    },

    async advanceStatusIfIn(
      id: string,
      input: {
        from: readonly AdminReportStatus[]
        to: AdminReportStatus
        note: string
        actorId: string | null
        kind?: ReportTimelineItem["kind"]
      },
    ): Promise<boolean> {
      return sql.begin(async (tx) => {
        const updated = await tx<{ id: string }[]>`
          UPDATE reports
          SET status = ${input.to}
          WHERE id = ${id}
            AND deleted_at IS NULL
            AND status = ANY(${input.from as string[]}::text[])
          RETURNING id
        `
        if (updated.length === 0) return false
        await tx`
          INSERT INTO report_timeline (report_id, status, note, kind, actor_id)
          VALUES (${id}, ${input.to}, ${input.note}, ${input.kind ?? null}, ${input.actorId})
        `
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "report.status_changed",
          target: `report:${id}`,
          meta: { status: input.to },
        })
        return true
      })
    },

    async appendSystemTimeline(
      id: string,
      input: { note: string; kind: ReportTimelineItem["kind"]; body?: string | null },
    ): Promise<void> {
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
        SELECT id, kind, served_key AS r2_key, thumb_key
        FROM media_assets
        WHERE report_id = ${id} AND status = 'ready' AND served_key IS NOT NULL
        ORDER BY created_at ASC, id ASC
        LIMIT ${MEDIA_CAP}
      `
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
          UPDATE reports
          SET status = ${input.status},
              deleted_at = CASE WHEN ${input.status} = 'rejected'
                                THEN COALESCE(deleted_at, now()) ELSE deleted_at END
          WHERE id = ${id} AND deleted_at IS NULL
          RETURNING id
        `
        if (updated.length === 0) return false
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
          SELECT status FROM reports WHERE id = ${id} AND deleted_at IS NULL FOR NO KEY UPDATE
        `
        const report = exists[0]
        if (!report) return null

        const open = await tx<{ id: string }[]>`
          SELECT id FROM abuse_flags
          WHERE subject_type = 'report' AND subject_id = ${id} AND resolved_at IS NULL
        `
        let nowFlagged: boolean
        if (open.length > 0) {
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
          INSERT INTO report_timeline (report_id, status, note, kind, actor_id)
          VALUES (
            ${id}, ${report.status},
            ${nowFlagged ? "Flagged for review" : "Flag cleared"},
            'warn',
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
          INSERT INTO report_timeline (report_id, status, note, kind, actor_id)
          VALUES (${id}, 'rejected', ${input.note}, 'remove', ${input.actorId})
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

    async appendFollowup(
      id: string,
      input: {
        note: string
        actorId: string | null
        to: "reporter" | "city"
        destination: string
      },
    ): Promise<void> {
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO report_timeline (report_id, status, note, kind, actor_id)
          SELECT ${id}, r.status, ${input.note}, 'followup', ${input.actorId}
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
      input: { verdict: "approved" | "rejected"; actorId: string | null; note: string },
    ): Promise<boolean> {
      return sql.begin(async (tx) => {
        const updated = await tx<{ reporter_user_id: string | null; status: AdminReportStatus }[]>`
          UPDATE reports
          SET verification_verdict = ${input.verdict},
              verified_by = ${input.actorId},
              verified_at = now()
          WHERE id = ${id} AND deleted_at IS NULL
          RETURNING reporter_user_id, status
        `
        const row = updated[0]
        if (!row) return false
        await tx`
          INSERT INTO report_timeline (report_id, status, note, kind, actor_id)
          VALUES (${id}, ${row.status}, ${input.note}, 'status', ${input.actorId})
        `
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "report.verdict_set",
          target: `report:${id}`,
          meta: { verdict: input.verdict },
        })

        const reporter = row.reporter_user_id
        if (input.verdict !== "approved" || reporter === null) return true

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

    async withRouteLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
      const reserved = await sql.reserve()
      try {
        await reserved`SELECT pg_advisory_lock(${ROUTE_LOCK_NAMESPACE}, hashtext(${id}))`
        return await fn()
      } finally {
        // A failed unlock almost always means the session is gone, which releases the lock server-side.
        // It must not mask fn()'s own outcome, but it is logged so a stuck route lock is traceable.
        await reserved`SELECT pg_advisory_unlock(${ROUTE_LOCK_NAMESPACE}, hashtext(${id}))`.catch(
          (err: unknown) => {
            opts.logger?.warn({ err, reportId: id }, "report route advisory unlock failed")
          },
        )
        reserved.release()
      }
    },
  }
}

export function mapOutreachStatus(threadStatus: string, hasInbound: boolean): ReportOutreachStatus {
  if (threadStatus === "bounced") return "bounced"
  if (hasInbound || threadStatus === "replied") return "replied"
  if (threadStatus === "delivered" || threadStatus === "opened") return "delivered"
  return "sent"
}
