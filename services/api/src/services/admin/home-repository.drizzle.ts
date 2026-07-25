
import type { Sql } from "../../db/client.js"
import { makeDrizzleMailRepository } from "./mail-repository.drizzle.js"
import { flaggedReportExpr } from "./admin-report-repository.drizzle.js"
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
} from "./home-types.js"
import type { EventKind, ReportCategory } from "@civfix/shared"

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
            AND NOT (
              EXISTS (
                -- The empty-string test matters: a contact row saved with a blank email routes nothing.
                -- Without it this counter called the report routed while the discovery queue
                -- (discovery-jobs.ts, taskAggregateSql) still counted it waiting -- two home numbers, one
                -- report, no agreement.
                SELECT 1 FROM jurisdiction_contacts jc
                WHERE jc.geoid = r.jurisdiction_geoid AND jc.email IS NOT NULL AND jc.email <> ''
              )
              OR EXISTS (
                SELECT 1 FROM jurisdictions j
                WHERE j.geoid = r.jurisdiction_geoid
                  AND j.contact_emails IS NOT NULL
                  AND array_length(j.contact_emails, 1) > 0
              )
            )
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
      // The flagged chip counts flagged reports that still EXIST. Counting open abuse_flags directly (which
      // this did) kept counting a report after it was removed, so the home chip and the reports page's own
      // flagged count drifted apart the moment an operator removed a flagged report. Same predicate as the
      // reports repo, imported rather than re-inlined.
      const rows = await sql<{ flagged: string; in_progress: string; completed: string }[]>`
        SELECT
          COUNT(*) FILTER (WHERE ${flaggedReportExpr(sql)})::text AS flagged,
          COUNT(*) FILTER (WHERE r.status IN ('in_progress', 'acknowledged'))::text AS in_progress,
          COUNT(*) FILTER (WHERE r.status = 'resolved')::text AS completed
        FROM reports r
        WHERE r.deleted_at IS NULL
      `
      const r = rows[0]
      return {
        flagged: num(r?.flagged),
        inProgress: num(r?.in_progress),
        completed: num(r?.completed),
      }
    },

    async eventsSummary(): Promise<EventsSectionCounts> {
      const rows = await sql<{ upcoming: string; live: string; attending: string }[]>`
        SELECT
          COUNT(*) FILTER (WHERE status = 'upcoming')::text AS upcoming,
          COUNT(*) FILTER (WHERE status IN ('active', 'in_progress'))::text AS live,
          COALESCE(SUM(
            CASE WHEN status NOT IN ('done', 'completed', 'cancelled')
              THEN (SELECT COUNT(*) FROM cleanup_members m WHERE m.cleanup_id = c.id)
              ELSE 0 END
          ), 0)::text AS attending
        FROM cleanups c
      `
      const r = rows[0]
      return {
        upcoming: num(r?.upcoming),
        live: num(r?.live),
        attending: num(r?.attending),
      }
    },

    async mailSummary(): Promise<MailSectionCounts> {
      // Independent reads; the home dashboard fires every section at once, so serializing these two adds a
      // round-trip to its slowest path for nothing.
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

    async recentPins(limit: number): Promise<HomeMapPinRecord[]> {
      const half = Math.max(1, Math.floor(limit / 2))
      // Independent halves of one map layer; awaited together.
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
          WHERE r.deleted_at IS NULL AND r.visibility = 'public'
          ORDER BY r.created_at DESC NULLS LAST
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
          }[]
        >`
          SELECT
            c.id::text AS id,
            ST_Y(c.geom) AS lat,
            ST_X(c.geom) AS lng,
            c.status AS status,
            c.event_kind AS event_kind,
            c.title AS title,
            c.address AS place,
            (SELECT COUNT(*) FROM cleanup_members m WHERE m.cleanup_id = c.id)::text AS attendees
          FROM cleanups c
          ORDER BY c.scheduled_at DESC NULLS LAST
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
        flagged: false,
        title: e.title,
        place: e.place ?? "",
        attendees: num(e.attendees),
        eventKind: e.event_kind,
      }))
      return [...reportPins, ...eventPins]
    },
  }
}
