import type { Queryable } from "../../db/client.js"
import { cleanupStatusExpr } from "../cleanup-sql.js"
import {
  pageColumns,
  pageJoins,
  questionColumns,
  registrationColumns,
  registrationJoins,
  seatColumns,
  ticketTypeColumns,
  ticketTypeJoins,
  toPageRecord,
  toQuestionRecord,
  toRegistrationRecord,
  toSeatRecord,
  toTicketTypeRecord,
  toWaitlistRecord,
  waitlistColumns,
  waitlistJoins,
  type PageRowSelect,
  type QuestionRowSelect,
  type RegistrationRowSelect,
  type SeatRowSelect,
  type TicketTypeRowSelect,
  type WaitlistRowSelect,
} from "./registration-sql.js"
import type {
  EventRegistrationContext,
  PageRecord,
  QuestionRecord,
  RegistrationRecord,
  RegistrationSubject,
  SeatRecord,
  TicketTypeRecord,
  WaitlistRecord,
} from "./registration-repository.types.js"

interface EventContextRow {
  id: string
  status: EventRegistrationContext["status"]
  visibility: EventRegistrationContext["visibility"]
  capacity: number | null
  title: string
  description: string | null
  reference_code: string | null
  lat: number
  lng: number
  scheduled_at: Date
  ends_at: Date | null
  timezone: string | null
  address: string | null
  registration_opens_at: Date | null
  registration_closes_at: Date | null
  page_slug: string | null
  organizer_user_id: string
  organization_id: string | null
}

export function subjectIs(tag: Queryable, subject: RegistrationSubject) {
  return subject.kind === "user"
    ? tag`user_id = ${subject.userId}`
    : tag`guest_id = ${subject.guestId}`
}

export async function isBannedIn(
  tag: Queryable,
  cleanupId: string,
  userId: string,
): Promise<boolean> {
  const banned = await tag<{ one: number }[]>`
    SELECT 1 AS one FROM cleanup_bans
     WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
     LIMIT 1
  `
  return banned.length > 0
}

export async function loadTicketTypes(
  tag: Queryable,
  cleanupIds: readonly string[],
): Promise<TicketTypeRecord[]> {
  if (cleanupIds.length === 0) return []
  const rows = await tag<TicketTypeRowSelect[]>`
    SELECT ${ticketTypeColumns(tag)}
      FROM cleanup_ticket_types t
      ${ticketTypeJoins(tag)}
     WHERE t.cleanup_id = ANY(${[...cleanupIds]}::uuid[])
     ORDER BY t.cleanup_id, t.sort_order, t.id
  `
  return rows.map(toTicketTypeRecord)
}

export async function loadTicketType(
  tag: Queryable,
  cleanupId: string,
  ticketTypeId: string,
): Promise<TicketTypeRecord | null> {
  const rows = await tag<TicketTypeRowSelect[]>`
    SELECT ${ticketTypeColumns(tag)}
      FROM cleanup_ticket_types t
      ${ticketTypeJoins(tag)}
     WHERE t.id = ${ticketTypeId} AND t.cleanup_id = ${cleanupId}
     LIMIT 1
  `
  const row = rows[0]
  return row === undefined ? null : toTicketTypeRecord(row)
}

async function loadSeats(
  tag: Queryable,
  registrationIds: readonly string[],
): Promise<Map<string, SeatRecord[]>> {
  const out = new Map<string, SeatRecord[]>()
  if (registrationIds.length === 0) return out
  const rows = await tag<SeatRowSelect[]>`
    SELECT ${seatColumns(tag)}
      FROM cleanup_registration_seats
     WHERE registration_id = ANY(${[...registrationIds]}::uuid[])
     ORDER BY registration_id, seat_index
  `
  for (const row of rows) {
    const record = toSeatRecord(row)
    const bucket = out.get(record.registrationId)
    if (bucket === undefined) out.set(record.registrationId, [record])
    else bucket.push(record)
  }
  return out
}

export async function hydrate(
  tag: Queryable,
  rows: readonly RegistrationRowSelect[],
): Promise<RegistrationRecord[]> {
  const seats = await loadSeats(
    tag,
    rows.map((r) => r.id),
  )
  return rows.map((r) => toRegistrationRecord(r, seats.get(r.id) ?? []))
}

export async function loadRegistrationById(
  tag: Queryable,
  cleanupId: string,
  registrationId: string,
): Promise<RegistrationRecord | null> {
  const rows = await tag<RegistrationRowSelect[]>`
    SELECT ${registrationColumns(tag)}
      FROM cleanup_registrations r
      ${registrationJoins(tag)}
     WHERE r.id = ${registrationId} AND r.cleanup_id = ${cleanupId}
     LIMIT 1
  `
  const hydrated = await hydrate(tag, rows)
  return hydrated[0] ?? null
}

function toEventContext(row: EventContextRow): EventRegistrationContext {
  return {
    cleanupId: row.id,
    status: row.status,
    visibility: row.visibility,
    capacity: row.capacity,
    title: row.title,
    description: row.description,
    referenceCode: row.reference_code,
    lat: row.lat,
    lng: row.lng,
    scheduledAt: row.scheduled_at,
    endsAt: row.ends_at,
    timezone: row.timezone,
    address: row.address,
    registrationOpensAt: row.registration_opens_at,
    registrationClosesAt: row.registration_closes_at,
    pageSlug: row.page_slug,
    organizerUserId: row.organizer_user_id,
    organizationId: row.organization_id,
  }
}

export async function eventContextIn(
  tag: Queryable,
  cleanupId: string,
): Promise<EventRegistrationContext | null> {
  const rows = await tag<EventContextRow[]>`
    SELECT c.id, ${cleanupStatusExpr(tag)} AS status, c.visibility, c.capacity, c.title,
           c.description, c.reference_code,
           ST_X(c.geom) AS lng, ST_Y(c.geom) AS lat,
           c.scheduled_at, c.ends_at, c.timezone, c.address,
           c.registration_opens_at, c.registration_closes_at, c.page_slug,
           c.organizer_user_id, c.organization_id
      FROM cleanups c
     WHERE c.id = ${cleanupId}
     LIMIT 1
  `
  const row = rows[0]
  return row === undefined ? null : toEventContext(row)
}

export async function loadWaitlistEntry(
  tag: Queryable,
  cleanupId: string,
  waitlistId: string,
): Promise<WaitlistRecord | null> {
  const rows = await tag<WaitlistRowSelect[]>`
    SELECT ${waitlistColumns(tag)}
      FROM cleanup_waitlist w
      ${waitlistJoins(tag)}
     WHERE w.id = ${waitlistId} AND w.cleanup_id = ${cleanupId}
     LIMIT 1
  `
  const row = rows[0]
  return row === undefined ? null : toWaitlistRecord(row)
}

export async function loadPage(tag: Queryable, cleanupId: string): Promise<PageRecord | null> {
  const rows = await tag<PageRowSelect[]>`
    SELECT ${pageColumns(tag)}
      FROM cleanups c
      ${pageJoins(tag)}
     WHERE c.id = ${cleanupId}
     LIMIT 1
  `
  const row = rows[0]
  return row === undefined ? null : toPageRecord(row)
}

export async function loadLiveQuestions(
  tag: Queryable,
  cleanupId: string,
): Promise<QuestionRecord[]> {
  const rows = await tag<QuestionRowSelect[]>`
    SELECT ${questionColumns(tag)}
      FROM cleanup_questions
     WHERE cleanup_id = ${cleanupId} AND archived_at IS NULL
     ORDER BY sort_order, id
  `
  return rows.map(toQuestionRecord)
}
