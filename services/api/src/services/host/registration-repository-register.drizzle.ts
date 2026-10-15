import { AppError } from "@civfix/shared"
import type { EventVisibility } from "@civfix/shared"
import type { Queryable, Sql, TransactionSql } from "../../db/client.js"
import { constantTimeStringEqual } from "../../auth/crypto.js"
import { deterministicUuid } from "../deterministic-uuid.js"
import { isEventPubliclyVisible } from "./authz.js"
import { isUniqueViolationOn } from "../../db/pg-errors.js"
import { isReservedSeatsBackstopViolation } from "./registration-sql.js"
import {
  isBannedIn,
  loadRegistrationById,
  subjectIs,
} from "./registration-repository-load.drizzle.js"
import type {
  EventRegistrationContext,
  HostRegistrationRepository,
  RegisterSnapshot,
  RegisterTxArgs,
  RegisterTxOutcome,
  RegistrationSubject,
  TicketTypeRecord,
  WalkupCheckIn,
  WalkupRegisterArgs,
} from "./registration-repository.js"

export const REGISTER_IDEMPOTENCY_SCOPE = "event.register"

const SLOT_NOT_FOUND_MESSAGE = "That slot no longer exists."

const SLOT_FULL_MESSAGE = "That slot is already full."

const REGISTER_IDEMPOTENCY_CONSTRAINT = "idempotency_key_scope_owner_uk"

const ACTIVE_REGISTRATION_CONSTRAINTS = [
  "cleanup_registrations_active_user_uidx",
  "cleanup_registrations_active_guest_uidx",
]

export type RegisterMethods = Pick<HostRegistrationRepository, "registerTx" | "registerWalkupTx">

interface LockedRegistrationEvent {
  status: EventRegistrationContext["status"]
  visibility: EventRegistrationContext["visibility"]
  registration_opens_at: Date | null
  registration_closes_at: Date | null
  capacity: number | null
}

interface RegisterTicketTypeRow {
  id: string
  capacity: number | null
  reserved_seats: number
  sales_opens_at: Date | null
  sales_closes_at: Date | null
  visibility: TicketTypeRecord["visibility"]
  access_code_hash: string | null
  max_party_size: number
}

type TicketTypePick = { refusal: RegisterTxOutcome } | { ticketType: RegisterTicketTypeRow | null }

function ticketTypeNotFound(): TicketTypePick {
  return { refusal: { kind: "ticket_type_not_found" } }
}

class RegistrationRefusal extends Error {
  readonly outcome: RegisterTxOutcome

  constructor(outcome: RegisterTxOutcome) {
    super("registration refused after the transaction began writing")
    this.name = "RegistrationRefusal"
    this.outcome = outcome
  }
}

export function subjectOwner(subject: RegistrationSubject): string {
  return subject.kind === "user" ? `user:${subject.userId}` : `guest:${subject.guestId}`
}

// A guest has no standing that could open a private event, so a guest's own sign-up answers exactly as an
// unknown event does. A host seating a walk-up, and a guest already waiting when the event went private,
// act on standing the event granted earlier and keep working.
export function guestSelfRegistrationOnPrivateEvent(
  args: Pick<RegisterTxArgs, "subject" | "source">,
  visibility: EventVisibility,
): boolean {
  return (
    args.subject.kind === "guest" && args.source === "self" && !isEventPubliclyVisible(visibility)
  )
}

export function withinSalesWindow(now: Date, opensAt: Date | null, closesAt: Date | null): boolean {
  if (opensAt !== null && now < opensAt) return false
  if (closesAt !== null && now >= closesAt) return false
  return true
}

/**
 * Takes the slot row lock before counting, as the standalone slot claim in cleanup-repository does, so
 * registrations on different ticket types (which share no other lock) cannot both fill the last place.
 * A refusal throws so the whole registration rolls back rather than succeeding without the slot.
 */
async function claimSlotIn(
  tx: TransactionSql,
  args: { cleanupId: string; userId: string; slotId: string },
): Promise<void> {
  const slots = await tx<{ capacity: number | null }[]>`
    SELECT capacity FROM cleanup_slots
     WHERE id = ${args.slotId} AND cleanup_id = ${args.cleanupId}
     LIMIT 1
     FOR UPDATE
  `
  const slot = slots[0]
  if (slot === undefined) throw AppError.notFound(SLOT_NOT_FOUND_MESSAGE)

  const mine = await tx<{ slot_id: string }[]>`
    SELECT slot_id FROM cleanup_slot_claims
     WHERE cleanup_id = ${args.cleanupId} AND user_id = ${args.userId}
     LIMIT 1
  `
  if (mine[0]?.slot_id === args.slotId) return

  if (slot.capacity !== null) {
    const counted = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM cleanup_slot_claims WHERE slot_id = ${args.slotId}
    `
    if ((counted[0]?.n ?? 0) >= slot.capacity) throw AppError.conflict(SLOT_FULL_MESSAGE)
  }

  await tx`
    INSERT INTO cleanup_slot_claims (cleanup_id, user_id, slot_id)
    VALUES (${args.cleanupId}, ${args.userId}, ${args.slotId})
    ON CONFLICT (cleanup_id, user_id)
    DO UPDATE SET slot_id = EXCLUDED.slot_id, claimed_at = now()
  `
}

function idempotencyOwnerOf(args: RegisterTxArgs): string {
  return args.idempotencyOwner ?? subjectOwner(args.subject)
}

function registerIdempotencyKey(args: RegisterTxArgs): string {
  return deterministicUuid([
    REGISTER_IDEMPOTENCY_SCOPE,
    idempotencyOwnerOf(args),
    args.idempotencyKey,
  ])
}

async function findRegisterSnapshot(
  tag: Queryable,
  args: RegisterTxArgs,
): Promise<RegisterSnapshot | undefined> {
  const rows = await tag<{ response_snapshot: RegisterSnapshot }[]>`
    SELECT response_snapshot FROM idempotency_keys
     WHERE key = ${registerIdempotencyKey(args)}
       AND scope = ${REGISTER_IDEMPOTENCY_SCOPE}
       AND user_or_anon IS NOT DISTINCT FROM ${idempotencyOwnerOf(args)}
     LIMIT 1
  `
  return rows[0]?.response_snapshot
}

async function replayOf(
  tag: Queryable,
  args: RegisterTxArgs,
  snapshot: RegisterSnapshot,
): Promise<RegisterTxOutcome> {
  return {
    kind: "replayed",
    registration: await loadRegistrationById(tag, args.cleanupId, snapshot.registrationId),
  }
}

async function replaySnapshot(tag: Queryable, args: RegisterTxArgs): Promise<RegisterTxOutcome> {
  const snapshot = await findRegisterSnapshot(tag, args)
  if (snapshot === undefined) return { kind: "already_registered" }
  return replayOf(tag, args, snapshot)
}

export async function registerErrorOutcome(
  tag: Queryable,
  err: unknown,
  args: RegisterTxArgs,
): Promise<RegisterTxOutcome | null> {
  if (err instanceof RegistrationRefusal) return err.outcome
  if (isUniqueViolationOn(err, REGISTER_IDEMPOTENCY_CONSTRAINT)) return replaySnapshot(tag, args)
  // A concurrent twin carrying the same key blocks on the active-registration index and fails
  // there before its idempotency insert can; once the winner commits its snapshot is readable.
  if (isUniqueViolationOn(err, ...ACTIVE_REGISTRATION_CONSTRAINTS)) return replaySnapshot(tag, args)
  if (isReservedSeatsBackstopViolation(err)) {
    throw AppError.internal(
      "Registration could not be completed. The capacity guard rejected the write.",
    )
  }
  return null
}

// A same-key twin (a double tap) waits here until the first attempt commits, then reads its snapshot
// and replays; without it the twin could queue on a seat lock and answer "full" to the user who holds
// the seat. Only twins share this lock, and it precedes every lock registerIn takes, so it adds no
// lock-order edge.
async function lockRegisterIdempotency(tx: TransactionSql, args: RegisterTxArgs): Promise<void> {
  await tx`
    SELECT pg_advisory_xact_lock(hashtext('register_idempotency:' || ${registerIdempotencyKey(args)}))
  `
}

async function lockRegistrationEvent(
  tx: TransactionSql,
  cleanupId: string,
): Promise<LockedRegistrationEvent | undefined> {
  const locked = await tx<LockedRegistrationEvent[]>`
    SELECT status, visibility, registration_opens_at, registration_closes_at, capacity
      FROM cleanups WHERE id = ${cleanupId} LIMIT 1 FOR SHARE
  `
  return locked[0]
}

async function eventGateRefusal(
  tx: TransactionSql,
  event: LockedRegistrationEvent,
  args: RegisterTxArgs,
): Promise<RegisterTxOutcome | null> {
  if (event.status === "cancelled") return { kind: "closed" }
  if (!withinSalesWindow(args.now, event.registration_opens_at, event.registration_closes_at)) {
    return { kind: "registration_closed" }
  }
  if (args.subject.kind === "user" && (await isBannedIn(tx, args.cleanupId, args.subject.userId))) {
    return { kind: "banned" }
  }
  const active = await tx<{ id: string }[]>`
    SELECT id FROM cleanup_registrations
     WHERE cleanup_id = ${args.cleanupId}
       AND status = 'registered'
       AND ${subjectIs(tx, args.subject)}
     LIMIT 1
  `
  return active.length > 0 ? { kind: "already_registered" } : null
}

function selectTicketType(
  types: readonly RegisterTicketTypeRow[],
  args: RegisterTxArgs,
): TicketTypePick {
  if (args.ticketTypeId === null && types.length > 1) return ticketTypeNotFound()
  const ticketType =
    args.ticketTypeId === null ? (types[0] ?? null) : types.find((t) => t.id === args.ticketTypeId)
  if (ticketType === undefined) return ticketTypeNotFound()
  if (ticketType !== null && ticketType.visibility === "hidden" && args.source === "self") {
    return ticketTypeNotFound()
  }
  return { ticketType }
}

async function pickTicketType(tx: TransactionSql, args: RegisterTxArgs): Promise<TicketTypePick> {
  const types = await tx<RegisterTicketTypeRow[]>`
    SELECT id, capacity, reserved_seats, sales_opens_at, sales_closes_at,
           visibility, access_code_hash, max_party_size
      FROM cleanup_ticket_types
     WHERE cleanup_id = ${args.cleanupId}
     ORDER BY sort_order, id
  `
  return selectTicketType(types, args)
}

function ticketTypeGateRefusal(
  ticketType: RegisterTicketTypeRow,
  args: RegisterTxArgs,
  partySize: number,
): RegisterTxOutcome | null {
  if (ticketType.visibility === "access_code" && args.waitlistId === null) {
    if (args.accessCodeHash === null) return { kind: "access_code_required" }
    if (
      ticketType.access_code_hash === null ||
      !constantTimeStringEqual(args.accessCodeHash, ticketType.access_code_hash)
    ) {
      return { kind: "access_code_invalid" }
    }
  }
  if (partySize > ticketType.max_party_size) return { kind: "party_too_large" }
  if (
    args.waitlistId === null &&
    !withinSalesWindow(args.now, ticketType.sales_opens_at, ticketType.sales_closes_at)
  ) {
    return { kind: "sales_closed" }
  }
  return null
}

/** A claimed waitlist offer already holds its seats, so only a fresh sign-up reserves capacity here. */
async function reserveCapacity(
  tx: TransactionSql,
  args: RegisterTxArgs,
  eventCapacity: number | null,
  ticketType: RegisterTicketTypeRow | null,
  partySize: number,
): Promise<RegisterTxOutcome | null> {
  if (args.waitlistId !== null) return null
  if (ticketType === null) {
    if (eventCapacity === null) return null
    await tx`SELECT pg_advisory_xact_lock(hashtext('event_capacity:' || ${args.cleanupId}))`
    const taken = await tx<{ held: number }[]>`
      SELECT COALESCE(sum(party_size), 0)::int AS held
        FROM cleanup_registrations
       WHERE cleanup_id = ${args.cleanupId} AND status = 'registered'
    `
    return (taken[0]?.held ?? 0) + partySize > eventCapacity ? { kind: "full" } : null
  }
  const reserved = await tx<{ id: string }[]>`
    UPDATE cleanup_ticket_types
       SET reserved_seats = reserved_seats + ${partySize}, updated_at = ${args.now}
     WHERE id = ${ticketType.id}
       AND cleanup_id = ${args.cleanupId}
       AND ${partySize} <= max_party_size
       AND (sales_opens_at IS NULL OR sales_opens_at <= ${args.now})
       AND (sales_closes_at IS NULL OR sales_closes_at > ${args.now})
       AND (capacity IS NULL OR reserved_seats + ${partySize} <= capacity)
    RETURNING id
  `
  if (reserved.length === 0) throw new RegistrationRefusal({ kind: "full" })
  return null
}

async function insertRegistrationRow(
  tx: TransactionSql,
  args: RegisterTxArgs,
  ticketTypeId: string | null,
): Promise<string> {
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO cleanup_registrations (
      cleanup_id, ticket_type_id, user_id, guest_id, party_size, status, source, registered_at
    ) VALUES (
      ${args.cleanupId},
      ${ticketTypeId},
      ${args.subject.kind === "user" ? args.subject.userId : null},
      ${args.subject.kind === "guest" ? args.subject.guestId : null},
      ${args.seats.length},
      'registered',
      ${args.source},
      ${args.now}
    )
    RETURNING id
  `
  const registrationId = inserted[0]?.id
  if (registrationId === undefined) throw new Error("registration insert returned no row")
  return registrationId
}

async function insertSeatRows(
  tx: TransactionSql,
  args: RegisterTxArgs,
  registrationId: string,
): Promise<void> {
  const seatRows = args.seats.map((seat, index) => ({
    id: seat.id,
    cleanup_id: args.cleanupId,
    registration_id: registrationId,
    seat_index: index,
    attendee_name: seat.attendeeName,
    ticket_token_hash: seat.tokenHash,
    created_at: args.now,
  }))
  await tx`
    INSERT INTO cleanup_registration_seats ${tx(
      seatRows,
      "id",
      "cleanup_id",
      "registration_id",
      "seat_index",
      "attendee_name",
      "ticket_token_hash",
      "created_at",
    )}
  `
}

async function insertAnswerRows(
  tx: TransactionSql,
  args: RegisterTxArgs,
  registrationId: string,
): Promise<void> {
  if (args.answers.length === 0) return
  const answerRows = args.answers.map((answer) => ({
    cleanup_id: args.cleanupId,
    registration_id: registrationId,
    question_id: answer.questionId,
    value_text: answer.valueText,
    value_json:
      answer.valueJson === null ? null : tx.json(answer.valueJson as Parameters<typeof tx.json>[0]),
    created_at: args.now,
  }))
  await tx`
    INSERT INTO cleanup_answers ${tx(
      answerRows,
      "cleanup_id",
      "registration_id",
      "question_id",
      "value_text",
      "value_json",
      "created_at",
    )}
  `
}

async function insertConsentRow(
  tx: TransactionSql,
  args: RegisterTxArgs,
  registrationId: string,
): Promise<void> {
  if (args.consent === null) return
  await tx`
    INSERT INTO event_consents (
      cleanup_id, subject_type, user_id, guest_id, registration_id,
      terms_version, disclosure_version, host_contact_opt_in, sms_opt_in, surface,
      accepted_at
    ) VALUES (
      ${args.cleanupId},
      ${args.subject.kind},
      ${args.subject.kind === "user" ? args.subject.userId : null},
      ${args.subject.kind === "guest" ? args.subject.guestId : null},
      ${registrationId},
      ${args.consent.termsVersion},
      ${args.consent.disclosureVersion},
      ${args.consent.hostContactOptIn},
      ${args.consent.smsOptIn},
      ${args.consent.surface},
      ${args.now}
    )
  `
}

async function insertRegistrationRows(
  tx: TransactionSql,
  args: RegisterTxArgs,
  ticketTypeId: string | null,
): Promise<string> {
  if (args.subject.kind === "user") {
    await tx`
      INSERT INTO cleanup_members (cleanup_id, user_id, role)
      VALUES (${args.cleanupId}, ${args.subject.userId}, 'member')
      ON CONFLICT (cleanup_id, user_id) DO NOTHING
    `
  }
  const registrationId = await insertRegistrationRow(tx, args, ticketTypeId)
  await insertSeatRows(tx, args, registrationId)
  await insertAnswerRows(tx, args, registrationId)
  await insertConsentRow(tx, args, registrationId)
  return registrationId
}

async function linkWaitlistEntry(
  tx: TransactionSql,
  args: RegisterTxArgs,
  registrationId: string,
): Promise<void> {
  if (args.waitlistId === null) return
  await tx`
    UPDATE cleanup_waitlist
       SET promoted_registration_id = ${registrationId}
     WHERE id = ${args.waitlistId}
       AND cleanup_id = ${args.cleanupId}
       AND status = 'claimed'
  `
}

async function recordRegisterIdempotency(
  tx: TransactionSql,
  args: RegisterTxArgs,
  registrationId: string,
): Promise<void> {
  const snapshot: RegisterSnapshot = { registrationId }
  await tx`
    INSERT INTO idempotency_keys (key, scope, user_or_anon, response_snapshot)
    VALUES (
      ${registerIdempotencyKey(args)},
      ${REGISTER_IDEMPOTENCY_SCOPE},
      ${idempotencyOwnerOf(args)},
      ${tx.json(snapshot as unknown as Parameters<typeof tx.json>[0])}
    )
  `
}

/**
 * Every step shares the transaction. A refusal found before the first write returns; one found after it
 * throws, so the writes roll back.
 */
export async function registerIn(
  tx: TransactionSql,
  args: RegisterTxArgs,
): Promise<RegisterTxOutcome> {
  await lockRegisterIdempotency(tx, args)
  const event = await lockRegistrationEvent(tx, args.cleanupId)
  if (event === undefined || guestSelfRegistrationOnPrivateEvent(args, event.visibility)) {
    return { kind: "not_found" }
  }

  // A retry of a committed registration replays it even when a gate below has closed since.
  const replay = await findRegisterSnapshot(tx, args)
  if (replay !== undefined) return replayOf(tx, args, replay)

  const eventRefusal = await eventGateRefusal(tx, event, args)
  if (eventRefusal !== null) return eventRefusal

  const picked = await pickTicketType(tx, args)
  if ("refusal" in picked) return picked.refusal
  const { ticketType } = picked
  const partySize = args.seats.length
  const typeRefusal =
    ticketType === null ? null : ticketTypeGateRefusal(ticketType, args, partySize)
  if (typeRefusal !== null) return typeRefusal

  const capacityRefusal = await reserveCapacity(tx, args, event.capacity, ticketType, partySize)
  if (capacityRefusal !== null) return capacityRefusal

  // Ticket type, then slot, then member and registration rows: the standalone slot claim takes the
  // slot before its member and registration writes, so the reverse order here could deadlock.
  if (args.slotId !== null && args.subject.kind === "user") {
    await claimSlotIn(tx, {
      cleanupId: args.cleanupId,
      userId: args.subject.userId,
      slotId: args.slotId,
    })
  }

  const registrationId = await insertRegistrationRows(tx, args, ticketType?.id ?? null)
  await linkWaitlistEntry(tx, args, registrationId)
  await recordRegisterIdempotency(tx, args, registrationId)

  const registration = await loadRegistrationById(tx, args.cleanupId, registrationId)
  if (registration === null) throw new Error("registration reload returned no row")
  return { kind: "registered", registration }
}

async function insertWalkupGuest(tx: TransactionSql, args: WalkupRegisterArgs): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO cleanup_guests (
      cleanup_id, name, channel, email, phone, contact_key, manage_token_hash,
      verified_at, contact_scrubbed_at
    ) VALUES (
      ${args.cleanupId}, ${args.name}, 'email', NULL, NULL, NULL,
      ${args.manageTokenHash}, ${args.now}, ${args.now}
    )
    RETURNING id
  `
  const guestId = rows[0]?.id
  if (guestId === undefined) throw new Error("walk-up guest insert returned no row")
  return guestId
}

function walkupRegisterArgs(args: WalkupRegisterArgs, guestId: string): RegisterTxArgs {
  return {
    cleanupId: args.cleanupId,
    subject: { kind: "guest", guestId },
    ticketTypeId: args.ticketTypeId,
    seats: args.seats,
    accessCodeHash: null,
    answers: [],
    consent: null,
    slotId: null,
    source: "walkup",
    idempotencyKey: args.idempotencyKey,
    idempotencyOwner: args.idempotencyOwner,
    waitlistId: null,
    now: args.now,
  }
}

async function checkInWalkupSeats(
  tx: TransactionSql,
  args: WalkupRegisterArgs,
  registrationId: string,
  checkIn: WalkupCheckIn,
): Promise<void> {
  await tx`
    UPDATE cleanup_registration_seats
       SET checked_in_at  = ${args.now},
           checked_in_by  = ${checkIn.actorId},
           checkin_method = ${checkIn.method}
     WHERE registration_id = ${registrationId}
       AND cleanup_id = ${args.cleanupId}
       AND status = 'active'
       AND checked_in_at IS NULL
  `
}

export function makeRegisterMethods(sql: Sql): RegisterMethods {
  return {
    async registerTx(args: RegisterTxArgs): Promise<RegisterTxOutcome> {
      try {
        return await sql.begin((tx) => registerIn(tx, args))
      } catch (err) {
        const mapped = await registerErrorOutcome(sql, err, args)
        if (mapped !== null) return mapped
        throw err
      }
    },

    async registerWalkupTx(args: WalkupRegisterArgs): Promise<RegisterTxOutcome> {
      let registerArgs: RegisterTxArgs | null = null
      try {
        return await sql.begin(async (tx) => {
          registerArgs = walkupRegisterArgs(args, await insertWalkupGuest(tx, args))
          const outcome = await registerIn(tx, registerArgs)
          if (outcome.kind !== "registered") throw new RegistrationRefusal(outcome)
          if (args.checkIn === undefined || args.checkIn === null) return outcome
          await checkInWalkupSeats(tx, args, outcome.registration.id, args.checkIn)
          const checkedIn = await loadRegistrationById(tx, args.cleanupId, outcome.registration.id)
          if (checkedIn === null) throw new Error("walk-up reload returned no row")
          return { kind: "registered" as const, registration: checkedIn }
        })
      } catch (err) {
        if (registerArgs === null) throw err
        const mapped = await registerErrorOutcome(sql, err, registerArgs)
        if (mapped !== null) return mapped
        throw err
      }
    },
  }
}
