import type { Sql } from "../../db/client.js"
import { registerHostExportBuilder, type HostExportContext } from "./export-builders.js"
import {
  makeDrizzleHostExportRowsRepository,
  type HostExportRowsRepository,
} from "./export-repository.drizzle.js"

const EXPORT_PAGE_SIZE = 1000
const SHORT_REF_LENGTH = 8
const ISO_DAY_LENGTH = 10
const SHORT_REF_FALLBACK = "event"

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
    rows: (ctx) => rosterRows(makeDrizzleHostExportRowsRepository(getSql()), ctx),
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
    rows: (ctx) => checkinRows(makeDrizzleHostExportRowsRepository(getSql()), ctx),
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
    rows: (ctx) => answerRows(makeDrizzleHostExportRowsRepository(getSql()), ctx),
  })
}

async function* keysetPages<Row>(
  fetchPage: (after: string) => Promise<readonly Row[]>,
  keyOf: (row: Row) => string,
): AsyncIterable<Row> {
  let after = ""
  for (;;) {
    const rows = await fetchPage(after)
    if (rows.length === 0) return
    yield* rows
    after = keyOf(rows[rows.length - 1]!)
    if (rows.length < EXPORT_PAGE_SIZE) return
  }
}

async function* rosterRows(
  repo: HostExportRowsRepository,
  ctx: HostExportContext,
): AsyncIterable<readonly string[]> {
  const pages = keysetPages(
    (after) => repo.rosterPage(ctx.cleanupId, after, EXPORT_PAGE_SIZE),
    (row) => row.registration_id,
  )
  for await (const row of pages) {
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
}

async function* checkinRows(
  repo: HostExportRowsRepository,
  ctx: HostExportContext,
): AsyncIterable<readonly string[]> {
  const pages = keysetPages(
    (after) => repo.checkinPage(ctx.cleanupId, after, EXPORT_PAGE_SIZE),
    (row) => row.id,
  )
  for await (const row of pages) {
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
}

async function* answerRows(
  repo: HostExportRowsRepository,
  ctx: HostExportContext,
): AsyncIterable<readonly string[]> {
  const pages = keysetPages(
    (after) => repo.answerPage(ctx.cleanupId, after, EXPORT_PAGE_SIZE),
    (row) => row.id,
  )
  for await (const row of pages) {
    const answer =
      row.scrubbed_at !== null
        ? ""
        : (row.value_text ?? (row.value_json === null ? "" : JSON.stringify(row.value_json)))
    yield [row.registration_id, row.attendee_kind, row.prompt, answer, iso(row.created_at)]
  }
}

function shortRef(ctx: HostExportContext): string {
  return (ctx.cleanupId ?? ctx.organizationId ?? SHORT_REF_FALLBACK).slice(0, SHORT_REF_LENGTH)
}

function dayOf(ctx: HostExportContext): string {
  return ctx.now.toISOString().slice(0, ISO_DAY_LENGTH)
}
