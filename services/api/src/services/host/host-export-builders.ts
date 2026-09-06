import type { Sql } from "../../db/client.js"
import { registerHostExportBuilder, type HostExportContext } from "./export-builders.js"

export const EXPORT_PAGE_SIZE = 1000

interface RosterRow {
  registration_id: string
  attendee_name: string | null
  attendee_kind: string
  ticket_type: string | null
  seats: number
  slot: string | null
  status: string
  registered_at: Date
  checked_in_at: Date | null
  checkin_method: string | null
  guest_email: string | null
  guest_phone: string | null
}

function iso(value: Date | null): string {
  return value === null ? "" : value.toISOString()
}

export function registerEventExportBuilders(getSql: () => Sql): void {
  registerHostExportBuilder("roster", {
    filename: (ctx) => `civfix-roster-${shortRef(ctx)}-${dayOf(ctx)}.csv`,
    header: () =>
      Promise.resolve([
        "attendee_id",
        "name",
        "attendee_kind",
        "ticket_type",
        "seats",
        "slot",
        "status",
        "registered_at",
        "checked_in_at",
        "check_in_method",
        "guest_email",
        "guest_phone",
      ]),
    provenance: (ctx) =>
      Promise.resolve([
        `civfix roster export for event ${ctx.cleanupId ?? ""}`,
        `generated ${ctx.now.toISOString()} by user ${ctx.requestedBy}`,
        `filters ${JSON.stringify(ctx.filters)}`,
        "member email and phone are never included: civfix relays messages, hosts do not hold member contact details",
        "guest contact is blank once the 30-day retention scrub has run",
        "aggregate analytics elsewhere in the console are k-anonymised at k=5; this file is not aggregated",
      ]),
    rows: (ctx) => rosterRows(getSql(), ctx),
  })

  registerHostExportBuilder("checkins", {
    filename: (ctx) => `civfix-checkins-${shortRef(ctx)}-${dayOf(ctx)}.csv`,
    header: () =>
      Promise.resolve([
        "attendee_id",
        "name",
        "attendee_kind",
        "ticket_type",
        "checked_in_at",
        "check_in_method",
        "no_show_at",
      ]),
    provenance: (ctx) =>
      Promise.resolve([
        `civfix check-in export for event ${ctx.cleanupId ?? ""}`,
        `generated ${ctx.now.toISOString()} by user ${ctx.requestedBy}`,
        "precise check-in times are coarsened 30 days after the event",
      ]),
    rows: (ctx) => checkinRows(getSql(), ctx),
  })

  registerHostExportBuilder("answers", {
    filename: (ctx) => `civfix-answers-${shortRef(ctx)}-${dayOf(ctx)}.csv`,
    header: () =>
      Promise.resolve(["registration_id", "attendee_kind", "question", "answer", "answered_at"]),
    provenance: (ctx) =>
      Promise.resolve([
        `civfix registration answers export for event ${ctx.cleanupId ?? ""}`,
        `generated ${ctx.now.toISOString()} by user ${ctx.requestedBy}`,
        "answers are scrubbed 30 days after the event; scrubbed answers export blank",
      ]),
    rows: (ctx) => answerRows(getSql(), ctx),
  })
}

async function* rosterRows(sql: Sql, ctx: HostExportContext): AsyncIterable<readonly string[]> {
  let after = ""
  for (;;) {
    const rows = await sql<RosterRow[]>`
      SELECT r.id AS registration_id,
             COALESCE(NULLIF(min(s.attendee_name), ''), g.name, u.display_name) AS attendee_name,
             CASE WHEN r.user_id IS NOT NULL THEN 'member' ELSE 'guest' END AS attendee_kind,
             t.name AS ticket_type,
             count(s.id)::int AS seats,
             (SELECT string_agg(sl.title, '; ' ORDER BY sl.title)
                FROM cleanup_slot_claims sc
                JOIN cleanup_slots sl ON sl.id = sc.slot_id
               WHERE sc.cleanup_id = r.cleanup_id AND sc.user_id = r.user_id) AS slot,
             r.status,
             r.registered_at,
             min(s.checked_in_at) AS checked_in_at,
             min(s.checkin_method) AS checkin_method,
             g.email AS guest_email,
             g.phone AS guest_phone
        FROM cleanup_registrations r
        LEFT JOIN cleanup_registration_seats s ON s.registration_id = r.id
        LEFT JOIN cleanup_ticket_types t ON t.id = r.ticket_type_id
        LEFT JOIN cleanup_guests g ON g.id = r.guest_id
        LEFT JOIN users u ON u.id = r.user_id
       WHERE r.cleanup_id = ${ctx.cleanupId}
         AND (${after} = '' OR r.id > ${after}::uuid)
       GROUP BY r.id, r.cleanup_id, r.user_id, r.status, r.registered_at,
                g.name, u.display_name, t.name, g.email, g.phone
       ORDER BY r.id
       LIMIT ${EXPORT_PAGE_SIZE}`
    if (rows.length === 0) return
    for (const row of rows) {
      yield [
        row.registration_id,
        row.attendee_name ?? "",
        row.attendee_kind,
        row.ticket_type ?? "",
        String(row.seats),
        row.slot ?? "",
        row.status,
        iso(row.registered_at),
        iso(row.checked_in_at),
        row.checkin_method ?? "",
        row.guest_email ?? "",
        row.guest_phone ?? "",
      ]
    }
    after = rows[rows.length - 1]!.registration_id
    if (rows.length < EXPORT_PAGE_SIZE) return
  }
}

async function* checkinRows(sql: Sql, ctx: HostExportContext): AsyncIterable<readonly string[]> {
  let after = ""
  for (;;) {
    const rows = await sql<
      {
        id: string
        attendee_name: string | null
        attendee_kind: string
        ticket_type: string | null
        checked_in_at: Date | null
        checkin_method: string | null
        no_show_at: Date | null
      }[]
    >`
      SELECT s.id,
             COALESCE(NULLIF(s.attendee_name, ''), g.name, u.display_name) AS attendee_name,
             CASE WHEN r.user_id IS NOT NULL THEN 'member' ELSE 'guest' END AS attendee_kind,
             t.name AS ticket_type,
             s.checked_in_at, s.checkin_method, s.no_show_at
        FROM cleanup_registration_seats s
        JOIN cleanup_registrations r ON r.id = s.registration_id
        LEFT JOIN cleanup_ticket_types t ON t.id = r.ticket_type_id
        LEFT JOIN cleanup_guests g ON g.id = r.guest_id
        LEFT JOIN users u ON u.id = r.user_id
       WHERE s.cleanup_id = ${ctx.cleanupId}
         AND (${after} = '' OR s.id > ${after}::uuid)
       ORDER BY s.id
       LIMIT ${EXPORT_PAGE_SIZE}`
    if (rows.length === 0) return
    for (const row of rows) {
      yield [
        row.id,
        row.attendee_name ?? "",
        row.attendee_kind,
        row.ticket_type ?? "",
        iso(row.checked_in_at),
        row.checkin_method ?? "",
        iso(row.no_show_at),
      ]
    }
    after = rows[rows.length - 1]!.id
    if (rows.length < EXPORT_PAGE_SIZE) return
  }
}

async function* answerRows(sql: Sql, ctx: HostExportContext): AsyncIterable<readonly string[]> {
  let after = ""
  for (;;) {
    const rows = await sql<
      {
        id: string
        registration_id: string
        attendee_kind: string
        prompt: string
        value_text: string | null
        value_json: unknown
        scrubbed_at: Date | null
        created_at: Date
      }[]
    >`
      SELECT a.id, a.registration_id,
             CASE WHEN r.user_id IS NOT NULL THEN 'member' ELSE 'guest' END AS attendee_kind,
             q.prompt, a.value_text, a.value_json, a.scrubbed_at, a.created_at
        FROM cleanup_answers a
        JOIN cleanup_registrations r ON r.id = a.registration_id
        JOIN cleanup_questions q ON q.id = a.question_id
       WHERE a.cleanup_id = ${ctx.cleanupId}
         AND (${after} = '' OR a.id > ${after}::uuid)
       ORDER BY a.id
       LIMIT ${EXPORT_PAGE_SIZE}`
    if (rows.length === 0) return
    for (const row of rows) {
      const answer =
        row.scrubbed_at !== null
          ? ""
          : (row.value_text ?? (row.value_json === null ? "" : JSON.stringify(row.value_json)))
      yield [row.registration_id, row.attendee_kind, row.prompt, answer, iso(row.created_at)]
    }
    after = rows[rows.length - 1]!.id
    if (rows.length < EXPORT_PAGE_SIZE) return
  }
}

function shortRef(ctx: HostExportContext): string {
  return (ctx.cleanupId ?? ctx.organizationId ?? "event").slice(0, 8)
}

function dayOf(ctx: HostExportContext): string {
  return ctx.now.toISOString().slice(0, 10)
}
