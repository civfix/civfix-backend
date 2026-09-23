import type { RegistrationRosterFilter, RegistrationRosterSort } from "@civfix/shared"
import type { Queryable, Sql } from "../../db/client.js"
import {
  encodeKeysetCursor,
  encodeNameCursor,
  keysetInstant,
  keysetPredicate,
  pageWith,
  parseKeysetCursor,
  parseNameCursor,
} from "../../db/cursor-helpers.js"
import { likeContains } from "../../db/like.js"
import {
  registrationColumns,
  registrationJoins,
  type RegistrationRowSelect,
} from "./registration-sql.js"
import { hydrate, loadRegistrationById } from "./registration-load.drizzle.js"
import {
  cancelWaitlistEntriesIn,
  listWaitlistIn,
  waitlistEntryAsRegistration,
} from "./registration-waitlist.drizzle.js"
import type {
  CancelRegistrationOutcome,
  HostRegistrationRepository,
  RegistrationRecord,
  RegistrationSubject,
  RemoveRegistrationOutcome,
  RosterPage,
  RosterQuery,
  TransferRegistrationOutcome,
} from "./registration-repository.types.js"

export type RosterMethods = Pick<
  HostRegistrationRepository,
  | "findRegistration"
  | "findMyRegistration"
  | "findRegistrationsFor"
  | "listRoster"
  | "setHostNote"
  | "cancelRegistration"
  | "removeRegistration"
  | "transferRegistration"
>

type CancelRegistrationArgs = Parameters<HostRegistrationRepository["cancelRegistration"]>[0]

type RemoveRegistrationArgs = Parameters<HostRegistrationRepository["removeRegistration"]>[0]

type TransferRegistrationArgs = Parameters<HostRegistrationRepository["transferRegistration"]>[0]

type RosterRowSelect = RegistrationRowSelect & { cursor_at: string; checked_in_cursor_at: string }

const rosterCheckedInKey = (tag: Queryable) => tag`COALESCE(ci.first_at, 'epoch'::timestamptz)`

const ROSTER_SORTS = Object.freeze({
  registered_at_desc: (tag: Queryable) => tag`r.registered_at DESC, r.id DESC`,
  registered_at_asc: (tag: Queryable) => tag`r.registered_at ASC, r.id ASC`,
  name_asc: (tag: Queryable) =>
    tag`lower(COALESCE(u.display_name, g.name, '')) ASC, r.registered_at DESC, r.id DESC`,
  checked_in_at_desc: (tag: Queryable) =>
    tag`${rosterCheckedInKey(tag)} DESC, r.registered_at DESC, r.id DESC`,
}) satisfies Readonly<Record<RegistrationRosterSort, (tag: Queryable) => unknown>>

/**
 * Both instants are the microsecond text Postgres rendered (or a legacy cursor spelled), bound back as
 * text: a Date anchor drops the microseconds and skips every row sharing the anchor's millisecond.
 */
interface CheckedInRosterCursor {
  checkedInAtText: string
  registeredAtText: string | null
  id: string
}

// Carries every ORDER BY key: everyone not yet checked in shares the epoch sort key, so a cursor
// without registered_at cannot say where inside that tie the previous page stopped.
function encodeCheckedInRosterCursor(row: RosterRowSelect): string {
  return `${row.checked_in_cursor_at}|${encodeKeysetCursor(row.cursor_at, row.id)}`
}

function parseCheckedInRosterCursor(cursor: string): CheckedInRosterCursor | null {
  const parts = cursor.split("|")
  if (parts.length <= 2) {
    const legacy = parseKeysetCursor(cursor, { direction: "desc" })
    return legacy === null
      ? null
      : { checkedInAtText: legacy.atText, registeredAtText: null, id: legacy.id }
  }
  if (parts.length !== 3) return null
  const [checkedInText, registeredText, id] = parts
  const checkedIn = parseKeysetCursor(`${checkedInText}|${id}`)
  const registered = parseKeysetCursor(`${registeredText}|${id}`)
  if (checkedIn === null || registered === null) return null
  return {
    checkedInAtText: checkedIn.atText,
    registeredAtText: registered.atText,
    id: registered.id,
  }
}

function rosterStatusFilter(tag: Queryable, filter: RegistrationRosterFilter) {
  switch (filter) {
    case "registered":
      return tag`AND r.status = 'registered'`
    case "cancelled":
      return tag`AND r.status = 'cancelled'`
    case "guests":
      return tag`AND r.status = 'registered' AND r.guest_id IS NOT NULL`
    case "members":
      return tag`AND r.status = 'registered' AND r.user_id IS NOT NULL`
    case "checked_in":
      return tag`AND r.status = 'registered' AND ci.first_at IS NOT NULL`
    case "not_checked_in":
      return tag`AND r.status = 'registered' AND ci.first_at IS NULL`
    case "no_show":
      return tag`AND r.status = 'registered' AND EXISTS (
        SELECT 1 FROM cleanup_registration_seats s
         WHERE s.registration_id = r.id AND s.no_show_at IS NOT NULL
      )`
    default:
      return tag``
  }
}

function rosterSearchFilter(tag: Queryable, q: string | null) {
  if (q === null || q.length === 0) return tag``
  const pattern = likeContains(q)
  return tag`AND (
    u.display_name ILIKE ${pattern} ESCAPE '\\'
    OR u.handle ILIKE ${pattern} ESCAPE '\\'
    OR g.name ILIKE ${pattern} ESCAPE '\\'
    OR EXISTS (
      SELECT 1 FROM cleanup_registration_seats s
       WHERE s.registration_id = r.id AND s.attendee_name ILIKE ${pattern} ESCAPE '\\'
    )
  )`
}

function checkedInCursorFilter(tag: Queryable, raw: string) {
  const cursor = parseCheckedInRosterCursor(raw)
  if (cursor === null) return tag``
  if (cursor.registeredAtText === null) {
    // A cursor minted before it carried registered_at cannot place itself inside a tie, so it
    // resumes at the start of that tie: a row may repeat once, none is skipped.
    return tag`AND ${rosterCheckedInKey(tag)} <= ${cursor.checkedInAtText}::timestamptz`
  }
  return tag`AND (${rosterCheckedInKey(tag)}, r.registered_at, r.id) < (${cursor.checkedInAtText}::timestamptz, ${cursor.registeredAtText}::timestamptz, ${cursor.id}::uuid)`
}

function rosterCursorFilter(tag: Queryable, sort: RegistrationRosterSort, raw: string | null) {
  if (raw === null) return tag``
  if (sort === "name_asc") {
    const cursor = parseNameCursor(raw)
    if (cursor === null) return tag``
    return tag`AND (lower(COALESCE(u.display_name, g.name, '')), r.id) > (${cursor.name}, ${cursor.id}::uuid)`
  }
  if (sort === "checked_in_at_desc") return checkedInCursorFilter(tag, raw)
  const direction = sort === "registered_at_asc" ? "asc" : "desc"
  const cursor = parseKeysetCursor(raw, { direction })
  if (cursor === null) return tag``
  return tag`AND ${keysetPredicate(tag, tag`r.registered_at`, tag`r.id`, cursor, { direction })}`
}

function encodeRosterCursor(sort: RegistrationRosterSort, last: RosterRowSelect): string {
  if (sort === "name_asc") {
    return encodeNameCursor({
      name: (last.person_display_name ?? last.guest_name ?? "").toLowerCase(),
      id: last.id,
    })
  }
  if (sort === "checked_in_at_desc") return encodeCheckedInRosterCursor(last)
  return encodeKeysetCursor(last.cursor_at, last.id)
}

async function listWaitlistedRoster(sql: Sql, query: RosterQuery): Promise<RosterPage> {
  const page = await listWaitlistIn(sql, {
    cleanupId: query.cleanupId,
    ticketTypeId: query.ticketTypeId,
    status: null,
    cursor: query.cursor,
    limit: query.limit,
  })
  return {
    rows: page.rows
      .filter((entry) => entry.status === "waiting" || entry.status === "offered")
      .map(waitlistEntryAsRegistration),
    nextCursor: page.nextCursor,
  }
}

async function countRegistered(sql: Sql, cleanupId: string): Promise<number> {
  const counted = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM cleanup_registrations
     WHERE cleanup_id = ${cleanupId} AND status = 'registered'
  `
  return counted[0]?.n ?? 0
}

async function listRosterIn(sql: Sql, query: RosterQuery): Promise<RosterPage> {
  const typeFilter =
    query.ticketTypeId === null ? sql`` : sql`AND r.ticket_type_id = ${query.ticketTypeId}`
  const slotFilter = query.slotId === null ? sql`` : sql`AND sc.slot_id = ${query.slotId}`
  const rows = await sql<RosterRowSelect[]>`
    SELECT ${registrationColumns(sql)},
           ${keysetInstant(sql, sql`r.registered_at`)} AS cursor_at,
           ${keysetInstant(sql, rosterCheckedInKey(sql))} AS checked_in_cursor_at
      FROM cleanup_registrations r
      ${registrationJoins(sql)}
     WHERE r.cleanup_id = ${query.cleanupId}
       ${rosterStatusFilter(sql, query.filter)}
       ${typeFilter}
       ${slotFilter}
       ${rosterSearchFilter(sql, query.q)}
       ${rosterCursorFilter(sql, query.sort, query.cursor)}
     ORDER BY ${ROSTER_SORTS[query.sort](sql)}
     LIMIT ${query.limit + 1}
  `
  const { items, nextCursor } = pageWith(rows, query.limit, (last) =>
    encodeRosterCursor(query.sort, last),
  )
  const page: RosterPage = { rows: await hydrate(sql, items), nextCursor }
  if (query.withTotal) page.total = await countRegistered(sql, query.cleanupId)
  return page
}

export interface AppliedBan {
  cancelledRegistrations: { id: string; ticketTypeId: string | null }[]
  /** Ticket types that got seats back, from cancelled registrations or released waitlist offers. */
  releasedTicketTypeIds: string[]
}

/**
 * The one ban path behind removing an attendee from the event and removing them from the roster.
 * The event row lock comes first: every registration, join and waitlist path reads the ban under
 * FOR SHARE on the same row, so one racing the ban either commits before it (and is undone here) or
 * reads the ban. Waitlist rows are cancelled before registrations, the cleanup_waitlist ->
 * cleanup_ticket_types order the expiry sweep and leaveWaitlist take, so the two cannot deadlock.
 */
export async function applyBanIn(
  tx: Queryable,
  args: { cleanupId: string; userId: string; actorId: string; now: Date },
): Promise<AppliedBan> {
  await tx`
    SELECT id FROM cleanups WHERE id = ${args.cleanupId} LIMIT 1 FOR NO KEY UPDATE
  `
  await tx`
    INSERT INTO cleanup_bans (cleanup_id, user_id, banned_by_user_id)
    VALUES (${args.cleanupId}, ${args.userId}, ${args.actorId})
    ON CONFLICT (cleanup_id, user_id) DO NOTHING
  `
  await tx`
    DELETE FROM cleanup_members
     WHERE cleanup_id = ${args.cleanupId} AND user_id = ${args.userId} AND role = 'member'
  `
  const waitlist = await cancelWaitlistEntriesIn(tx, {
    cleanupId: args.cleanupId,
    ticketTypeId: null,
    subject: { kind: "user", userId: args.userId },
    now: args.now,
  })
  const cancelled = await tx<{ id: string; ticket_type_id: string | null }[]>`
    WITH cancelled AS (
      UPDATE cleanup_registrations
         SET status = 'cancelled', cancelled_at = ${args.now}, cancelled_by = ${args.actorId}
       WHERE cleanup_id = ${args.cleanupId}
         AND user_id = ${args.userId}
         AND status = 'registered'
      RETURNING id, ticket_type_id, party_size
    ), seats AS (
      UPDATE cleanup_registration_seats s
         SET status = 'cancelled'
        FROM cancelled c
       WHERE s.registration_id = c.id AND s.status = 'active'
      RETURNING s.id
    ), held AS (
      SELECT ticket_type_id, sum(party_size)::int AS seats
        FROM cancelled
       WHERE ticket_type_id IS NOT NULL
       GROUP BY ticket_type_id
    ), released AS (
      UPDATE cleanup_ticket_types t
         SET reserved_seats = GREATEST(t.reserved_seats - h.seats, 0),
             updated_at = ${args.now}
        FROM held h
       WHERE t.id = h.ticket_type_id
      RETURNING t.id
    )
    SELECT id, ticket_type_id FROM cancelled
  `
  await tx`
    DELETE FROM cleanup_slot_claims
     WHERE cleanup_id = ${args.cleanupId} AND user_id = ${args.userId}
  `
  const registrationTypes = cancelled
    .map((row) => row.ticket_type_id)
    .filter((id): id is string => id !== null)
  return {
    cancelledRegistrations: cancelled.map((row) => ({
      id: row.id,
      ticketTypeId: row.ticket_type_id,
    })),
    releasedTicketTypeIds: [...new Set([...waitlist.releasedTicketTypeIds, ...registrationTypes])],
  }
}

async function cancelRegistrationIn(
  tag: Queryable,
  args: CancelRegistrationArgs,
): Promise<CancelRegistrationOutcome> {
  const cancelled = await tag<{ id: string; ticket_type_id: string | null }[]>`
    WITH cancelled AS (
      UPDATE cleanup_registrations
         SET status = 'cancelled', cancelled_at = ${args.now}, cancelled_by = ${args.actorId}
       WHERE id = ${args.registrationId}
         AND cleanup_id = ${args.cleanupId}
         AND status = 'registered'
      RETURNING id, ticket_type_id, party_size
    ), seats AS (
      UPDATE cleanup_registration_seats s
         SET status = 'cancelled'
        FROM cancelled c
       WHERE s.registration_id = c.id AND s.status = 'active'
      RETURNING s.id
    ), released AS (
      UPDATE cleanup_ticket_types t
         SET reserved_seats = GREATEST(t.reserved_seats - c.party_size, 0),
             updated_at = ${args.now}
        FROM cancelled c
       WHERE t.id = c.ticket_type_id
      RETURNING t.id
    )
    SELECT id, ticket_type_id FROM cancelled
  `
  const row = cancelled[0]
  if (row === undefined) {
    const existing = await loadRegistrationById(tag, args.cleanupId, args.registrationId)
    return existing === null ? { kind: "not_found" } : { kind: "already_cancelled" }
  }
  const registration = await loadRegistrationById(tag, args.cleanupId, row.id)
  if (registration === null) return { kind: "not_found" }
  return { kind: "cancelled", registration, ticketTypeId: row.ticket_type_id }
}

async function removeRegistrationIn(
  tx: Queryable,
  args: RemoveRegistrationArgs,
): Promise<RemoveRegistrationOutcome> {
  const target = await tx<{ user_id: string | null }[]>`
    SELECT user_id FROM cleanup_registrations
     WHERE id = ${args.registrationId} AND cleanup_id = ${args.cleanupId}
     LIMIT 1
  `
  if (target.length === 0) return { kind: "not_found", releasedWaitlistTicketTypeIds: [] }
  const bannedUserId = args.ban ? (target[0]?.user_id ?? null) : null
  if (bannedUserId === null) {
    const outcome = await cancelRegistrationIn(tx, args)
    return { ...outcome, releasedWaitlistTicketTypeIds: [] }
  }
  const ban = await applyBanIn(tx, {
    cleanupId: args.cleanupId,
    userId: bannedUserId,
    actorId: args.actorId,
    now: args.now,
  })
  const releasedWaitlistTicketTypeIds = ban.releasedTicketTypeIds
  const removed = ban.cancelledRegistrations.find((r) => r.id === args.registrationId)
  if (removed === undefined) {
    const outcome = await cancelRegistrationIn(tx, args)
    return { ...outcome, releasedWaitlistTicketTypeIds }
  }
  const registration = await loadRegistrationById(tx, args.cleanupId, removed.id)
  if (registration === null) return { kind: "not_found", releasedWaitlistTicketTypeIds }
  return {
    kind: "cancelled",
    registration,
    ticketTypeId: removed.ticketTypeId,
    releasedWaitlistTicketTypeIds,
  }
}

async function transferRegistrationIn(
  tx: Queryable,
  args: TransferRegistrationArgs,
): Promise<TransferRegistrationOutcome> {
  // The event row first, as applyBanIn takes it: a ban holds it while it moves ticket-type seats and
  // then cancels registrations, so a transfer that locked its registration before the ticket types
  // could wait on the ban from the opposite end. registerIn's FOR SHARE on the same row keeps the
  // same order.
  const event = await tx<{ id: string }[]>`
    SELECT id FROM cleanups WHERE id = ${args.cleanupId} LIMIT 1 FOR NO KEY UPDATE
  `
  if (event[0] === undefined) return { kind: "not_found" }
  const locked = await tx<
    { id: string; ticket_type_id: string | null; party_size: number; status: string }[]
  >`
    SELECT id, ticket_type_id, party_size, status
      FROM cleanup_registrations
     WHERE id = ${args.registrationId} AND cleanup_id = ${args.cleanupId}
     LIMIT 1 FOR UPDATE
  `
  const current = locked[0]
  if (current === undefined || current.status !== "registered") return { kind: "not_found" }
  if (current.ticket_type_id === args.ticketTypeId) return { kind: "same_type" }

  const wanted = [
    ...new Set(
      [args.ticketTypeId, current.ticket_type_id].filter((id): id is string => id !== null),
    ),
  ].sort()
  const types = await tx<
    { id: string; max_party_size: number; capacity: number | null; reserved_seats: number }[]
  >`
    SELECT id, max_party_size, capacity, reserved_seats
      FROM cleanup_ticket_types
     WHERE cleanup_id = ${args.cleanupId} AND id = ANY(${wanted}::uuid[])
     ORDER BY id
     FOR UPDATE
  `
  const targetType = types.find((t) => t.id === args.ticketTypeId)
  if (targetType === undefined) return { kind: "ticket_type_not_found" }
  if (current.party_size > targetType.max_party_size) return { kind: "party_too_large" }

  const reserved = await tx<{ id: string }[]>`
    UPDATE cleanup_ticket_types
       SET reserved_seats = reserved_seats + ${current.party_size}, updated_at = ${args.now}
     WHERE id = ${args.ticketTypeId}
       AND cleanup_id = ${args.cleanupId}
       AND (capacity IS NULL OR reserved_seats + ${current.party_size} <= capacity)
    RETURNING id
  `
  if (reserved.length === 0) return { kind: "full" }

  if (current.ticket_type_id !== null) {
    await tx`
      UPDATE cleanup_ticket_types
         SET reserved_seats = GREATEST(reserved_seats - ${current.party_size}, 0),
             updated_at = ${args.now}
       WHERE id = ${current.ticket_type_id} AND cleanup_id = ${args.cleanupId}
    `
  }

  await tx`
    UPDATE cleanup_registrations
       SET ticket_type_id = ${args.ticketTypeId}, source = 'transfer'
     WHERE id = ${args.registrationId} AND cleanup_id = ${args.cleanupId}
  `

  const registration = await loadRegistrationById(tx, args.cleanupId, args.registrationId)
  if (registration === null) return { kind: "not_found" }
  return { kind: "transferred", registration, previousTicketTypeId: current.ticket_type_id }
}

export function makeRosterMethods(sql: Sql): RosterMethods {
  return {
    async findRegistration(
      cleanupId: string,
      registrationId: string,
    ): Promise<RegistrationRecord | null> {
      return loadRegistrationById(sql, cleanupId, registrationId)
    },

    async findMyRegistration(
      cleanupId: string,
      subject: RegistrationSubject,
    ): Promise<RegistrationRecord | null> {
      const rows = await sql<RegistrationRowSelect[]>`
        SELECT ${registrationColumns(sql)}
          FROM cleanup_registrations r
          ${registrationJoins(sql)}
         WHERE r.cleanup_id = ${cleanupId}
           AND ${
             subject.kind === "user"
               ? sql`r.user_id = ${subject.userId}`
               : sql`r.guest_id = ${subject.guestId}`
           }
         ORDER BY (r.status = 'registered') DESC, r.registered_at DESC
         LIMIT 1
      `
      const hydrated = await hydrate(sql, rows)
      return hydrated[0] ?? null
    },

    async findRegistrationsFor(
      cleanupIds: readonly string[],
      userId: string,
    ): Promise<Map<string, RegistrationRecord>> {
      const out = new Map<string, RegistrationRecord>()
      if (cleanupIds.length === 0) return out
      const rows = await sql<RegistrationRowSelect[]>`
        SELECT ${registrationColumns(sql)}
          FROM cleanup_registrations r
          ${registrationJoins(sql)}
         WHERE r.cleanup_id = ANY(${[...cleanupIds]}::uuid[])
           AND r.user_id = ${userId}
           AND r.status = 'registered'
      `
      for (const record of await hydrate(sql, rows)) out.set(record.cleanupId, record)
      return out
    },

    async listRoster(query: RosterQuery): Promise<RosterPage> {
      if (query.filter === "waitlisted") return listWaitlistedRoster(sql, query)
      return listRosterIn(sql, query)
    },

    async setHostNote(
      cleanupId: string,
      registrationId: string,
      note: string | null,
    ): Promise<boolean> {
      const rows = await sql<{ id: string }[]>`
        UPDATE cleanup_registrations SET host_note = ${note}
         WHERE id = ${registrationId} AND cleanup_id = ${cleanupId}
        RETURNING id
      `
      return rows.length > 0
    },

    async cancelRegistration(args: CancelRegistrationArgs): Promise<CancelRegistrationOutcome> {
      return cancelRegistrationIn(sql, args)
    },

    async removeRegistration(args: RemoveRegistrationArgs): Promise<RemoveRegistrationOutcome> {
      return sql.begin((tx) => removeRegistrationIn(tx, args))
    },

    async transferRegistration(
      args: TransferRegistrationArgs,
    ): Promise<TransferRegistrationOutcome> {
      return sql.begin((tx) => transferRegistrationIn(tx, args))
    },
  }
}
