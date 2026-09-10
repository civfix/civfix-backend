import type { DayCount, DayTimeCount, KeyCount } from "@civfix/shared/host"
import type { Sql } from "../../db/client.js"

export interface EventKpiRow {
  registered: number
  checkedIn: number
  waitlisted: number
  cancelled: number
  noShow: number
  capacity: number | null
}

export interface PortfolioTotals {
  events: number
  registrations: number
  checkIns: number
  uniqueAttendees: number
  repeatAttendees: number
}

export interface AnalyticsRepository {
  eventKpis(cleanupId: string): Promise<EventKpiRow>
  registrationsByDay(cleanupId: string, timezone: string, from: string, to: string): Promise<DayCount[]>
  cancellationsByDay(cleanupId: string, timezone: string, from: string, to: string): Promise<DayCount[]>
  registrationsByTicketType(cleanupId: string): Promise<KeyCount[]>
  registrationsByAudience(cleanupId: string): Promise<KeyCount[]>
  checkinsByTicketType(cleanupId: string): Promise<KeyCount[]>
  checkinsBySlot(cleanupId: string): Promise<KeyCount[]>
  arrivalOffsets(cleanupId: string, limit: number): Promise<number[]>
  waitlistConversion(cleanupId: string): Promise<{ promoted: number; joined: number }>
  hostedEventIds(userId: string, organizationId: string | null, limit: number): Promise<string[]>
  portfolioTotals(cleanupIds: readonly string[]): Promise<PortfolioTotals>
  portfolioByEvent(cleanupIds: readonly string[], limit: number): Promise<KeyCount[]>
  portfolioDayTime(cleanupIds: readonly string[]): Promise<DayTimeCount[]>
  broadcastsSent(cleanupId: string, from: string, to: string): Promise<number>
}

export function makeDrizzleAnalyticsRepository(sql: Sql): AnalyticsRepository {
  async function dayCounts(rows: { day: string; n: string }[]): Promise<DayCount[]> {
    return rows.map((row) => ({ day: row.day, count: Number(row.n) }))
  }

  return {
    async eventKpis(cleanupId: string): Promise<EventKpiRow> {
      const rows = await sql<
        {
          registered: string
          checked_in: string
          waitlisted: string
          cancelled: string
          no_show: string
          capacity: number | null
        }[]
      >`
        SELECT
          (SELECT count(*) FROM cleanup_registrations r
            WHERE r.cleanup_id = ${cleanupId} AND r.status = 'registered')::text AS registered,
          (SELECT count(*) FROM cleanup_registration_seats s
            WHERE s.cleanup_id = ${cleanupId} AND s.checked_in_at IS NOT NULL)::text AS checked_in,
          (SELECT count(*) FROM cleanup_waitlist w
            WHERE w.cleanup_id = ${cleanupId} AND w.status IN ('waiting','offered'))::text AS waitlisted,
          (SELECT count(*) FROM cleanup_registrations r
            WHERE r.cleanup_id = ${cleanupId} AND r.status = 'cancelled')::text AS cancelled,
          (SELECT count(*) FROM cleanup_registration_seats s
            WHERE s.cleanup_id = ${cleanupId} AND s.no_show_at IS NOT NULL)::text AS no_show,
          (SELECT c.capacity FROM cleanups c WHERE c.id = ${cleanupId}) AS capacity`
      const row = rows[0]
      return {
        registered: Number(row?.registered ?? 0),
        checkedIn: Number(row?.checked_in ?? 0),
        waitlisted: Number(row?.waitlisted ?? 0),
        cancelled: Number(row?.cancelled ?? 0),
        noShow: Number(row?.no_show ?? 0),
        capacity: row?.capacity ?? null,
      }
    },

    async registrationsByDay(cleanupId, timezone, from, to) {
      const rows = await sql<{ day: string; n: string }[]>`
        SELECT to_char((registered_at AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD') AS day,
               count(*)::text AS n
          FROM cleanup_registrations
         WHERE cleanup_id = ${cleanupId}
           AND (registered_at AT TIME ZONE ${timezone})::date BETWEEN ${from}::date AND ${to}::date
         GROUP BY 1 ORDER BY 1 LIMIT 400`
      return dayCounts(rows)
    },

    async cancellationsByDay(cleanupId, timezone, from, to) {
      const rows = await sql<{ day: string; n: string }[]>`
        SELECT to_char((cancelled_at AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD') AS day,
               count(*)::text AS n
          FROM cleanup_registrations
         WHERE cleanup_id = ${cleanupId} AND cancelled_at IS NOT NULL
           AND (cancelled_at AT TIME ZONE ${timezone})::date BETWEEN ${from}::date AND ${to}::date
         GROUP BY 1 ORDER BY 1 LIMIT 400`
      return dayCounts(rows)
    },

    async registrationsByTicketType(cleanupId) {
      const rows = await sql<{ key: string; n: string }[]>`
        SELECT COALESCE(t.name, 'General') AS key, count(*)::text AS n
          FROM cleanup_registrations r
          LEFT JOIN cleanup_ticket_types t ON t.id = r.ticket_type_id
         WHERE r.cleanup_id = ${cleanupId} AND r.status = 'registered'
         GROUP BY 1 ORDER BY 2 DESC LIMIT 50`
      return rows.map((row) => ({ key: row.key, count: Number(row.n) }))
    },

    async registrationsByAudience(cleanupId) {
      const rows = await sql<{ key: string; n: string }[]>`
        SELECT CASE WHEN user_id IS NOT NULL THEN 'member' ELSE 'guest' END AS key,
               count(*)::text AS n
          FROM cleanup_registrations
         WHERE cleanup_id = ${cleanupId} AND status = 'registered'
         GROUP BY 1`
      return rows.map((row) => ({ key: row.key, count: Number(row.n) }))
    },

    async checkinsByTicketType(cleanupId) {
      const rows = await sql<{ key: string; n: string }[]>`
        SELECT COALESCE(t.name, 'General') AS key, count(*)::text AS n
          FROM cleanup_registration_seats s
          JOIN cleanup_registrations r ON r.id = s.registration_id
          LEFT JOIN cleanup_ticket_types t ON t.id = r.ticket_type_id
         WHERE s.cleanup_id = ${cleanupId} AND s.checked_in_at IS NOT NULL
         GROUP BY 1 ORDER BY 2 DESC LIMIT 50`
      return rows.map((row) => ({ key: row.key, count: Number(row.n) }))
    },

    async checkinsBySlot(cleanupId) {
      const rows = await sql<{ key: string; n: string }[]>`
        SELECT COALESCE(sl.title, 'Unassigned') AS key, count(*)::text AS n
          FROM cleanup_registration_seats s
          JOIN cleanup_registrations r ON r.id = s.registration_id
          LEFT JOIN cleanup_slot_claims sc
            ON sc.cleanup_id = s.cleanup_id AND sc.user_id = r.user_id
          LEFT JOIN cleanup_slots sl ON sl.id = sc.slot_id
         WHERE s.cleanup_id = ${cleanupId} AND s.checked_in_at IS NOT NULL
         GROUP BY 1 ORDER BY 2 DESC LIMIT 50`
      return rows.map((row) => ({ key: row.key, count: Number(row.n) }))
    },

    async arrivalOffsets(cleanupId, limit) {
      const rows = await sql<{ offset_min: string }[]>`
        SELECT round(extract(epoch FROM (s.checked_in_at - c.scheduled_at)) / 60)::text AS offset_min
          FROM cleanup_registration_seats s
          JOIN cleanups c ON c.id = s.cleanup_id
         WHERE s.cleanup_id = ${cleanupId} AND s.checked_in_at IS NOT NULL
         LIMIT ${limit}`
      return rows.map((row) => Number(row.offset_min))
    },

    async waitlistConversion(cleanupId) {
      const rows = await sql<{ promoted: string; joined: string }[]>`
        SELECT count(*) FILTER (WHERE status = 'claimed')::text AS promoted,
               count(*)::text AS joined
          FROM cleanup_waitlist WHERE cleanup_id = ${cleanupId}`
      return {
        promoted: Number(rows[0]?.promoted ?? 0),
        joined: Number(rows[0]?.joined ?? 0),
      }
    },

    async hostedEventIds(userId, organizationId, limit) {
      const orgFilter =
        organizationId !== null ? sql`AND c.organization_id = ${organizationId}` : sql``
      const rows = await sql<{ id: string }[]>`
        SELECT c.id
          FROM cleanups c
         WHERE (c.organizer_user_id = ${userId}
                OR EXISTS (
                  SELECT 1 FROM cleanup_members m
                   WHERE m.cleanup_id = c.id AND m.user_id = ${userId}
                     AND m.role IN ('organizer','cohost','coordinator'))
                OR EXISTS (
                  SELECT 1 FROM organization_members om
                   WHERE om.organization_id = c.organization_id AND om.user_id = ${userId}
                     AND om.role IN ('owner','admin')))
           ${orgFilter}
         ORDER BY c.scheduled_at DESC
         LIMIT ${limit}`
      return rows.map((row) => row.id)
    },

    async portfolioTotals(cleanupIds) {
      if (cleanupIds.length === 0) {
        return { events: 0, registrations: 0, checkIns: 0, uniqueAttendees: 0, repeatAttendees: 0 }
      }
      const rows = await sql<
        {
          registrations: string
          check_ins: string
          unique_attendees: string
          repeat_attendees: string
        }[]
      >`
        WITH regs AS (
          SELECT r.id, r.cleanup_id, r.user_id
            FROM cleanup_registrations r
           WHERE r.cleanup_id = ANY(${[...cleanupIds]}::uuid[]) AND r.status = 'registered'
        ),
        attendance AS (
          SELECT regs.user_id, count(DISTINCT regs.cleanup_id) AS events
            FROM regs WHERE regs.user_id IS NOT NULL GROUP BY 1
        )
        SELECT (SELECT count(*) FROM regs)::text AS registrations,
               (SELECT count(*) FROM cleanup_registration_seats s
                 WHERE s.cleanup_id = ANY(${[...cleanupIds]}::uuid[])
                   AND s.checked_in_at IS NOT NULL)::text AS check_ins,
               (SELECT count(*) FROM attendance)::text AS unique_attendees,
               (SELECT count(*) FROM attendance WHERE events > 1)::text AS repeat_attendees`
      const row = rows[0]
      return {
        events: cleanupIds.length,
        registrations: Number(row?.registrations ?? 0),
        checkIns: Number(row?.check_ins ?? 0),
        uniqueAttendees: Number(row?.unique_attendees ?? 0),
        repeatAttendees: Number(row?.repeat_attendees ?? 0),
      }
    },

    async portfolioByEvent(cleanupIds, limit) {
      if (cleanupIds.length === 0) return []
      const rows = await sql<{ key: string; n: string }[]>`
        SELECT c.title AS key, count(r.id)::text AS n
          FROM cleanups c
          LEFT JOIN cleanup_registrations r
            ON r.cleanup_id = c.id AND r.status = 'registered'
         WHERE c.id = ANY(${[...cleanupIds]}::uuid[])
         GROUP BY c.id, c.title
         ORDER BY 2 DESC
         LIMIT ${limit}`
      return rows.map((row) => ({ key: row.key, count: Number(row.n) }))
    },

    async broadcastsSent(cleanupId, from, to) {
      const rows = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n
          FROM broadcasts b
         WHERE b.cleanup_id = ${cleanupId}
           AND b.status IN ('sent','failed')
           AND b.finished_at IS NOT NULL
           AND b.finished_at >= ${from}::date
           AND b.finished_at < (${to}::date + 1)`
      return Number(rows[0]?.n ?? 0)
    },

    async portfolioDayTime(cleanupIds) {
      if (cleanupIds.length === 0) return []
      const rows = await sql<{ weekday: string; hour: string; n: string }[]>`
        SELECT extract(dow FROM c.scheduled_at AT TIME ZONE COALESCE(c.timezone, 'UTC'))::int::text
                 AS weekday,
               extract(hour FROM c.scheduled_at AT TIME ZONE COALESCE(c.timezone, 'UTC'))::int::text
                 AS hour,
               count(r.id)::text AS n
          FROM cleanups c
          LEFT JOIN cleanup_registrations r
            ON r.cleanup_id = c.id AND r.status = 'registered'
         WHERE c.id = ANY(${[...cleanupIds]}::uuid[])
         GROUP BY 1, 2
         LIMIT 500`
      return rows.map((row) => ({
        weekday: Number(row.weekday),
        hour: Number(row.hour),
        count: Number(row.n),
      }))
    },
  }
}
