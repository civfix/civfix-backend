import type { CheckinMethod } from "@civfix/shared"
import type { Sql } from "../../db/client.js"
import { toSeatRecord, waitlistEntryNotBanned, type SeatRowSelect } from "./registration-sql.js"
import { loadRegistrationById } from "./registration-repository-load.drizzle.js"
import { MAX_TICKET_TYPES } from "./registration-repository-ticket-types.drizzle.js"
import type {
  CheckinCountersRecord,
  CheckinResultRecord,
  HostRegistrationRepository,
  HostedEventCounts,
  RegistrationRecord,
  SeatRecord,
} from "./registration-repository.types.js"

export const ARRIVAL_BUCKET_MINUTES = 15

const ARRIVAL_BUCKET_SECONDS = ARRIVAL_BUCKET_MINUTES * 60

export type CheckinMethods = Pick<
  HostRegistrationRepository,
  | "checkInByToken"
  | "checkInSeat"
  | "undoCheckIn"
  | "markNoShows"
  | "sweepNoShows"
  | "checkinCounters"
  | "hostedEventCounts"
>

type CheckedInSeatRow = SeatRowSelect & { first_time: boolean }

interface CheckinTotalsRow {
  registered: number
  checked_in: number
  no_show: number
  waitlisted: number
  capacity: number | null
}

interface CheckinByTypeRow {
  ticket_type_id: string
  name: string
  registered: number
  checked_in: number
  waitlisted: number
  capacity: number | null
}

export function emptyCheckinResult(outcome: CheckinResultRecord["outcome"]): CheckinResultRecord {
  return {
    outcome,
    firstTime: false,
    seat: null,
    registration: null,
    attendeeName: null,
    ticketTypeName: null,
    partySize: null,
    checkedInAt: null,
  }
}

export function buildCheckinResult(
  outcome: CheckinResultRecord["outcome"],
  firstTime: boolean,
  seat: SeatRecord,
  registration: RegistrationRecord | null,
): CheckinResultRecord {
  return {
    outcome,
    firstTime,
    seat,
    registration,
    attendeeName: seat.attendeeName ?? registration?.guestName ?? null,
    ticketTypeName: registration?.ticketTypeName ?? null,
    partySize: registration?.partySize ?? null,
    checkedInAt: seat.checkedInAt,
  }
}

async function checkedInResult(
  sql: Sql,
  cleanupId: string,
  row: CheckedInSeatRow,
): Promise<CheckinResultRecord> {
  return buildCheckinResult(
    row.first_time ? "checked_in" : "already",
    row.first_time,
    toSeatRecord(row),
    await loadRegistrationById(sql, cleanupId, row.registration_id),
  )
}

async function unscannableTokenResult(
  sql: Sql,
  cleanupId: string,
  tokenHash: string,
): Promise<CheckinResultRecord> {
  const probe = await sql<
    { cleanup_id: string; status: SeatRecord["status"]; no_show_at: Date | null }[]
  >`
    SELECT cleanup_id, status, no_show_at FROM cleanup_registration_seats
     WHERE ticket_token_hash = ${tokenHash}
     LIMIT 1
  `
  const seat = probe[0]
  if (seat === undefined) return emptyCheckinResult("unknown_token")
  if (seat.cleanup_id !== cleanupId) return emptyCheckinResult("wrong_event")
  if (seat.status === "cancelled") return emptyCheckinResult("cancelled")
  if (seat.no_show_at !== null) return emptyCheckinResult("no_show")
  return emptyCheckinResult("unknown_token")
}

async function checkinTotals(sql: Sql, cleanupId: string): Promise<CheckinTotalsRow | undefined> {
  const totals = await sql<CheckinTotalsRow[]>`
    SELECT
      COALESCE((
        SELECT sum(r.party_size)::int FROM cleanup_registrations r
         WHERE r.cleanup_id = ${cleanupId} AND r.status = 'registered'
      ), 0) AS registered,
      COALESCE((
        SELECT count(*)::int FROM cleanup_registration_seats s
         WHERE s.cleanup_id = ${cleanupId} AND s.status = 'active' AND s.checked_in_at IS NOT NULL
      ), 0) AS checked_in,
      COALESCE((
        SELECT count(*)::int FROM cleanup_registration_seats s
         WHERE s.cleanup_id = ${cleanupId} AND s.status = 'active' AND s.no_show_at IS NOT NULL
      ), 0) AS no_show,
      COALESCE((
        SELECT sum(w.party_size)::int FROM cleanup_waitlist w
         WHERE w.cleanup_id = ${cleanupId} AND w.status IN ('waiting', 'offered')
           AND ${waitlistEntryNotBanned(sql)}
      ), 0) AS waitlisted,
      (
        SELECT CASE
                 WHEN count(*) = 0 THEN (SELECT c.capacity FROM cleanups c WHERE c.id = ${cleanupId})
                 WHEN bool_or(t.capacity IS NULL) THEN NULL
                 ELSE sum(t.capacity)::int
               END
          FROM cleanup_ticket_types t WHERE t.cleanup_id = ${cleanupId}
      ) AS capacity
  `
  return totals[0]
}

async function checkinByTicketType(sql: Sql, cleanupId: string): Promise<CheckinByTypeRow[]> {
  return sql<CheckinByTypeRow[]>`
    SELECT t.id AS ticket_type_id,
           t.name,
           COALESCE((
             SELECT sum(r.party_size)::int FROM cleanup_registrations r
              WHERE r.ticket_type_id = t.id AND r.status = 'registered'
           ), 0) AS registered,
           COALESCE((
             SELECT count(*)::int FROM cleanup_registration_seats s
               JOIN cleanup_registrations r2 ON r2.id = s.registration_id
              WHERE r2.ticket_type_id = t.id AND s.status = 'active' AND s.checked_in_at IS NOT NULL
           ), 0) AS checked_in,
           COALESCE((
             SELECT sum(w.party_size)::int FROM cleanup_waitlist w
              WHERE w.ticket_type_id = t.id AND w.status IN ('waiting', 'offered')
                AND ${waitlistEntryNotBanned(sql)}
           ), 0) AS waitlisted,
           t.capacity
      FROM cleanup_ticket_types t
     WHERE t.cleanup_id = ${cleanupId}
     ORDER BY t.sort_order, t.id
     LIMIT ${MAX_TICKET_TYPES}
  `
}

async function arrivalBuckets(sql: Sql, cleanupId: string): Promise<{ at: Date; n: number }[]> {
  return sql<{ at: Date; n: number }[]>`
    SELECT to_timestamp(
             floor(extract(epoch FROM s.checked_in_at) / ${ARRIVAL_BUCKET_SECONDS})
             * ${ARRIVAL_BUCKET_SECONDS}
           ) AS at,
           count(*)::int AS n
      FROM cleanup_registration_seats s
     WHERE s.cleanup_id = ${cleanupId} AND s.checked_in_at IS NOT NULL
     GROUP BY 1
     ORDER BY 1
     LIMIT 200
  `
}

export function makeCheckinMethods(sql: Sql): CheckinMethods {
  return {
    async checkInByToken(args: {
      cleanupId: string
      tokenHash: string
      actorId: string
      method: CheckinMethod
      now: Date
    }): Promise<CheckinResultRecord> {
      const updated = await sql<CheckedInSeatRow[]>`
        WITH target AS (
          SELECT id, checked_in_at IS NULL AS first_time
            FROM cleanup_registration_seats
           WHERE ticket_token_hash = ${args.tokenHash}
             AND cleanup_id = ${args.cleanupId}
             AND status = 'active'
             AND no_show_at IS NULL
           FOR UPDATE
        )
        UPDATE cleanup_registration_seats s
           SET checked_in_at  = COALESCE(s.checked_in_at, ${args.now}),
               checked_in_by  = COALESCE(s.checked_in_by, ${args.actorId}),
               checkin_method = COALESCE(s.checkin_method, ${args.method})
          FROM target t
         WHERE s.id = t.id
        RETURNING s.id, s.registration_id, s.seat_index, s.attendee_name, s.status,
                  s.checked_in_at, s.checked_in_by, s.checkin_method, s.checkin_coarsened_at,
                  s.no_show_at, t.first_time
      `
      const row = updated[0]
      if (row !== undefined) return checkedInResult(sql, args.cleanupId, row)
      return unscannableTokenResult(sql, args.cleanupId, args.tokenHash)
    },

    async checkInSeat(args: {
      cleanupId: string
      seatId: string
      actorId: string
      method: CheckinMethod
      now: Date
    }): Promise<CheckinResultRecord> {
      const updated = await sql<CheckedInSeatRow[]>`
        WITH target AS (
          SELECT id, checked_in_at IS NULL AS first_time
            FROM cleanup_registration_seats
           WHERE id = ${args.seatId}
             AND cleanup_id = ${args.cleanupId}
             AND status = 'active'
           FOR UPDATE
        )
        UPDATE cleanup_registration_seats s
           SET checked_in_at  = COALESCE(s.checked_in_at, ${args.now}),
               checked_in_by  = COALESCE(s.checked_in_by, ${args.actorId}),
               checkin_method = COALESCE(s.checkin_method, ${args.method}),
               no_show_at     = NULL
          FROM target t
         WHERE s.id = t.id
        RETURNING s.id, s.registration_id, s.seat_index, s.attendee_name, s.status,
                  s.checked_in_at, s.checked_in_by, s.checkin_method, s.checkin_coarsened_at,
                  s.no_show_at, t.first_time
      `
      const row = updated[0]
      if (row !== undefined) return checkedInResult(sql, args.cleanupId, row)
      const probe = await sql<{ status: SeatRecord["status"] }[]>`
        SELECT status FROM cleanup_registration_seats
         WHERE id = ${args.seatId} AND cleanup_id = ${args.cleanupId}
         LIMIT 1
      `
      return emptyCheckinResult(probe[0] === undefined ? "unknown_token" : "cancelled")
    },

    async undoCheckIn(args: { cleanupId: string; seatId: string }): Promise<SeatRecord | null> {
      const rows = await sql<SeatRowSelect[]>`
        UPDATE cleanup_registration_seats
           SET checked_in_at = NULL, checked_in_by = NULL, checkin_method = NULL,
               checkin_coarsened_at = NULL
         WHERE id = ${args.seatId} AND cleanup_id = ${args.cleanupId}
        RETURNING id, registration_id, seat_index, attendee_name, status, checked_in_at,
                  checked_in_by, checkin_method, checkin_coarsened_at, no_show_at
      `
      const row = rows[0]
      return row === undefined ? null : toSeatRecord(row)
    },

    async markNoShows(args: {
      cleanupId: string
      seatIds: readonly string[] | null
      now: Date
    }): Promise<number> {
      const idFilter =
        args.seatIds === null ? sql`` : sql`AND id = ANY(${[...args.seatIds]}::uuid[])`
      const rows = await sql<{ id: string }[]>`
        UPDATE cleanup_registration_seats
           SET no_show_at = ${args.now}
         WHERE cleanup_id = ${args.cleanupId}
           AND status = 'active'
           AND checked_in_at IS NULL
           AND no_show_at IS NULL
           ${idFilter}
        RETURNING id
      `
      return rows.length
    },

    async sweepNoShows(args: { now: Date; limit: number }): Promise<number> {
      const rows = await sql<{ id: string }[]>`
        UPDATE cleanup_registration_seats s
           SET no_show_at = ${args.now}
         WHERE s.id IN (
           SELECT s2.id
             FROM cleanup_registration_seats s2
             JOIN cleanups c ON c.id = s2.cleanup_id
            WHERE s2.status = 'active'
              AND s2.checked_in_at IS NULL
              AND s2.no_show_at IS NULL
              AND c.status <> 'cancelled'
              AND c.ends_at <= ${args.now} - interval '2 hours'
            ORDER BY s2.created_at
            LIMIT ${args.limit}
         )
        RETURNING s.id
      `
      return rows.length
    },

    async checkinCounters(cleanupId: string): Promise<CheckinCountersRecord> {
      const row = await checkinTotals(sql, cleanupId)
      const byType = await checkinByTicketType(sql, cleanupId)
      const arrivals = await arrivalBuckets(sql, cleanupId)
      return {
        registered: row?.registered ?? 0,
        checkedIn: row?.checked_in ?? 0,
        waitlisted: row?.waitlisted ?? 0,
        noShow: row?.no_show ?? 0,
        capacity: row?.capacity ?? null,
        byTicketType: byType.map((t) => ({
          ticketTypeId: t.ticket_type_id,
          name: t.name,
          registered: t.registered,
          checkedIn: t.checked_in,
          waitlisted: t.waitlisted,
          capacity: t.capacity,
        })),
        arrivals: arrivals.map((a) => ({ at: a.at, count: a.n })),
      }
    },

    async hostedEventCounts(
      cleanupIds: readonly string[],
    ): Promise<Map<string, HostedEventCounts>> {
      const out = new Map<string, HostedEventCounts>()
      if (cleanupIds.length === 0) return out
      const rows = await sql<
        { cleanup_id: string; registered: number; waitlisted: number; checked_in: number }[]
      >`
        SELECT c.id AS cleanup_id,
               COALESCE(reg.n, 0) AS registered,
               COALESCE(wl.n, 0) AS waitlisted,
               COALESCE(ci.n, 0) AS checked_in
          FROM unnest(${[...cleanupIds]}::uuid[]) AS c(id)
          LEFT JOIN LATERAL (
            SELECT sum(r.party_size)::int AS n FROM cleanup_registrations r
             WHERE r.cleanup_id = c.id AND r.status = 'registered'
          ) reg ON true
          LEFT JOIN LATERAL (
            SELECT sum(w.party_size)::int AS n FROM cleanup_waitlist w
             WHERE w.cleanup_id = c.id AND w.status IN ('waiting', 'offered')
               AND ${waitlistEntryNotBanned(sql)}
          ) wl ON true
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS n FROM cleanup_registration_seats s
             WHERE s.cleanup_id = c.id AND s.status = 'active' AND s.checked_in_at IS NOT NULL
          ) ci ON true
      `
      for (const row of rows) {
        out.set(row.cleanup_id, {
          registeredCount: row.registered,
          waitlistCount: row.waitlisted,
          checkedInCount: row.checked_in,
        })
      }
      return out
    },
  }
}
