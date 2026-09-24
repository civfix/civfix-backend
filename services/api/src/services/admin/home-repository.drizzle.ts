import type { Sql } from "../../db/client.js"
import { makeDrizzleMailRepository } from "./mail-repository.drizzle.js"
import { flaggedReportExpr } from "./admin-report-repository.drizzle.js"
import { flaggedEventExpr } from "./admin-event-repository.drizzle.js"
import { reportRoutableExpr } from "./sql-fragments.js"
import { toEventStatus } from "./event-status.js"
import { DISCOVERY_SLA_HOURS } from "./discovery-service.js"
import type {
  DiscoverySectionCounts,
  EventsSectionCounts,
  HomeMapPinRecord,
  HomeRepository,
  MailSectionCounts,
  ReportsSectionCounts,
  UsersSectionCounts,
} from "./home-repository.js"
import type { EventKind, ReportCategory } from "@civfix/shared"
import { adminEventStatusExpr } from "../cleanup-sql.js"

function num(value: string | null | undefined): number {
  if (value == null) return 0
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export function makeDrizzleHomeRepository(sql: Sql): HomeRepository {
  const mailRepo = makeDrizzleMailRepository(sql)

  return {
    async discoverySummary(): Promise<DiscoverySectionCounts> {
      const rows = await sql<{ queue: string; reports_waiting: string; over_sla: string }[]>`
        WITH waiting AS (
          SELECT r.jurisdiction_geoid AS geoid, r.created_at
          FROM reports r
          WHERE r.deleted_at IS NULL
            AND r.status NOT IN ('rejected', 'resolved')
            AND r.jurisdiction_geoid IS NOT NULL
            AND NOT ${reportRoutableExpr(sql, "r")}
        ),
        per_geoid AS (
          SELECT geoid, COUNT(*)::int AS n, MIN(created_at) AS oldest
          FROM waiting
          GROUP BY geoid
        )
        SELECT
          (SELECT COUNT(*)::text FROM jurisdiction_discovery_tasks WHERE status <> 'done') AS queue,
          COALESCE(SUM(n), 0)::text AS reports_waiting,
          COUNT(*) FILTER (
            WHERE oldest < now() - make_interval(hours => ${DISCOVERY_SLA_HOURS})
          )::text AS over_sla
        FROM per_geoid
      `
      const r = rows[0]
      return {
        queue: num(r?.queue),
        reportsWaiting: num(r?.reports_waiting),
        overSla: num(r?.over_sla),
      }
    },

    async reportsSummary(): Promise<ReportsSectionCounts> {
      const rows = await sql<{ flagged: string; in_progress: string; completed: string }[]>`
        SELECT
          (
            SELECT COUNT(DISTINCT af.subject_id)
            FROM abuse_flags af
            JOIN reports fr ON fr.id = af.subject_id::uuid
            WHERE af.subject_type = 'report' AND af.resolved_at IS NULL AND fr.deleted_at IS NULL
          )::text AS flagged,
          COUNT(*) FILTER (WHERE r.status IN ('in_progress', 'acknowledged'))::text AS in_progress,
          COUNT(*) FILTER (WHERE r.status = 'resolved')::text AS completed
        FROM reports r
        WHERE r.deleted_at IS NULL AND r.status IN ('in_progress', 'acknowledged', 'resolved')
      `
      const r = rows[0]
      return {
        flagged: num(r?.flagged),
        inProgress: num(r?.in_progress),
        completed: num(r?.completed),
      }
    },

    async eventsSummary(): Promise<EventsSectionCounts> {
      // The WHERE keeps exactly the events the status expression calls upcoming or in progress (status and
      // ends_at are NOT NULL), so the counts equal those over every event while the scan is an ends_at range.
      const rows = await sql<{ upcoming: string; live: string; attending: string }[]>`
        SELECT
          COUNT(*) FILTER (WHERE ${adminEventStatusExpr(sql)} = 'upcoming')::text AS upcoming,
          COUNT(*) FILTER (WHERE ${adminEventStatusExpr(sql)} = 'in_progress')::text AS live,
          COALESCE(SUM(
            (SELECT COUNT(*)::int FROM cleanup_members m WHERE m.cleanup_id = c.id)
          ), 0)::text AS attending
        FROM cleanups c
        WHERE c.status <> 'cancelled' AND c.ends_at > now()
      `
      const r = rows[0]
      return {
        upcoming: num(r?.upcoming),
        live: num(r?.live),
        attending: num(r?.attending),
      }
    },

    async mailSummary(): Promise<MailSectionCounts> {
      const [stats, rows] = await Promise.all([
        mailRepo.stats7d(),
        sql<{ needs_action: string }[]>`
          SELECT COUNT(*)::text AS needs_action
          FROM mail_threads
          WHERE status IN ('needs_action', 'bounced')
        `,
      ])
      return {
        unread: stats.unread,
        needsAction: num(rows[0]?.needs_action),
      }
    },

    async usersSummary(): Promise<UsersSectionCounts> {
      const rows = await sql<{ flagged: string; high_risk: string; suspended: string }[]>`
        SELECT
          COUNT(*) FILTER (WHERE flagged = true)::text AS flagged,
          COUNT(*) FILTER (WHERE risk IN ('elevated', 'high'))::text AS high_risk,
          COUNT(*) FILTER (WHERE account_status IN ('suspended', 'banned'))::text AS suspended
        FROM user_moderation
      `
      const r = rows[0]
      return {
        flagged: num(r?.flagged),
        highRisk: num(r?.high_risk),
        suspended: num(r?.suspended),
      }
    },

    async livePins24h(): Promise<number> {
      const rows = await sql<{ n: string }[]>`
        SELECT COUNT(*)::text AS n
        FROM reports
        WHERE deleted_at IS NULL
          AND visibility = 'public'
          AND created_at >= now() - interval '24 hours'
      `
      return num(rows[0]?.n)
    },

    async moderationQueue(): Promise<number> {
      const rows = await sql<{ n: string }[]>`
        SELECT COUNT(*)::text AS n
        FROM moderation_items
        WHERE status = 'open'
      `
      return num(rows[0]?.n)
    },

    async inboxUnread(): Promise<number> {
      const rows = await sql<{ n: string }[]>`
        SELECT COUNT(*)::text AS n
        FROM inbound_emails
        WHERE status = 'unread'
      `
      return num(rows[0]?.n)
    },

    async recentPins(limit: number): Promise<HomeMapPinRecord[]> {
      const half = Math.max(1, Math.floor(limit / 2))
      const [reportRows, eventRows] = await Promise.all([
        sql<
          {
            id: string
            lat: number
            lng: number
            category: ReportCategory
            status: string
            flagged: boolean
            title: string | null
            place: string | null
          }[]
        >`
          SELECT
            r.id::text AS id,
            ST_Y(r.geom) AS lat,
            ST_X(r.geom) AS lng,
            r.category AS category,
            r.status AS status,
            ${flaggedReportExpr(sql)} AS flagged,
            r.title AS title,
            j.name AS place
          FROM reports r
          LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
          WHERE r.deleted_at IS NULL AND r.visibility = 'public' AND r.created_at IS NOT NULL
          ORDER BY r.created_at DESC
          LIMIT ${half}
        `,
        sql<
          {
            id: string
            lat: number
            lng: number
            status: string
            event_kind: EventKind
            title: string
            place: string | null
            attendees: string
            flagged: boolean
          }[]
        >`
          SELECT
            c.id::text AS id,
            ST_Y(c.geom) AS lat,
            ST_X(c.geom) AS lng,
            ${adminEventStatusExpr(sql)} AS status,
            ${flaggedEventExpr(sql)} AS flagged,
            c.event_kind AS event_kind,
            c.title AS title,
            c.address AS place,
            (SELECT COUNT(*) FROM cleanup_members m WHERE m.cleanup_id = c.id)::text AS attendees
          FROM cleanups c
          ORDER BY c.scheduled_at DESC
          LIMIT ${half}
        `,
      ])

      const reportPins: HomeMapPinRecord[] = reportRows.map((r) => ({
        refType: "report",
        id: r.id,
        lat: r.lat,
        lng: r.lng,
        category: r.category,
        status: r.status,
        flagged: r.flagged,
        title: r.title ?? "",
        place: r.place ?? "",
        attendees: null,
        eventKind: null,
      }))
      const eventPins: HomeMapPinRecord[] = eventRows.map((e) => ({
        refType: "event",
        id: e.id,
        lat: e.lat,
        lng: e.lng,
        category: null,
        status: toEventStatus(e.status),
        flagged: e.flagged,
        title: e.title,
        place: e.place ?? "",
        attendees: num(e.attendees),
        eventKind: e.event_kind,
      }))
      return [...reportPins, ...eventPins]
    },
  }
}
