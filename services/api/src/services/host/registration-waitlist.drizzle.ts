import type postgres from "postgres"
import type { Queryable, Sql, TransactionSql } from "../../db/client.js"
import { constantTimeStringEqual } from "../../auth/crypto.js"
import {
  keysetInstant,
  keysetPredicate,
  paginateKeyset,
  parseKeysetCursor,
} from "../../db/cursor-helpers.js"
import { DEFAULT_EVENT_DURATION_MS, eventWindowOfRow, hasEventEnded } from "../cleanup-rules.js"
import {
  isUniqueViolationOn,
  toWaitlistRecord,
  waitlistColumns,
  waitlistEntryNotBanned,
  waitlistJoins,
  type WaitlistRowSelect,
} from "./registration-sql.js"
import {
  isBannedIn,
  loadRegistrationById,
  loadWaitlistEntry,
  subjectIs,
} from "./registration-load.drizzle.js"
import { registerErrorOutcome, registerIn } from "./registration-register.drizzle.js"
import type {
  ClaimWaitlistOutcome,
  EventRegistrationContext,
  HostRegistrationRepository,
  JoinWaitlistOutcome,
  RegisterTxArgs,
  RegistrationRecord,
  RegistrationSubject,
  TicketTypeRecord,
  WaitlistOffer,
  WaitlistRecord,
} from "./registration-repository.types.js"

const DEFAULT_EVENT_DURATION_SEC = DEFAULT_EVENT_DURATION_MS / 1000

const WAITLIST_ACTIVE_CONSTRAINTS = [
  "cleanup_waitlist_active_user_uidx",
  "cleanup_waitlist_active_guest_uidx",
]

const WAITLIST_CLAIM_IDEMPOTENCY_PREFIX = "waitlist:"

export type WaitlistMethods = Pick<
  HostRegistrationRepository,
  | "joinWaitlist"
  | "leaveWaitlist"
  | "listWaitlist"
  | "findWaitlistEntry"
  | "ticketTypeIdsWithWaiting"
  | "offerNextWaitlistEntry"
  | "offerWaitlistEntry"
  | "expireWaitlistOffers"
  | "claimWaitlistOffer"
>

type JoinWaitlistArgs = Parameters<HostRegistrationRepository["joinWaitlist"]>[0]

type ClaimWaitlistArgs = Parameters<HostRegistrationRepository["claimWaitlistOffer"]>[0]

export type ListWaitlistArgs = Parameters<HostRegistrationRepository["listWaitlist"]>[0]

interface LockedEventWindow {
  status: EventRegistrationContext["status"]
  scheduled_at: Date
  ends_at: Date | null
  now: Date
}

interface WaitlistTicketTypeRow {
  id: string
  waitlist_enabled: boolean
  visibility: TicketTypeRecord["visibility"]
  access_code_hash: string | null
}

type OfferCandidate = Omit<WaitlistOffer, "claimExpiresAt">

class ClaimRefusal extends Error {
  readonly outcome: ClaimWaitlistOutcome

  constructor(outcome: ClaimWaitlistOutcome) {
    super("waitlist claim refused after the transaction began writing")
    this.name = "ClaimRefusal"
    this.outcome = outcome
  }
}

/**
 * An EXISTS probe, not a join: a join under FOR UPDATE would also lock the cleanups row and invert the
 * cleanups -> cleanup_ticket_types -> cleanup_waitlist lock order every writer takes. The end instant
 * mirrors hasEventEnded (ends_at, else scheduled_at plus the default duration) on the DB clock.
 */
function waitlistEventStillLive(tag: Queryable) {
  return tag`EXISTS (
    SELECT 1 FROM cleanups c WHERE c.id = w.cleanup_id
       AND c.status <> 'cancelled'
       AND COALESCE(c.ends_at, c.scheduled_at + make_interval(secs => ${DEFAULT_EVENT_DURATION_SEC}))
           > now()
  )`
}

export async function cancelWaitlistEntriesIn(
  tag: Queryable,
  args: {
    cleanupId: string
    ticketTypeId: string | null
    subject: RegistrationSubject
    now: Date
  },
): Promise<{ left: number; releasedTicketTypeIds: string[] }> {
  const typeFilter =
    args.ticketTypeId === null ? tag`` : tag`AND ticket_type_id = ${args.ticketTypeId}`
  const rows = await tag<{ id: string; released_ticket_type_id: string | null }[]>`
    WITH left_entries AS (
      UPDATE cleanup_waitlist
         SET status = 'cancelled'
       WHERE cleanup_id = ${args.cleanupId}
         AND status IN ('waiting', 'offered')
         ${typeFilter}
         AND ${subjectIs(tag, args.subject)}
      RETURNING id, ticket_type_id, party_size, offered_at
    ), released AS (
      UPDATE cleanup_ticket_types t
         SET reserved_seats = GREATEST(t.reserved_seats - e.party_size, 0),
             updated_at = ${args.now}
        FROM left_entries e
       WHERE t.id = e.ticket_type_id AND e.offered_at IS NOT NULL
      RETURNING t.id
    )
    SELECT id,
           CASE WHEN offered_at IS NULL THEN NULL ELSE ticket_type_id END
             AS released_ticket_type_id
      FROM left_entries
  `
  return {
    left: rows.length,
    releasedTicketTypeIds: [
      ...new Set(
        rows.map((row) => row.released_ticket_type_id).filter((id): id is string => id !== null),
      ),
    ],
  }
}

export function waitlistEntryAsRegistration(entry: WaitlistRecord): RegistrationRecord {
  return {
    id: entry.id,
    cleanupId: entry.cleanupId,
    ticketTypeId: entry.ticketTypeId,
    ticketTypeName: entry.ticketTypeName,
    userId: entry.userId,
    guestId: entry.guestId,
    guestName: entry.guestName,
    identity: entry.identity,
    partySize: entry.partySize,
    status: "registered",
    source: "waitlist",
    hostNote: null,
    registeredAt: entry.createdAt,
    cancelledAt: null,
    checkedInAt: null,
    slotId: null,
    slotTitle: null,
    seats: [],
    answersPreview: null,
  }
}

export async function listWaitlistIn(
  tag: Queryable,
  args: ListWaitlistArgs,
): Promise<{ rows: WaitlistRecord[]; nextCursor: string | null }> {
  const typeFilter =
    args.ticketTypeId === null ? tag`` : tag`AND w.ticket_type_id = ${args.ticketTypeId}`
  const statusFilter =
    args.status === null
      ? tag`AND w.status IN ('waiting', 'offered')`
      : tag`AND w.status = ${args.status}`
  // A banned user can never be seated, so their open rows are not part of the host's queue; closed
  // rows stay listed as history.
  const bannedFilter =
    args.status === null || args.status === "waiting" || args.status === "offered"
      ? tag`AND ${waitlistEntryNotBanned(tag)}`
      : tag``
  const cursor = parseKeysetCursor(args.cursor, { direction: "asc" })
  const cursorFilter =
    cursor === null
      ? tag``
      : tag`AND ${keysetPredicate(tag, tag`w.created_at`, tag`w.id`, cursor, { direction: "asc" })}`
  const rows = await tag<(WaitlistRowSelect & { cursor_at: string })[]>`
    SELECT ${waitlistColumns(tag)}, ${keysetInstant(tag, tag`w.created_at`)} AS cursor_at
      FROM cleanup_waitlist w
      ${waitlistJoins(tag)}
     WHERE w.cleanup_id = ${args.cleanupId}
       ${typeFilter}
       ${statusFilter}
       ${cursorFilter}
       ${bannedFilter}
     ORDER BY w.created_at ASC, w.id ASC
     LIMIT ${args.limit + 1}
  `
  const { items, nextCursor } = paginateKeyset(rows, args.limit, (last) => ({
    atText: last.cursor_at,
    id: last.id,
  }))
  return { rows: items.map(toWaitlistRecord), nextCursor }
}

async function releaseWaitlistHold(
  tx: TransactionSql,
  cleanupId: string,
  waitlistId: string,
  now: Date,
): Promise<void> {
  await tx`
    WITH expired AS (
      UPDATE cleanup_waitlist SET status = 'expired'
       WHERE id = ${waitlistId} AND cleanup_id = ${cleanupId}
      RETURNING ticket_type_id, party_size, offered_at
    )
    UPDATE cleanup_ticket_types t
       SET reserved_seats = GREATEST(t.reserved_seats - e.party_size, 0),
           updated_at = ${now}
      FROM expired e
     WHERE t.id = e.ticket_type_id AND e.offered_at IS NOT NULL
  `
}

async function classifyUnclaimable(
  tx: TransactionSql,
  cleanupId: string,
  waitlistId: string,
  subject: RegistrationSubject,
  now: Date,
): Promise<ClaimWaitlistOutcome> {
  const rows = await tx<
    {
      status: WaitlistRecord["status"]
      claim_expires_at: Date | null
      user_id: string | null
      guest_id: string | null
      promoted_registration_id: string | null
    }[]
  >`
    SELECT status, claim_expires_at, user_id, guest_id, promoted_registration_id
      FROM cleanup_waitlist
     WHERE id = ${waitlistId} AND cleanup_id = ${cleanupId}
     LIMIT 1 FOR UPDATE
  `
  const row = rows[0]
  if (row === undefined) return { kind: "not_found" }
  const owns =
    subject.kind === "user" ? row.user_id === subject.userId : row.guest_id === subject.guestId
  if (row.status === "claimed" && owns && row.promoted_registration_id !== null) {
    const registration = await loadRegistrationById(tx, cleanupId, row.promoted_registration_id)
    if (registration !== null) return { kind: "claimed", registration }
  }
  if (row.status === "expired") return { kind: "expired" }
  if (row.status !== "offered") return { kind: "not_offered" }
  if (row.claim_expires_at !== null && row.claim_expires_at <= now) {
    await releaseWaitlistHold(tx, cleanupId, waitlistId, now)
    return { kind: "expired" }
  }
  return { kind: "not_offered" }
}

async function lockEventWindow(
  tx: TransactionSql,
  cleanupId: string,
): Promise<LockedEventWindow | undefined> {
  const locked = await tx<LockedEventWindow[]>`
    SELECT status, scheduled_at, ends_at, now() AS now FROM cleanups
     WHERE id = ${cleanupId} LIMIT 1 FOR SHARE
  `
  return locked[0]
}

function eventWindowEnded(event: LockedEventWindow): boolean {
  return hasEventEnded(eventWindowOfRow(event), event.now.getTime())
}

async function findLiveWaitlistEntryId(
  tag: Queryable,
  ticketTypeId: string,
  subject: RegistrationSubject,
): Promise<string | undefined> {
  const existing = await tag<{ id: string }[]>`
    SELECT id FROM cleanup_waitlist
     WHERE ticket_type_id = ${ticketTypeId}
       AND status IN ('waiting', 'offered')
       AND ${subjectIs(tag, subject)}
     LIMIT 1
  `
  return existing[0]?.id
}

function waitlistTicketTypeRefusal(
  type: WaitlistTicketTypeRow | undefined,
  accessCodeHash: string | null,
): JoinWaitlistOutcome | null {
  if (type === undefined || type.visibility === "hidden") return { kind: "ticket_type_not_found" }
  if (!type.waitlist_enabled) return { kind: "waitlist_disabled" }
  if (type.visibility !== "access_code") return null
  if (accessCodeHash === null) return { kind: "access_code_required" }
  if (
    type.access_code_hash === null ||
    !constantTimeStringEqual(accessCodeHash, type.access_code_hash)
  ) {
    return { kind: "access_code_invalid" }
  }
  return null
}

async function joinWaitlistGateRefusal(
  tx: TransactionSql,
  args: JoinWaitlistArgs,
): Promise<JoinWaitlistOutcome | null> {
  const event = await lockEventWindow(tx, args.cleanupId)
  if (event === undefined) return { kind: "not_found" }
  if (event.status === "cancelled") return { kind: "closed" }
  if (eventWindowEnded(event)) return { kind: "ended" }
  if (args.subject.kind === "user" && (await isBannedIn(tx, args.cleanupId, args.subject.userId))) {
    return { kind: "banned" }
  }

  const typeRows = await tx<WaitlistTicketTypeRow[]>`
    SELECT id, waitlist_enabled, visibility, access_code_hash
      FROM cleanup_ticket_types
     WHERE id = ${args.ticketTypeId} AND cleanup_id = ${args.cleanupId}
     LIMIT 1
  `
  const typeRefusal = waitlistTicketTypeRefusal(typeRows[0], args.accessCodeHash)
  if (typeRefusal !== null) return typeRefusal

  const registered = await tx<{ id: string }[]>`
    SELECT id FROM cleanup_registrations
     WHERE cleanup_id = ${args.cleanupId}
       AND status = 'registered'
       AND ${subjectIs(tx, args.subject)}
     LIMIT 1
  `
  return registered.length > 0 ? { kind: "already_registered" } : null
}

async function joinWaitlistIn(
  tx: TransactionSql,
  args: JoinWaitlistArgs,
): Promise<JoinWaitlistOutcome> {
  const refusal = await joinWaitlistGateRefusal(tx, args)
  if (refusal !== null) return refusal

  const existingId = await findLiveWaitlistEntryId(tx, args.ticketTypeId, args.subject)
  if (existingId !== undefined) {
    const entry = await loadWaitlistEntry(tx, args.cleanupId, existingId)
    if (entry === null) return { kind: "not_found" }
    return { kind: "already_waiting", entry }
  }

  const inserted = await tx<{ id: string }[]>`
    INSERT INTO cleanup_waitlist (
      cleanup_id, ticket_type_id, user_id, guest_id, party_size, status, created_at
    ) VALUES (
      ${args.cleanupId}, ${args.ticketTypeId},
      ${args.subject.kind === "user" ? args.subject.userId : null},
      ${args.subject.kind === "guest" ? args.subject.guestId : null},
      ${args.partySize}, 'waiting', ${args.now}
    )
    RETURNING id
  `
  const id = inserted[0]?.id
  if (id === undefined) throw new Error("waitlist insert returned no row")
  const entry = await loadWaitlistEntry(tx, args.cleanupId, id)
  if (entry === null) throw new Error("waitlist reload returned no row")
  return { kind: "joined", entry }
}

async function reserveAndOffer(
  tx: TransactionSql,
  candidate: OfferCandidate,
  cleanupScope: postgres.Fragment,
  now: Date,
  claimExpiresAt: Date,
): Promise<WaitlistOffer | null> {
  const reserved = await tx<{ id: string }[]>`
    UPDATE cleanup_ticket_types
       SET reserved_seats = reserved_seats + ${candidate.partySize}, updated_at = ${now}
     WHERE id = ${candidate.ticketTypeId}
       ${cleanupScope}
       AND (capacity IS NULL OR reserved_seats + ${candidate.partySize} <= capacity)
    RETURNING id
  `
  if (reserved.length === 0) return null

  await tx`
    UPDATE cleanup_waitlist
       SET status = 'offered', offered_at = ${now}, claim_expires_at = ${claimExpiresAt}
     WHERE id = ${candidate.waitlistId}
  `
  return { ...candidate, claimExpiresAt }
}

function claimRegisterArgs(
  args: ClaimWaitlistArgs,
  entry: WaitlistRecord,
  subject: RegistrationSubject,
): RegisterTxArgs {
  return {
    cleanupId: args.cleanupId,
    subject,
    ticketTypeId: entry.ticketTypeId,
    seats: args.seats.slice(0, entry.partySize),
    accessCodeHash: null,
    answers: [],
    consent: null,
    slotId: null,
    source: "waitlist",
    idempotencyKey: `${WAITLIST_CLAIM_IDEMPOTENCY_PREFIX}${args.waitlistId}`,
    waitlistId: args.waitlistId,
    now: args.now,
  }
}

async function claimOfferIn(
  tx: TransactionSql,
  args: ClaimWaitlistArgs,
  subject: RegistrationSubject,
  registerArgs: RegisterTxArgs,
): Promise<ClaimWaitlistOutcome> {
  const event = await lockEventWindow(tx, args.cleanupId)
  const claimed = await tx<
    { party_size: number; user_id: string | null; guest_id: string | null }[]
  >`
    UPDATE cleanup_waitlist
       SET status = 'claimed'
     WHERE id = ${args.waitlistId}
       AND cleanup_id = ${args.cleanupId}
       AND status = 'offered'
       AND (claim_expires_at IS NULL OR claim_expires_at > ${args.now})
       AND party_size = ${registerArgs.seats.length}
    RETURNING party_size, user_id, guest_id
  `
  const row = claimed[0]
  if (row === undefined) {
    return classifyUnclaimable(tx, args.cleanupId, args.waitlistId, subject, args.now)
  }

  const owns =
    subject.kind === "user" ? row.user_id === subject.userId : row.guest_id === subject.guestId
  if (!owns) throw new ClaimRefusal({ kind: "not_found" })

  // registerIn only gates self sign-ups on the event end, so an offer outliving its event
  // would otherwise still turn into a seat.
  if (event !== undefined && eventWindowEnded(event)) {
    await releaseWaitlistHold(tx, args.cleanupId, args.waitlistId, args.now)
    return { kind: "not_offered" }
  }

  const outcome = await registerIn(tx, registerArgs)
  if (outcome.kind === "registered") return { kind: "claimed", registration: outcome.registration }
  if (outcome.kind === "replayed" && outcome.registration !== null) {
    return { kind: "claimed", registration: outcome.registration }
  }
  if (outcome.kind === "registration_closed" || outcome.kind === "closed") {
    await releaseWaitlistHold(tx, args.cleanupId, args.waitlistId, args.now)
    return { kind: "not_offered" }
  }
  throw new ClaimRefusal({ kind: "not_offered" })
}

export function makeWaitlistMethods(sql: Sql): WaitlistMethods {
  return {
    async joinWaitlist(args: JoinWaitlistArgs): Promise<JoinWaitlistOutcome> {
      try {
        return await sql.begin((tx) => joinWaitlistIn(tx, args))
      } catch (err) {
        if (!isUniqueViolationOn(err, ...WAITLIST_ACTIVE_CONSTRAINTS)) throw err
        const existingId = await findLiveWaitlistEntryId(sql, args.ticketTypeId, args.subject)
        const entry =
          existingId === undefined ? null : await loadWaitlistEntry(sql, args.cleanupId, existingId)
        if (entry === null) return { kind: "not_found" }
        return { kind: "already_waiting", entry }
      }
    },

    async leaveWaitlist(args: {
      cleanupId: string
      ticketTypeId: string | null
      subject: RegistrationSubject
      now: Date
    }): Promise<{ left: number; releasedTicketTypeIds: string[] }> {
      return cancelWaitlistEntriesIn(sql, args)
    },

    async listWaitlist(
      args: ListWaitlistArgs,
    ): Promise<{ rows: WaitlistRecord[]; nextCursor: string | null }> {
      return listWaitlistIn(sql, args)
    },

    async findWaitlistEntry(cleanupId: string, waitlistId: string): Promise<WaitlistRecord | null> {
      return loadWaitlistEntry(sql, cleanupId, waitlistId)
    },

    async ticketTypeIdsWithWaiting(cleanupId: string): Promise<string[]> {
      const rows = await sql<{ ticket_type_id: string }[]>`
        SELECT DISTINCT ticket_type_id FROM cleanup_waitlist
         WHERE cleanup_id = ${cleanupId} AND status = 'waiting'
         LIMIT 20
      `
      return rows.map((r) => r.ticket_type_id)
    },

    async offerNextWaitlistEntry(args: {
      ticketTypeId: string
      now: Date
      claimWindowMs: number
    }): Promise<WaitlistOffer | null> {
      const expiresAt = new Date(args.now.getTime() + args.claimWindowMs)
      return sql.begin(async (tx) => {
        const candidates = await tx<
          {
            id: string
            cleanup_id: string
            user_id: string | null
            guest_id: string | null
            party_size: number
          }[]
        >`
          SELECT w.id, w.cleanup_id, w.user_id, w.guest_id, w.party_size
            FROM cleanup_waitlist w
           WHERE w.ticket_type_id = ${args.ticketTypeId} AND w.status = 'waiting'
             AND ${waitlistEntryNotBanned(tx)}
             AND ${waitlistEventStillLive(tx)}
           ORDER BY w.created_at, w.id
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        `
        const candidate = candidates[0]
        if (candidate === undefined) return null
        return reserveAndOffer(
          tx,
          {
            waitlistId: candidate.id,
            cleanupId: candidate.cleanup_id,
            ticketTypeId: args.ticketTypeId,
            userId: candidate.user_id,
            guestId: candidate.guest_id,
            partySize: candidate.party_size,
          },
          tx``,
          args.now,
          expiresAt,
        )
      })
    },

    async offerWaitlistEntry(args: {
      cleanupId: string
      waitlistId: string
      now: Date
      claimWindowMs: number
    }): Promise<WaitlistOffer | null> {
      const expiresAt = new Date(args.now.getTime() + args.claimWindowMs)
      return sql.begin(async (tx) => {
        const rows = await tx<
          {
            id: string
            ticket_type_id: string
            user_id: string | null
            guest_id: string | null
            party_size: number
          }[]
        >`
          SELECT w.id, w.ticket_type_id, w.user_id, w.guest_id, w.party_size
            FROM cleanup_waitlist w
           WHERE w.id = ${args.waitlistId}
             AND w.cleanup_id = ${args.cleanupId}
             AND w.status = 'waiting'
             AND ${waitlistEntryNotBanned(tx)}
             AND ${waitlistEventStillLive(tx)}
           LIMIT 1
           FOR UPDATE
        `
        const candidate = rows[0]
        if (candidate === undefined) return null
        return reserveAndOffer(
          tx,
          {
            waitlistId: candidate.id,
            cleanupId: args.cleanupId,
            ticketTypeId: candidate.ticket_type_id,
            userId: candidate.user_id,
            guestId: candidate.guest_id,
            partySize: candidate.party_size,
          },
          tx`AND cleanup_id = ${args.cleanupId}`,
          args.now,
          expiresAt,
        )
      })
    },

    async expireWaitlistOffers(args: { now: Date; limit: number }): Promise<string[]> {
      const rows = await sql<{ ticket_type_id: string }[]>`
        WITH expired AS (
          UPDATE cleanup_waitlist
             SET status = 'expired'
           WHERE id IN (
             SELECT id FROM cleanup_waitlist
              WHERE status = 'offered' AND claim_expires_at <= ${args.now}
              ORDER BY claim_expires_at
              LIMIT ${args.limit}
              FOR UPDATE SKIP LOCKED
           )
          RETURNING id, ticket_type_id, party_size
        ), released AS (
          UPDATE cleanup_ticket_types t
             SET reserved_seats = GREATEST(t.reserved_seats - e.party_size, 0),
                 updated_at = ${args.now}
            FROM expired e
           WHERE t.id = e.ticket_type_id
          RETURNING t.id
        )
        SELECT ticket_type_id FROM expired
      `
      return [...new Set(rows.map((r) => r.ticket_type_id))]
    },

    async claimWaitlistOffer(args: ClaimWaitlistArgs): Promise<ClaimWaitlistOutcome> {
      const entry = await loadWaitlistEntry(sql, args.cleanupId, args.waitlistId)
      if (entry === null) return { kind: "not_found" }
      if (args.subject !== null) {
        const matches =
          args.subject.kind === "user"
            ? entry.userId === args.subject.userId
            : entry.guestId === args.subject.guestId
        if (!matches) return { kind: "not_found" }
      }
      const subject: RegistrationSubject =
        entry.userId !== null
          ? { kind: "user", userId: entry.userId }
          : { kind: "guest", guestId: entry.guestId as string }
      const registerArgs = claimRegisterArgs(args, entry, subject)

      try {
        return await sql.begin((tx) => claimOfferIn(tx, args, subject, registerArgs))
      } catch (err) {
        if (err instanceof ClaimRefusal) return err.outcome
        const mapped = await registerErrorOutcome(sql, err, registerArgs)
        if (mapped === null) throw err
        if (mapped.kind === "replayed" && mapped.registration !== null) {
          return { kind: "claimed", registration: mapped.registration }
        }
        return { kind: "not_offered" }
      }
    },
  }
}
