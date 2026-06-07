/**
 * Postgres-backed HomeRepository (Phase 2): the per-section dashboard aggregates (#4) + the live-map feed
 * (#5). Written against the raw postgres-js tag (`Sql`, from container.getDb().sql) like the other admin
 * repos. Each method is one focused query so the home service can guard them independently (a failed card
 * never sinks the summary).
 *
 * Reuse: the mail summary reuses the shared MailRepository.stats7d() (mail-repository.drizzle.ts) for the
 * unread count + bounce rate (the single shared mail data layer), plus a small needs-action count query.
 *
 * Reconciliation (decisions 8): the live-map + events summary map the Phase 1 cleanups.status values
 * (active -> in_progress, done -> completed; upcoming / cancelled unchanged) to the Phase 2 EventStatus
 * the wire DTOs use. "Live" events are in_progress; "attending" sums attendees over non-completed,
 * non-cancelled events.
 */

import type { Sql } from "../../db/client.js"
import { makeDrizzleMailRepository } from "./mail-repository.drizzle.js"
import { toEventStatus } from "./event-status.js"
import type {
  DiscoverySectionCounts,
  EventsSectionCounts,
  HomeMapPinRecord,
  HomeRepository,
  MailSectionCounts,
  ReportsSectionCounts,
  UsersSectionCounts,
} from "./home-service.js"
import type { ReportCategory } from "@civfix/shared"

// Re-export the shared event-status mapping under the name this module historically exported (H1: the
// mapping now lives in one place, event-status.ts, used by both the home + admin-event repos).
export { toEventStatus }

/** The discovery SLA window (hours) past which a waiting report is "over SLA" (mirrors discovery). */
const DISCOVERY_SLA_HOURS = 24

/** Parse a ::text count to a finite number (0 on NaN/undefined). */
function num(value: string | null | undefined): number {
  if (value == null) return 0
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** Construct the production HomeRepository over the raw postgres-js tag (`container.getDb().sql`). */
export function makeDrizzleHomeRepository(sql: Sql): HomeRepository {
  const mailRepo = makeDrizzleMailRepository(sql)

  return {
    async discoverySummary(): Promise<DiscoverySectionCounts> {
      // A jurisdiction is in the discovery queue when it has waiting reports (submitted, not routed to a
      // contact yet). We approximate "queue" as distinct jurisdictions with >=1 submitted report lacking
      // any contact, "reportsWaiting" as the total such reports, "overSla" as the queue jurisdictions whose
      // oldest waiting report is older than the SLA.
      const rows = await sql<{ queue: string; reports_waiting: string; over_sla: string }[]>`
        WITH waiting AS (
          SELECT r.jurisdiction_geoid AS geoid, r.created_at
          FROM reports r
          WHERE r.deleted_at IS NULL
            AND r.status = 'submitted'
            AND r.jurisdiction_geoid IS NOT NULL
            AND NOT (
              EXISTS (
                SELECT 1 FROM jurisdiction_contacts jc
                WHERE jc.geoid = r.jurisdiction_geoid AND jc.email IS NOT NULL
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
          COUNT(*)::text AS queue,
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
      // flagged = reports with an open abuse_flag; in-progress = status in_progress/acknowledged; completed
      // = resolved. All over non-deleted reports.
      const rows = await sql<{ flagged: string; in_progress: string; completed: string }[]>`
        SELECT
          (
            SELECT COUNT(DISTINCT af.subject_id)::text
            FROM abuse_flags af
            WHERE af.subject_type = 'report' AND af.resolved_at IS NULL
          ) AS flagged,
          COUNT(*) FILTER (WHERE status IN ('in_progress', 'acknowledged'))::text AS in_progress,
          COUNT(*) FILTER (WHERE status = 'resolved')::text AS completed
        FROM reports
        WHERE deleted_at IS NULL
      `
      const r = rows[0]
      return {
        flagged: num(r?.flagged),
        inProgress: num(r?.in_progress),
        completed: num(r?.completed),
      }
    },

    async eventsSummary(): Promise<EventsSectionCounts> {
      // upcoming + live (active/in_progress) counts, and attendees summed over non-completed,
      // non-cancelled events. Member counts come from cleanup_members.
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
      // Reuse the shared mail data layer's rolling stats for unread + bounce rate; one small extra query
      // for needs-action (threads triaged as needs_action OR bounced).
      const stats = await mailRepo.stats7d()
      const rows = await sql<{ needs_action: string }[]>`
        SELECT COUNT(*)::text AS needs_action
        FROM mail_threads
        WHERE status IN ('needs_action', 'bounced')
      `
      return {
        unread: stats.unread,
        needsAction: num(rows[0]?.needs_action),
        bounceRate: stats.bounceRate,
      }
    },

    async usersSummary(): Promise<UsersSectionCounts> {
      // flagged / high-risk / suspended derive from the user_moderation side table. high-risk = risk in
      // (elevated, high); suspended = account_status in (suspended, banned).
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
      // Recent public reports: pin per report with category + status + flagged (an open abuse_flag) + the
      // jurisdiction name as `place`.
      const reportRows = await sql<
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
          EXISTS (
            SELECT 1 FROM abuse_flags af
            WHERE af.subject_type = 'report' AND af.subject_id = r.id::text AND af.resolved_at IS NULL
          ) AS flagged,
          r.title AS title,
          j.name AS place
        FROM reports r
        LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
        WHERE r.deleted_at IS NULL AND r.visibility = 'public'
        ORDER BY r.created_at DESC NULLS LAST
        LIMIT ${half}
      `
      // Recent events: pin per cleanup with attendees, status mapped to the EventStatus enum.
      const eventRows = await sql<
        {
          id: string
          lat: number
          lng: number
          status: string
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
          c.title AS title,
          c.address AS place,
          (SELECT COUNT(*) FROM cleanup_members m WHERE m.cleanup_id = c.id)::text AS attendees
        FROM cleanups c
        ORDER BY c.scheduled_at DESC NULLS LAST
        LIMIT ${half}
      `

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
      }))
      return [...reportPins, ...eventPins]
    },
  }
}
