import type { KeyCount } from "@civfix/shared/host"
import type { Sql, SqlFragment } from "../../db/client.js"

const EVENT_ANALYTICS_SLOT_ROW_LIMIT = 50

export interface EventAnalyticsFacts {
  walkUps: number
  reportsLinked: number
  reportsResolved: number
  postsCreated: number
}

const ZERO_EVENT_ANALYTICS_FACTS: EventAnalyticsFacts = Object.freeze({
  walkUps: 0,
  reportsLinked: 0,
  reportsResolved: 0,
  postsCreated: 0,
})

export interface EventComparisonMedians {
  sampleSize: number
  signups: number | null
  checkInRate: number | null
  hoursPerVolunteer: number | null
  fillRate: number | null
}

export interface EventAnalyticsRepository {
  previousCompletedEventIds(args: {
    userId: string
    organizationId: string | null
    excludeCleanupId: string
    limit: number
  }): Promise<string[]>
  facts(cleanupId: string): Promise<EventAnalyticsFacts>
  registrationsBySlot(cleanupId: string): Promise<KeyCount[]>
  reportStatuses(cleanupId: string): Promise<KeyCount[]>
  hoursBuckets(cleanupId: string): Promise<KeyCount[]>
  comparisonMedians(cleanupIds: readonly string[]): Promise<EventComparisonMedians>
}

const EMPTY_COMPARISON_MEDIANS: EventComparisonMedians = Object.freeze({
  sampleSize: 0,
  signups: null,
  checkInRate: null,
  hoursPerVolunteer: null,
  fillRate: null,
})

function keyCounts(rows: { key: string; n: number }[]): KeyCount[] {
  return rows.map((row) => ({ key: row.key, count: row.n }))
}

export function makeDrizzleEventAnalyticsRepository(sql: Sql): EventAnalyticsRepository {
  return {
    async previousCompletedEventIds(args) {
      const orgFilter = (): SqlFragment =>
        args.organizationId !== null ? sql`AND c.organization_id = ${args.organizationId}` : sql``
      const rows = await sql<{ id: string }[]>`
        WITH hosted AS (
          SELECT c.id, c.completed_at
            FROM cleanups c
           WHERE c.organizer_user_id = ${args.userId}
             AND c.completed_at IS NOT NULL
             AND c.id <> ${args.excludeCleanupId}
             ${orgFilter()}
          UNION
          SELECT c.id, c.completed_at
            FROM cleanup_members m
            JOIN cleanups c ON c.id = m.cleanup_id
           WHERE m.user_id = ${args.userId}
             AND m.role IN ('organizer','cohost','coordinator')
             AND c.completed_at IS NOT NULL
             AND c.id <> ${args.excludeCleanupId}
             ${orgFilter()}
          UNION
          SELECT c.id, c.completed_at
            FROM organization_members om
            JOIN cleanups c ON c.organization_id = om.organization_id
           WHERE om.user_id = ${args.userId}
             AND om.role IN ('owner','admin')
             AND c.completed_at IS NOT NULL
             AND c.id <> ${args.excludeCleanupId}
             ${orgFilter()}
        )
        SELECT id FROM hosted
         ORDER BY completed_at DESC
         LIMIT ${args.limit}`
      return rows.map((row) => row.id)
    },

    async facts(cleanupId) {
      const rows = await sql<
        {
          walk_ups: number
          reports_linked: number
          reports_resolved: number
          posts_created: number
        }[]
      >`
        SELECT
          (SELECT count(*) FROM cleanup_registrations r
            WHERE r.cleanup_id = ${cleanupId}
              AND r.status = 'registered'
              AND r.source = 'walkup')::int AS walk_ups,
          (SELECT count(*) FROM cleanup_reports cr
            WHERE cr.cleanup_id = ${cleanupId})::int AS reports_linked,
          (SELECT count(*) FROM cleanup_reports cr
             JOIN reports rep ON rep.id = cr.report_id
            WHERE cr.cleanup_id = ${cleanupId}
              AND rep.status = 'resolved')::int AS reports_resolved,
          (SELECT count(*) FROM posts p
            WHERE p.event_id = ${cleanupId}
              AND p.deleted_at IS NULL
              AND p.reply_to_id IS NULL)::int AS posts_created`
      const row = rows[0]
      if (row === undefined) return { ...ZERO_EVENT_ANALYTICS_FACTS }
      return {
        walkUps: row.walk_ups,
        reportsLinked: row.reports_linked,
        reportsResolved: row.reports_resolved,
        postsCreated: row.posts_created,
      }
    },

    async registrationsBySlot(cleanupId) {
      const rows = await sql<{ key: string; n: number }[]>`
        SELECT sl.title AS key, count(*)::int AS n
          FROM cleanup_slot_claims sc
          JOIN cleanup_slots sl ON sl.id = sc.slot_id
         WHERE sc.cleanup_id = ${cleanupId}
         GROUP BY sl.title
         ORDER BY count(*) DESC, sl.title ASC
         LIMIT ${EVENT_ANALYTICS_SLOT_ROW_LIMIT}`
      return keyCounts(rows)
    },

    async reportStatuses(cleanupId) {
      const rows = await sql<{ key: string; n: number }[]>`
        SELECT rep.status AS key, count(*)::int AS n
          FROM cleanup_reports cr
          JOIN reports rep ON rep.id = cr.report_id
         WHERE cr.cleanup_id = ${cleanupId}
         GROUP BY rep.status
         ORDER BY count(*) DESC, rep.status ASC
         LIMIT ${EVENT_ANALYTICS_SLOT_ROW_LIMIT}`
      return keyCounts(rows)
    },

    async hoursBuckets(cleanupId) {
      const rows = await sql<{ key: string; n: number }[]>`
        WITH per_person AS (
          SELECT h.user_id, sum(h.hours)::float8 AS hours
            FROM volunteer_hours h
           WHERE h.cleanup_id = ${cleanupId}
             AND h.source = 'event'
             AND h.voided_at IS NULL
           GROUP BY h.user_id
        )
        SELECT CASE
                 WHEN hours < 1 THEN '0-1h'
                 WHEN hours < 2 THEN '1-2h'
                 WHEN hours < 4 THEN '2-4h'
                 ELSE '4h+'
               END AS key,
               count(*)::int AS n
          FROM per_person
         GROUP BY 1`
      return keyCounts(rows)
    },

    async comparisonMedians(cleanupIds) {
      if (cleanupIds.length === 0) return { ...EMPTY_COMPARISON_MEDIANS }
      const rows = await sql<
        {
          sample_size: number
          signups: number | null
          check_in_rate: number | null
          hours_per_volunteer: number | null
          fill_rate: number | null
        }[]
      >`
        WITH per_event AS (
          SELECT
            c.id,
            (SELECT count(*) FROM cleanup_registrations r
              WHERE r.cleanup_id = c.id AND r.status = 'registered')::float8 AS signups,
            (SELECT count(*) FROM cleanup_registration_seats s
              WHERE s.cleanup_id = c.id AND s.checked_in_at IS NOT NULL)::float8 AS checked_in,
            (SELECT COALESCE(sum(h.hours), 0) FROM volunteer_hours h
              WHERE h.cleanup_id = c.id AND h.source = 'event' AND h.voided_at IS NULL)::float8
              AS hours,
            (SELECT count(DISTINCT h.user_id) FROM volunteer_hours h
              WHERE h.cleanup_id = c.id AND h.source = 'event' AND h.voided_at IS NULL)::float8
              AS volunteers,
            c.capacity::float8 AS capacity
          FROM cleanups c
          WHERE c.id = ANY(${[...cleanupIds]}::uuid[])
        )
        SELECT
          count(*)::int AS sample_size,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY signups)::float8 AS signups,
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY CASE WHEN signups > 0 THEN checked_in / signups END)::float8 AS check_in_rate,
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY CASE WHEN volunteers > 0 THEN hours / volunteers END)::float8
            AS hours_per_volunteer,
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY CASE WHEN capacity > 0 THEN signups / capacity END)::float8 AS fill_rate
        FROM per_event`
      const row = rows[0]
      return {
        sampleSize: row?.sample_size ?? 0,
        signups: row?.signups ?? null,
        checkInRate: row?.check_in_rate ?? null,
        hoursPerVolunteer: row?.hours_per_volunteer ?? null,
        fillRate: row?.fill_rate ?? null,
      }
    },
  }
}
