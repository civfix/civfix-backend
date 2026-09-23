import { AppError } from "@civfix/shared"
import type { CheckinMethod, RegistrationRosterSort } from "@civfix/shared"
import type { Queryable, Sql, TransactionSql } from "../../db/client.js"
import { constantTimeStringEqual } from "../../auth/crypto.js"
import {
  encodeNameCursor,
  encodeTimeCursor,
  pageWith,
  parseNameCursor,
  parseTimeCursor,
} from "../../db/cursor-helpers.js"
import { eventWindowOfRow, hasEventEnded } from "../cleanup-rules.js"
import { cleanupStatusExpr } from "../cleanup-sql.js"
import { mediaBoundElsewhere, mediaBoundToCleanup } from "../media-bindings.js"
import { MEDIA_CLAIM_WINDOW_SEC } from "./event-media.js"
import { deterministicUuid } from "../deterministic-uuid.js"
import {
  isCheckViolationOn,
  isReservedSeatsBackstopViolation,
  isUniqueViolationOn,
  questionColumns,
  registrationColumns,
  registrationJoins,
  SALES_WINDOW_CONSTRAINT,
  seatColumns,
  ticketTypeColumns,
  ticketTypeJoins,
  toAnswerRecord,
  toPageRecord,
  toQuestionRecord,
  toRegistrationRecord,
  toSeatRecord,
  toTicketTypeRecord,
  toWaitlistRecord,
  waitlistColumns,
  waitlistJoins,
  type AnswerRowSelect,
  type PageRowSelect,
  type QuestionRowSelect,
  type RegistrationRowSelect,
  type SeatRowSelect,
  type TicketTypeRowSelect,
  type WaitlistRowSelect,
} from "./registration-sql.js"
import type {
  AnswerRecord,
  CancelRegistrationOutcome,
  CheckinCountersRecord,
  CheckinResultRecord,
  ClaimWaitlistOutcome,
  CreateTicketTypeOutcome,
  DeleteTicketTypeOutcome,
  DesiredQuestion,
  EventRegistrationContext,
  HostRegistrationRepository,
  HostedEventCounts,
  JoinWaitlistOutcome,
  PageRecord,
  PublicPageRecord,
  QuestionRecord,
  RegisterSnapshot,
  RegisterTxArgs,
  RegisterTxOutcome,
  RegistrationRecord,
  RegistrationSubject,
  ReorderTicketTypesOutcome,
  RosterPage,
  RosterQuery,
  SavePageArgs,
  SavePageOutcome,
  SeatRecord,
  TicketTypeCapacityFit,
  TicketTypeRecord,
  TicketTypeWriteArgs,
  TransferRegistrationOutcome,
  UpdateTicketTypeOutcome,
  WalkupRegisterArgs,
  WaitlistOffer,
  WaitlistRecord,
} from "./registration-repository.types.js"

export const MAX_TICKET_TYPES = 20

export const REGISTER_IDEMPOTENCY_SCOPE = "event.register"

export const ARRIVAL_BUCKET_MINUTES = 15

const ACTIVE_REGISTRATION_CONSTRAINTS = [
  "cleanup_registrations_active_user_uidx",
  "cleanup_registrations_active_guest_uidx",
]

const ROSTER_SORTS = Object.freeze({
  registered_at_desc: (tag: Sql) => tag`r.registered_at DESC, r.id DESC`,
  registered_at_asc: (tag: Sql) => tag`r.registered_at ASC, r.id ASC`,
  name_asc: (tag: Sql) =>
    tag`lower(COALESCE(u.display_name, g.name, '')) ASC, r.registered_at DESC, r.id DESC`,
  checked_in_at_desc: (tag: Sql) =>
    tag`COALESCE(ci.first_at, 'epoch'::timestamptz) DESC, r.registered_at DESC, r.id DESC`,
}) satisfies Readonly<Record<RegistrationRosterSort, (tag: Sql) => unknown>>

class RegistrationRefusal extends Error {
  readonly outcome: RegisterTxOutcome

  constructor(outcome: RegisterTxOutcome) {
    super("registration refused after the transaction began writing")
    this.name = "RegistrationRefusal"
    this.outcome = outcome
  }
}

class ClaimRefusal extends Error {
  readonly outcome: ClaimWaitlistOutcome

  constructor(outcome: ClaimWaitlistOutcome) {
    super("waitlist claim refused after the transaction began writing")
    this.name = "ClaimRefusal"
    this.outcome = outcome
  }
}

async function claimPageMediaInTx(
  tx: Queryable,
  cleanupId: string,
  mediaIds: readonly string[],
  asCover: "event_cover" | null,
): Promise<string[]> {
  const wanted = [...new Set(mediaIds)]
  if (wanted.length === 0) return []
  const claimed = await tx<{ id: string }[]>`
    UPDATE media_assets
    SET purpose = ${
      asCover === null
        ? tx`CASE WHEN media_assets.purpose IN ('event_cover', 'event_gallery')
                  THEN media_assets.purpose ELSE 'event_gallery' END`
        : tx`'event_cover'`
    }
    WHERE media_assets.id = ANY(${wanted}::uuid[])
      AND media_assets.purpose <> 'verification'
      AND media_assets.report_id IS NULL
      AND media_assets.post_id IS NULL
      AND media_assets.chat_message_id IS NULL
      AND (
        media_assets.status = 'ready'
        OR (media_assets.status = 'validating' AND media_assets.finalized_at IS NOT NULL)
      )
      AND NOT (${mediaBoundElsewhere(tx, cleanupId)})
      AND (
        (${mediaBoundToCleanup(tx, cleanupId)})
        OR media_assets.created_at > now() - make_interval(secs => ${MEDIA_CLAIM_WINDOW_SEC})
      )
    RETURNING media_assets.id
  `
  return claimed.map((row) => row.id)
}

function subjectOwner(subject: RegistrationSubject): string {
  return subject.kind === "user" ? `user:${subject.userId}` : `guest:${subject.guestId}`
}

export function registrationIdempotencyOwner(subject: RegistrationSubject): string {
  return subjectOwner(subject)
}

function withinSalesWindow(now: Date, opensAt: Date | null, closesAt: Date | null): boolean {
  if (opensAt !== null && now < opensAt) return false
  if (closesAt !== null && now >= closesAt) return false
  return true
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

export function makeDrizzleHostRegistrationRepository(sql: Sql): HostRegistrationRepository {
  async function loadTicketTypes(
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

  async function loadTicketType(
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

  async function hydrate(
    tag: Queryable,
    rows: readonly RegistrationRowSelect[],
  ): Promise<RegistrationRecord[]> {
    const seats = await loadSeats(
      tag,
      rows.map((r) => r.id),
    )
    return rows.map((r) => toRegistrationRecord(r, seats.get(r.id) ?? []))
  }

  async function loadRegistrationById(
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

  async function eventContextIn(
    tag: Queryable,
    cleanupId: string,
  ): Promise<EventRegistrationContext | null> {
    const rows = await tag<
      {
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
      }[]
    >`
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
    if (row === undefined) return null
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

  async function applyQuestionOwnership(
    tag: Queryable,
    cleanupId: string,
    ticketTypeId: string,
    questionIds: readonly string[],
  ): Promise<void> {
    await tag`
      UPDATE cleanup_questions
         SET ticket_type_id = NULL, updated_at = now()
       WHERE cleanup_id = ${cleanupId}
         AND ticket_type_id = ${ticketTypeId}
         AND NOT (id = ANY(${[...questionIds]}::uuid[]))
    `
    if (questionIds.length === 0) return
    await tag`
      UPDATE cleanup_questions
         SET ticket_type_id = ${ticketTypeId}, updated_at = now()
       WHERE cleanup_id = ${cleanupId}
         AND id = ANY(${[...questionIds]}::uuid[])
    `
  }

  async function ticketTypeCapacityFit(
    tx: TransactionSql,
    cleanupId: string,
    eventCapacity: number | null,
    nextCapacity: number | null,
    excludeTicketTypeId: string | null,
  ): Promise<TicketTypeCapacityFit> {
    if (eventCapacity === null) return { ok: true }
    const exclude = excludeTicketTypeId === null ? tx`` : tx`AND id <> ${excludeTicketTypeId}`
    const rows = await tx<{ used: number | null; unlimited: boolean | null }[]>`
      SELECT sum(capacity)::int AS used, bool_or(capacity IS NULL) AS unlimited
        FROM cleanup_ticket_types
       WHERE cleanup_id = ${cleanupId}
         ${exclude}
    `
    const used = rows[0]?.used ?? 0
    if (rows[0]?.unlimited === true) return { ok: false, eventCapacity, used }
    if (nextCapacity === null) return { ok: false, eventCapacity, used }
    if (used + nextCapacity > eventCapacity) return { ok: false, eventCapacity, used }
    return { ok: true }
  }

  async function loadWaitlistEntry(
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

  async function listWaitlistIn(
    tag: Queryable,
    args: {
      cleanupId: string
      ticketTypeId: string | null
      status: WaitlistRecord["status"] | null
      cursor: string | null
      limit: number
    },
  ): Promise<{ rows: WaitlistRecord[]; nextCursor: string | null }> {
    const typeFilter =
      args.ticketTypeId === null ? tag`` : tag`AND w.ticket_type_id = ${args.ticketTypeId}`
    const statusFilter =
      args.status === null
        ? tag`AND w.status IN ('waiting', 'offered')`
        : tag`AND w.status = ${args.status}`
    const cursor = parseTimeCursor(args.cursor, { direction: "asc" })
    const cursorFilter =
      cursor === null ? tag`` : tag`AND (w.created_at, w.id) > (${cursor.at}, ${cursor.id}::uuid)`
    const rows = await tag<WaitlistRowSelect[]>`
      SELECT ${waitlistColumns(tag)}
        FROM cleanup_waitlist w
        ${waitlistJoins(tag)}
       WHERE w.cleanup_id = ${args.cleanupId}
         ${typeFilter}
         ${statusFilter}
         ${cursorFilter}
       ORDER BY w.created_at ASC, w.id ASC
       LIMIT ${args.limit + 1}
    `
    const { items, nextCursor } = pageWith(rows, args.limit, (last) =>
      encodeTimeCursor({ at: last.created_at, id: last.id }),
    )
    return { rows: items.map(toWaitlistRecord), nextCursor }
  }

  async function loadPage(tag: Queryable, cleanupId: string): Promise<PageRecord | null> {
    const rows = await tag<PageRowSelect[]>`
      SELECT c.id AS cleanup_id,
             c.page_slug AS slug,
             COALESCE(p.status, 'draft') AS status,
             COALESCE(p.theme_accent, 'bloom') AS theme_accent,
             p.blocks,
             p.seo,
             c.cover_media_id,
             m.r2_key AS cover_key,
             c.visibility,
             p.published_at,
             p.updated_at,
             p.flagged_at,
             p.flag_reason,
             COALESCE(p.view_count, 0) AS view_count
        FROM cleanups c
        LEFT JOIN cleanup_pages p ON p.cleanup_id = c.id
        LEFT JOIN media_assets m ON m.id = c.cover_media_id AND m.status = 'ready'
       WHERE c.id = ${cleanupId}
       LIMIT 1
    `
    const row = rows[0]
    return row === undefined ? null : toPageRecord(row)
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

  async function registerErrorOutcome(
    err: unknown,
    args: RegisterTxArgs,
  ): Promise<RegisterTxOutcome | null> {
    if (err instanceof RegistrationRefusal) return err.outcome
    if (isUniqueViolationOn(err, "idempotency_key_scope_owner_uk")) return replaySnapshot(sql, args)
    if (isUniqueViolationOn(err, ...ACTIVE_REGISTRATION_CONSTRAINTS)) {
      return { kind: "already_registered" }
    }
    if (isReservedSeatsBackstopViolation(err)) {
      throw AppError.internal(
        "Registration could not be completed. The capacity guard rejected the write.",
      )
    }
    return null
  }

  async function registerIn(tx: TransactionSql, args: RegisterTxArgs): Promise<RegisterTxOutcome> {
    const partySize = args.seats.length
    const locked = await tx<
      {
        status: EventRegistrationContext["status"]
        registration_opens_at: Date | null
        registration_closes_at: Date | null
        capacity: number | null
      }[]
    >`
      SELECT status, registration_opens_at, registration_closes_at, capacity
        FROM cleanups WHERE id = ${args.cleanupId} LIMIT 1 FOR SHARE
    `
    const event = locked[0]
    if (event === undefined) return { kind: "not_found" as const }
    if (event.status === "cancelled") return { kind: "closed" as const }
    if (!withinSalesWindow(args.now, event.registration_opens_at, event.registration_closes_at)) {
      return { kind: "registration_closed" as const }
    }

    if (args.subject.kind === "user") {
      const banned = await tx<{ one: number }[]>`
        SELECT 1 AS one FROM cleanup_bans
         WHERE cleanup_id = ${args.cleanupId} AND user_id = ${args.subject.userId}
         LIMIT 1
      `
      if (banned.length > 0) return { kind: "banned" as const }
    }

    const replay = await findRegisterSnapshot(tx, args)
    if (replay !== undefined) return replayOf(tx, args, replay)

    const active = await tx<{ id: string }[]>`
      SELECT id FROM cleanup_registrations
       WHERE cleanup_id = ${args.cleanupId}
         AND status = 'registered'
         AND ${
           args.subject.kind === "user"
             ? tx`user_id = ${args.subject.userId}`
             : tx`guest_id = ${args.subject.guestId}`
         }
       LIMIT 1
    `
    if (active.length > 0) return { kind: "already_registered" as const }

    const types = await tx<
      {
        id: string
        capacity: number | null
        reserved_seats: number
        sales_opens_at: Date | null
        sales_closes_at: Date | null
        visibility: TicketTypeRecord["visibility"]
        access_code_hash: string | null
        max_party_size: number
      }[]
    >`
      SELECT id, capacity, reserved_seats, sales_opens_at, sales_closes_at,
             visibility, access_code_hash, max_party_size
        FROM cleanup_ticket_types
       WHERE cleanup_id = ${args.cleanupId}
       ORDER BY sort_order, id
    `

    let ticketType: (typeof types)[number] | null = null
    if (args.ticketTypeId !== null) {
      ticketType = types.find((t) => t.id === args.ticketTypeId) ?? null
      if (ticketType === null) return { kind: "ticket_type_not_found" as const }
    } else if (types.length === 1) {
      ticketType = types[0] ?? null
    } else if (types.length > 1) {
      return { kind: "ticket_type_not_found" as const }
    }

    if (ticketType !== null) {
      if (ticketType.visibility === "access_code" && args.waitlistId === null) {
        if (args.accessCodeHash === null) return { kind: "access_code_required" as const }
        if (
          ticketType.access_code_hash === null ||
          !constantTimeStringEqual(args.accessCodeHash, ticketType.access_code_hash)
        ) {
          return { kind: "access_code_invalid" as const }
        }
      }
      if (partySize > ticketType.max_party_size) {
        return { kind: "party_too_large" as const }
      }
      if (
        args.waitlistId === null &&
        !withinSalesWindow(args.now, ticketType.sales_opens_at, ticketType.sales_closes_at)
      ) {
        return { kind: "sales_closed" as const }
      }
    }

    if (ticketType === null && event.capacity !== null && args.waitlistId === null) {
      await tx`SELECT pg_advisory_xact_lock(hashtext('event_capacity:' || ${args.cleanupId}))`
      const taken = await tx<{ held: number }[]>`
        SELECT COALESCE(sum(party_size), 0)::int AS held
          FROM cleanup_registrations
         WHERE cleanup_id = ${args.cleanupId} AND status = 'registered'
      `
      if ((taken[0]?.held ?? 0) + partySize > event.capacity) {
        return { kind: "full" as const }
      }
    }

    if (args.subject.kind === "user") {
      await tx`
        INSERT INTO cleanup_members (cleanup_id, user_id, role)
        VALUES (${args.cleanupId}, ${args.subject.userId}, 'member')
        ON CONFLICT (cleanup_id, user_id) DO NOTHING
      `
    }

    if (ticketType !== null && args.waitlistId === null) {
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
      if (reserved.length === 0) {
        throw new RegistrationRefusal({ kind: "full" })
      }
    }

    const insertedRegistration = await tx<{ id: string }[]>`
      INSERT INTO cleanup_registrations (
        cleanup_id, ticket_type_id, user_id, guest_id, party_size, status, source, registered_at
      ) VALUES (
        ${args.cleanupId},
        ${ticketType === null ? null : ticketType.id},
        ${args.subject.kind === "user" ? args.subject.userId : null},
        ${args.subject.kind === "guest" ? args.subject.guestId : null},
        ${partySize},
        'registered',
        ${args.source},
        ${args.now}
      )
      RETURNING id
    `
    const registrationId = insertedRegistration[0]?.id
    if (registrationId === undefined) {
      throw new Error("registration insert returned no row")
    }

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

    if (args.answers.length > 0) {
      const answerRows = args.answers.map((answer) => ({
        cleanup_id: args.cleanupId,
        registration_id: registrationId,
        question_id: answer.questionId,
        value_text: answer.valueText,
        value_json:
          answer.valueJson === null
            ? null
            : tx.json(answer.valueJson as Parameters<typeof tx.json>[0]),
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

    if (args.consent !== null) {
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

    if (args.slotId !== null && args.subject.kind === "user") {
      await tx`
        INSERT INTO cleanup_slot_claims (cleanup_id, user_id, slot_id)
        SELECT ${args.cleanupId}, ${args.subject.userId}, s.id
          FROM cleanup_slots s
         WHERE s.id = ${args.slotId}
           AND s.cleanup_id = ${args.cleanupId}
           AND (
             s.capacity IS NULL
             OR (SELECT count(*) FROM cleanup_slot_claims c WHERE c.slot_id = s.id) < s.capacity
           )
        ON CONFLICT (cleanup_id, user_id)
        DO UPDATE SET slot_id = EXCLUDED.slot_id, claimed_at = now()
      `
    }

    if (args.waitlistId !== null) {
      await tx`
        UPDATE cleanup_waitlist
           SET promoted_registration_id = ${registrationId}
         WHERE id = ${args.waitlistId}
           AND cleanup_id = ${args.cleanupId}
           AND status = 'claimed'
      `
    }

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

    const registration = await loadRegistrationById(tx, args.cleanupId, registrationId)
    if (registration === null) throw new Error("registration reload returned no row")
    return { kind: "registered" as const, registration }
  }

  async function runRegisterTx(args: RegisterTxArgs): Promise<RegisterTxOutcome> {
    try {
      return await sql.begin((tx) => registerIn(tx, args))
    } catch (err) {
      const mapped = await registerErrorOutcome(err, args)
      if (mapped !== null) return mapped
      throw err
    }
  }

  const repo: HostRegistrationRepository = {
    async eventContext(cleanupId: string): Promise<EventRegistrationContext | null> {
      return eventContextIn(sql, cleanupId)
    },

    async listTicketTypes(cleanupId: string): Promise<TicketTypeRecord[]> {
      return loadTicketTypes(sql, [cleanupId])
    },

    async listTicketTypesFor(
      cleanupIds: readonly string[],
    ): Promise<Map<string, TicketTypeRecord[]>> {
      const out = new Map<string, TicketTypeRecord[]>()
      for (const record of await loadTicketTypes(sql, cleanupIds)) {
        const bucket = out.get(record.cleanupId)
        if (bucket === undefined) out.set(record.cleanupId, [record])
        else bucket.push(record)
      }
      return out
    },

    async getTicketType(cleanupId: string, ticketTypeId: string): Promise<TicketTypeRecord | null> {
      return loadTicketType(sql, cleanupId, ticketTypeId)
    },

    async ticketTypeIdsMatchingAccessCode(
      cleanupId: string,
      accessCodeHash: string,
    ): Promise<string[]> {
      const rows = await sql<{ id: string; access_code_hash: string | null }[]>`
        SELECT id, access_code_hash FROM cleanup_ticket_types
         WHERE cleanup_id = ${cleanupId} AND visibility = 'access_code'
         ORDER BY sort_order, id
         LIMIT ${MAX_TICKET_TYPES}
      `
      return rows
        .filter(
          (row) =>
            row.access_code_hash !== null &&
            constantTimeStringEqual(accessCodeHash, row.access_code_hash),
        )
        .map((row) => row.id)
    },

    async createTicketType(args: TicketTypeWriteArgs): Promise<CreateTicketTypeOutcome> {
      try {
        return await sql.begin(async (tx) => {
          const locked = await tx<{ id: string; capacity: number | null }[]>`
            SELECT id, capacity FROM cleanups
             WHERE id = ${args.cleanupId}
             LIMIT 1 FOR NO KEY UPDATE
          `
          const event = locked[0]
          if (event === undefined) return { kind: "not_found" as const }

          const counted = await tx<{ n: number }[]>`
            SELECT count(*)::int AS n FROM cleanup_ticket_types WHERE cleanup_id = ${args.cleanupId}
          `
          if ((counted[0]?.n ?? 0) >= MAX_TICKET_TYPES) return { kind: "too_many" as const }

          const fit = await ticketTypeCapacityFit(
            tx,
            args.cleanupId,
            event.capacity,
            args.capacity,
            null,
          )
          if (!fit.ok) {
            return {
              kind: "capacity_exceeded" as const,
              eventCapacity: fit.eventCapacity,
              used: fit.used,
            }
          }

          const sortOrder =
            args.sortOrder ??
            (
              await tx<{ next: number }[]>`
                SELECT COALESCE(max(sort_order), -1) + 1 AS next
                  FROM cleanup_ticket_types WHERE cleanup_id = ${args.cleanupId}
              `
            )[0]?.next ??
            0

          const inserted = await tx<{ id: string }[]>`
            INSERT INTO cleanup_ticket_types (
              cleanup_id, name, description, capacity, sales_opens_at, sales_closes_at,
              visibility, access_code_hash, max_party_size, sort_order, waitlist_enabled,
              created_at, updated_at
            ) VALUES (
              ${args.cleanupId}, ${args.name}, ${args.description}, ${args.capacity},
              ${args.salesOpensAt}, ${args.salesClosesAt}, ${args.visibility},
              ${args.accessCodeHash}, ${args.maxPartySize}, ${sortOrder}, ${args.waitlistEnabled},
              ${args.now}, ${args.now}
            )
            RETURNING id
          `
          const id = inserted[0]?.id
          if (id === undefined) throw new Error("ticket type insert returned no row")

          if (args.questionIds !== null) {
            await applyQuestionOwnership(tx, args.cleanupId, id, args.questionIds)
          }

          const record = await loadTicketType(tx, args.cleanupId, id)
          if (record === null) throw new Error("ticket type reload returned no row")
          return { kind: "created" as const, record }
        })
      } catch (err) {
        if (isUniqueViolationOn(err, "cleanup_ticket_types_cleanup_name_uidx")) {
          return { kind: "name_taken" }
        }
        if (isCheckViolationOn(err, SALES_WINDOW_CONSTRAINT)) return { kind: "sales_window" }
        throw err
      }
    },

    async updateTicketType(
      args: TicketTypeWriteArgs & { ticketTypeId: string; patch: readonly string[] },
    ): Promise<UpdateTicketTypeOutcome> {
      const patch = new Set(args.patch)
      try {
        return await sql.begin(async (tx) => {
          const event = (
            await tx<{ id: string; capacity: number | null }[]>`
              SELECT id, capacity FROM cleanups
               WHERE id = ${args.cleanupId}
               LIMIT 1 FOR NO KEY UPDATE
            `
          )[0]
          if (event === undefined) return { kind: "not_found" as const }

          const locked = await tx<{ reserved_seats: number }[]>`
            SELECT reserved_seats FROM cleanup_ticket_types
             WHERE id = ${args.ticketTypeId} AND cleanup_id = ${args.cleanupId}
             LIMIT 1 FOR UPDATE
          `
          const current = locked[0]
          if (current === undefined) return { kind: "not_found" as const }

          if (
            patch.has("capacity") &&
            args.capacity !== null &&
            args.capacity < current.reserved_seats
          ) {
            return {
              kind: "capacity_below_reserved" as const,
              reservedSeats: current.reserved_seats,
            }
          }

          if (patch.has("capacity")) {
            const fit = await ticketTypeCapacityFit(
              tx,
              args.cleanupId,
              event.capacity,
              args.capacity,
              args.ticketTypeId,
            )
            if (!fit.ok) {
              return {
                kind: "capacity_exceeded" as const,
                eventCapacity: fit.eventCapacity,
                used: fit.used,
              }
            }
          }

          await tx`
            UPDATE cleanup_ticket_types SET
              name             = ${patch.has("name") ? args.name : sql`name`},
              description      = ${patch.has("description") ? args.description : sql`description`},
              capacity         = ${patch.has("capacity") ? args.capacity : sql`capacity`},
              sales_opens_at   = ${patch.has("salesOpensAt") ? args.salesOpensAt : sql`sales_opens_at`},
              sales_closes_at  = ${patch.has("salesClosesAt") ? args.salesClosesAt : sql`sales_closes_at`},
              visibility       = ${patch.has("visibility") ? args.visibility : sql`visibility`},
              access_code_hash = ${
                args.clearAccessCode
                  ? null
                  : args.accessCodeHash !== null
                    ? args.accessCodeHash
                    : sql`access_code_hash`
              },
              max_party_size   = ${patch.has("maxPartySize") ? args.maxPartySize : sql`max_party_size`},
              sort_order       = ${patch.has("sortOrder") && args.sortOrder !== null ? args.sortOrder : sql`sort_order`},
              waitlist_enabled = ${patch.has("waitlistEnabled") ? args.waitlistEnabled : sql`waitlist_enabled`},
              updated_at       = ${args.now}
            WHERE id = ${args.ticketTypeId} AND cleanup_id = ${args.cleanupId}
          `

          if (args.questionIds !== null) {
            await applyQuestionOwnership(tx, args.cleanupId, args.ticketTypeId, args.questionIds)
          }

          const record = await loadTicketType(tx, args.cleanupId, args.ticketTypeId)
          if (record === null) return { kind: "not_found" as const }
          return { kind: "updated" as const, record }
        })
      } catch (err) {
        if (isUniqueViolationOn(err, "cleanup_ticket_types_cleanup_name_uidx")) {
          return { kind: "name_taken" }
        }
        if (isCheckViolationOn(err, SALES_WINDOW_CONSTRAINT)) return { kind: "sales_window" }
        throw err
      }
    },

    async deleteTicketType(
      cleanupId: string,
      ticketTypeId: string,
    ): Promise<DeleteTicketTypeOutcome> {
      return sql.begin(async (tx) => {
        const locked = await tx<{ id: string }[]>`
          SELECT id FROM cleanup_ticket_types
           WHERE id = ${ticketTypeId} AND cleanup_id = ${cleanupId}
           LIMIT 1 FOR UPDATE
        `
        if (locked[0] === undefined) return { kind: "not_found" as const }

        const referenced = await tx<{ one: number }[]>`
          SELECT 1 AS one WHERE EXISTS (
            SELECT 1 FROM cleanup_registrations WHERE ticket_type_id = ${ticketTypeId}
          ) OR EXISTS (
            SELECT 1 FROM cleanup_waitlist WHERE ticket_type_id = ${ticketTypeId}
          )
        `
        if (referenced.length > 0) return { kind: "in_use" as const }

        await tx`
          UPDATE cleanup_questions SET ticket_type_id = NULL, updated_at = now()
           WHERE cleanup_id = ${cleanupId} AND ticket_type_id = ${ticketTypeId}
        `
        await tx`
          DELETE FROM cleanup_ticket_types
           WHERE id = ${ticketTypeId} AND cleanup_id = ${cleanupId}
        `
        return { kind: "deleted" as const }
      })
    },

    async reorderTicketTypes(
      cleanupId: string,
      ticketTypeIds: readonly string[],
      now: Date,
    ): Promise<ReorderTicketTypesOutcome> {
      return sql.begin(async (tx) => {
        const existing = await tx<{ id: string }[]>`
          SELECT id FROM cleanup_ticket_types WHERE cleanup_id = ${cleanupId} ORDER BY id
        `
        const have = new Set(existing.map((r) => r.id))
        const want = new Set(ticketTypeIds)
        if (have.size !== want.size || [...want].some((id) => !have.has(id))) {
          return { kind: "mismatch" as const }
        }
        for (const [index, id] of ticketTypeIds.entries()) {
          await tx`
            UPDATE cleanup_ticket_types SET sort_order = ${index}, updated_at = ${now}
             WHERE id = ${id} AND cleanup_id = ${cleanupId}
          `
        }
        return { kind: "reordered" as const, items: await loadTicketTypes(tx, [cleanupId]) }
      })
    },

    async listQuestions(
      cleanupId: string,
      opts?: { ticketTypeId?: string | null; includeArchived?: boolean },
    ): Promise<QuestionRecord[]> {
      const archivedFilter = opts?.includeArchived === true ? sql`` : sql`AND archived_at IS NULL`
      const scoped = opts !== undefined && "ticketTypeId" in opts
      const ticketTypeId = opts?.ticketTypeId ?? null
      const typeFilter = !scoped
        ? sql``
        : ticketTypeId === null
          ? sql`AND ticket_type_id IS NULL`
          : sql`AND (ticket_type_id IS NULL OR ticket_type_id = ${ticketTypeId})`
      const rows = await sql<QuestionRowSelect[]>`
        SELECT ${questionColumns(sql)}
          FROM cleanup_questions
         WHERE cleanup_id = ${cleanupId}
           ${archivedFilter}
           ${typeFilter}
         ORDER BY sort_order, id
      `
      return rows.map(toQuestionRecord)
    },

    async reconcileQuestions(
      cleanupId: string,
      desired: readonly DesiredQuestion[],
      now: Date,
    ): Promise<QuestionRecord[]> {
      return sql.begin(async (tx) => {
        const locked = await tx<{ id: string }[]>`
          SELECT id FROM cleanups WHERE id = ${cleanupId} LIMIT 1 FOR SHARE
        `
        if (locked[0] === undefined) return []

        const keep = desired.map((q) => q.id).filter((id): id is string => id !== null)
        await tx`
          UPDATE cleanup_questions
             SET archived_at = ${now}, updated_at = ${now}
           WHERE cleanup_id = ${cleanupId}
             AND archived_at IS NULL
             AND NOT (id = ANY(${keep}::uuid[]))
        `

        for (const q of desired) {
          const options = tx.json(q.options as Parameters<typeof tx.json>[0])
          const showIf =
            q.showIf === null ? null : tx.json(q.showIf as Parameters<typeof tx.json>[0])
          if (q.id !== null) {
            await tx`
              UPDATE cleanup_questions SET
                ticket_type_id = ${q.ticketTypeId},
                kind           = ${q.kind},
                prompt         = ${q.prompt},
                help_text      = ${q.helpText},
                required       = ${q.required},
                options        = ${options},
                max_selections = ${q.maxSelections},
                consent_text   = ${q.consentText},
                show_if        = ${showIf},
                sort_order     = ${q.sortOrder},
                archived_at    = NULL,
                updated_at     = ${now}
              WHERE id = ${q.id} AND cleanup_id = ${cleanupId}
            `
          } else {
            await tx`
              INSERT INTO cleanup_questions (
                cleanup_id, ticket_type_id, kind, prompt, help_text, required,
                options, max_selections, consent_text, show_if, sort_order, created_at, updated_at
              ) VALUES (
                ${cleanupId}, ${q.ticketTypeId}, ${q.kind}, ${q.prompt}, ${q.helpText},
                ${q.required}, ${options}, ${q.maxSelections}, ${q.consentText}, ${showIf},
                ${q.sortOrder}, ${now}, ${now}
              )
            `
          }
        }

        const rows = await tx<QuestionRowSelect[]>`
          SELECT ${questionColumns(tx)}
            FROM cleanup_questions
           WHERE cleanup_id = ${cleanupId} AND archived_at IS NULL
           ORDER BY sort_order, id
        `
        return rows.map(toQuestionRecord)
      })
    },

    async registerWalkupTx(args: WalkupRegisterArgs): Promise<RegisterTxOutcome> {
      let registerArgs: RegisterTxArgs | null = null
      try {
        return await sql.begin(async (tx) => {
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
          registerArgs = {
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
          const outcome = await registerIn(tx, registerArgs)
          if (outcome.kind === "registered") return outcome
          throw new RegistrationRefusal(outcome)
        })
      } catch (err) {
        if (registerArgs === null) throw err
        const mapped = await registerErrorOutcome(err, registerArgs)
        if (mapped !== null) return mapped
        throw err
      }
    },

    registerTx: runRegisterTx,

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
      if (query.filter === "waitlisted") {
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

      const statusFilter = (() => {
        switch (query.filter) {
          case "registered":
            return sql`AND r.status = 'registered'`
          case "cancelled":
            return sql`AND r.status = 'cancelled'`
          case "guests":
            return sql`AND r.status = 'registered' AND r.guest_id IS NOT NULL`
          case "members":
            return sql`AND r.status = 'registered' AND r.user_id IS NOT NULL`
          case "checked_in":
            return sql`AND r.status = 'registered' AND ci.first_at IS NOT NULL`
          case "not_checked_in":
            return sql`AND r.status = 'registered' AND ci.first_at IS NULL`
          case "no_show":
            return sql`AND r.status = 'registered' AND EXISTS (
              SELECT 1 FROM cleanup_registration_seats s
               WHERE s.registration_id = r.id AND s.no_show_at IS NOT NULL
            )`
          default:
            return sql``
        }
      })()

      const typeFilter =
        query.ticketTypeId === null ? sql`` : sql`AND r.ticket_type_id = ${query.ticketTypeId}`
      const slotFilter = query.slotId === null ? sql`` : sql`AND sc.slot_id = ${query.slotId}`
      const search =
        query.q === null || query.q.length === 0
          ? sql``
          : sql`AND (
              u.display_name ILIKE ${`%${query.q}%`}
              OR u.handle ILIKE ${`%${query.q}%`}
              OR g.name ILIKE ${`%${query.q}%`}
              OR EXISTS (
                SELECT 1 FROM cleanup_registration_seats s
                 WHERE s.registration_id = r.id AND s.attendee_name ILIKE ${`%${query.q}%`}
              )
            )`

      const cursorFilter = (() => {
        if (query.cursor === null) return sql``
        if (query.sort === "name_asc") {
          const cursor = parseNameCursor(query.cursor)
          if (cursor === null) return sql``
          return sql`AND (lower(COALESCE(u.display_name, g.name, '')), r.id) > (${cursor.name}, ${cursor.id}::uuid)`
        }
        const direction = query.sort === "registered_at_asc" ? "asc" : "desc"
        const cursor = parseTimeCursor(query.cursor, { direction })
        if (cursor === null) return sql``
        if (query.sort === "registered_at_asc") {
          return sql`AND (r.registered_at, r.id) > (${cursor.at}, ${cursor.id}::uuid)`
        }
        if (query.sort === "checked_in_at_desc") {
          return sql`AND (COALESCE(ci.first_at, 'epoch'::timestamptz), r.id) < (${cursor.at}, ${cursor.id}::uuid)`
        }
        return sql`AND (r.registered_at, r.id) < (${cursor.at}, ${cursor.id}::uuid)`
      })()

      const rows = await sql<RegistrationRowSelect[]>`
        SELECT ${registrationColumns(sql)}
          FROM cleanup_registrations r
          ${registrationJoins(sql)}
         WHERE r.cleanup_id = ${query.cleanupId}
           ${statusFilter}
           ${typeFilter}
           ${slotFilter}
           ${search}
           ${cursorFilter}
         ORDER BY ${ROSTER_SORTS[query.sort](sql)}
         LIMIT ${query.limit + 1}
      `

      const { items, nextCursor } = pageWith(rows, query.limit, (last) => {
        if (query.sort === "name_asc") {
          return encodeNameCursor({
            name: (last.person_display_name ?? last.guest_name ?? "").toLowerCase(),
            id: last.id,
          })
        }
        if (query.sort === "checked_in_at_desc") {
          return encodeTimeCursor({ at: last.checked_in_at ?? new Date(0), id: last.id })
        }
        return encodeTimeCursor({ at: last.registered_at, id: last.id })
      })

      const page: RosterPage = { rows: await hydrate(sql, items), nextCursor }
      if (query.withTotal) {
        const counted = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM cleanup_registrations
           WHERE cleanup_id = ${query.cleanupId} AND status = 'registered'
        `
        page.total = counted[0]?.n ?? 0
      }
      return page
    },

    async listAnswers(cleanupId: string, registrationId: string): Promise<AnswerRecord[]> {
      const rows = await sql<AnswerRowSelect[]>`
        SELECT a.question_id, q.prompt, a.value_text, a.value_json, a.scrubbed_at
          FROM cleanup_answers a
          JOIN cleanup_questions q ON q.id = a.question_id
         WHERE a.cleanup_id = ${cleanupId} AND a.registration_id = ${registrationId}
         ORDER BY q.sort_order, q.id
      `
      return rows.map(toAnswerRecord)
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

    async cancelRegistration(args: {
      cleanupId: string
      registrationId: string
      actorId: string | null
      now: Date
    }): Promise<CancelRegistrationOutcome> {
      const cancelled = await sql<{ id: string; ticket_type_id: string | null }[]>`
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
        const existing = await loadRegistrationById(sql, args.cleanupId, args.registrationId)
        return existing === null ? { kind: "not_found" } : { kind: "already_cancelled" }
      }
      const registration = await loadRegistrationById(sql, args.cleanupId, row.id)
      if (registration === null) return { kind: "not_found" }
      return { kind: "cancelled", registration, ticketTypeId: row.ticket_type_id }
    },

    async removeRegistration(args: {
      cleanupId: string
      registrationId: string
      actorId: string
      ban: boolean
      now: Date
    }): Promise<CancelRegistrationOutcome> {
      const outcome = await repo.cancelRegistration({
        cleanupId: args.cleanupId,
        registrationId: args.registrationId,
        actorId: args.actorId,
        now: args.now,
      })
      if (outcome.kind === "not_found") return outcome
      const registration =
        outcome.kind === "cancelled"
          ? outcome.registration
          : await loadRegistrationById(sql, args.cleanupId, args.registrationId)
      const targetUserId = registration?.userId ?? null
      if (args.ban && targetUserId !== null) {
        await sql`
          INSERT INTO cleanup_bans (cleanup_id, user_id, banned_by_user_id)
          VALUES (${args.cleanupId}, ${targetUserId}, ${args.actorId})
          ON CONFLICT (cleanup_id, user_id) DO NOTHING
        `
        await sql`
          DELETE FROM cleanup_members
           WHERE cleanup_id = ${args.cleanupId} AND user_id = ${targetUserId} AND role = 'member'
        `
      }
      return outcome
    },

    async transferRegistration(args: {
      cleanupId: string
      registrationId: string
      ticketTypeId: string
      now: Date
    }): Promise<TransferRegistrationOutcome> {
      return sql.begin(async (tx) => {
        const locked = await tx<
          { id: string; ticket_type_id: string | null; party_size: number; status: string }[]
        >`
          SELECT id, ticket_type_id, party_size, status
            FROM cleanup_registrations
           WHERE id = ${args.registrationId} AND cleanup_id = ${args.cleanupId}
           LIMIT 1 FOR UPDATE
        `
        const current = locked[0]
        if (current === undefined || current.status !== "registered") {
          return { kind: "not_found" as const }
        }
        if (current.ticket_type_id === args.ticketTypeId) return { kind: "same_type" as const }

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
        if (targetType === undefined) return { kind: "ticket_type_not_found" as const }
        if (current.party_size > targetType.max_party_size) {
          return { kind: "party_too_large" as const }
        }

        const reserved = await tx<{ id: string }[]>`
          UPDATE cleanup_ticket_types
             SET reserved_seats = reserved_seats + ${current.party_size}, updated_at = ${args.now}
           WHERE id = ${args.ticketTypeId}
             AND cleanup_id = ${args.cleanupId}
             AND (capacity IS NULL OR reserved_seats + ${current.party_size} <= capacity)
          RETURNING id
        `
        if (reserved.length === 0) return { kind: "full" as const }

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
        if (registration === null) return { kind: "not_found" as const }
        return { kind: "transferred" as const, registration }
      })
    },

    async joinWaitlist(args: {
      cleanupId: string
      ticketTypeId: string
      subject: RegistrationSubject
      partySize: number
      accessCodeHash: string | null
      now: Date
    }): Promise<JoinWaitlistOutcome> {
      try {
        return await sql.begin(async (tx) => {
          const locked = await tx<
            {
              status: EventRegistrationContext["status"]
              scheduled_at: Date
              ends_at: Date | null
              now: Date
            }[]
          >`
            SELECT status, scheduled_at, ends_at, now() AS now FROM cleanups
             WHERE id = ${args.cleanupId} LIMIT 1 FOR SHARE
          `
          const event = locked[0]
          if (event === undefined) return { kind: "not_found" as const }
          if (event.status === "cancelled") return { kind: "closed" as const }
          if (hasEventEnded(eventWindowOfRow(event), event.now.getTime())) {
            return { kind: "ended" as const }
          }

          const typeRows = await tx<
            {
              id: string
              waitlist_enabled: boolean
              visibility: TicketTypeRecord["visibility"]
              access_code_hash: string | null
            }[]
          >`
            SELECT id, waitlist_enabled, visibility, access_code_hash
              FROM cleanup_ticket_types
             WHERE id = ${args.ticketTypeId} AND cleanup_id = ${args.cleanupId}
             LIMIT 1
          `
          const type = typeRows[0]
          if (type === undefined) return { kind: "ticket_type_not_found" as const }
          if (!type.waitlist_enabled) return { kind: "waitlist_disabled" as const }
          if (type.visibility === "access_code") {
            if (args.accessCodeHash === null) return { kind: "access_code_required" as const }
            if (
              type.access_code_hash === null ||
              !constantTimeStringEqual(args.accessCodeHash, type.access_code_hash)
            ) {
              return { kind: "access_code_invalid" as const }
            }
          }

          const registered = await tx<{ id: string }[]>`
            SELECT id FROM cleanup_registrations
             WHERE cleanup_id = ${args.cleanupId}
               AND status = 'registered'
               AND ${
                 args.subject.kind === "user"
                   ? tx`user_id = ${args.subject.userId}`
                   : tx`guest_id = ${args.subject.guestId}`
               }
             LIMIT 1
          `
          if (registered.length > 0) return { kind: "already_registered" as const }

          const existing = await tx<{ id: string }[]>`
            SELECT id FROM cleanup_waitlist
             WHERE ticket_type_id = ${args.ticketTypeId}
               AND status IN ('waiting', 'offered')
               AND ${
                 args.subject.kind === "user"
                   ? tx`user_id = ${args.subject.userId}`
                   : tx`guest_id = ${args.subject.guestId}`
               }
             LIMIT 1
          `
          const existingId = existing[0]?.id
          if (existingId !== undefined) {
            const entry = await loadWaitlistEntry(tx, args.cleanupId, existingId)
            if (entry === null) return { kind: "not_found" as const }
            return { kind: "already_waiting" as const, entry }
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
          return { kind: "joined" as const, entry }
        })
      } catch (err) {
        if (
          isUniqueViolationOn(
            err,
            "cleanup_waitlist_active_user_uidx",
            "cleanup_waitlist_active_guest_uidx",
          )
        ) {
          const existing = await sql<{ id: string }[]>`
            SELECT id FROM cleanup_waitlist
             WHERE ticket_type_id = ${args.ticketTypeId}
               AND status IN ('waiting', 'offered')
               AND ${
                 args.subject.kind === "user"
                   ? sql`user_id = ${args.subject.userId}`
                   : sql`guest_id = ${args.subject.guestId}`
               }
             LIMIT 1
          `
          const existingId = existing[0]?.id
          const entry =
            existingId === undefined
              ? null
              : await loadWaitlistEntry(sql, args.cleanupId, existingId)
          if (entry === null) return { kind: "not_found" }
          return { kind: "already_waiting", entry }
        }
        throw err
      }
    },

    async leaveWaitlist(args: {
      cleanupId: string
      ticketTypeId: string | null
      subject: RegistrationSubject
      now: Date
    }): Promise<{ left: number; releasedTicketTypeIds: string[] }> {
      const typeFilter =
        args.ticketTypeId === null ? sql`` : sql`AND ticket_type_id = ${args.ticketTypeId}`
      const rows = await sql<{ id: string; released_ticket_type_id: string | null }[]>`
        WITH left_entries AS (
          UPDATE cleanup_waitlist
             SET status = 'cancelled'
           WHERE cleanup_id = ${args.cleanupId}
             AND status IN ('waiting', 'offered')
             ${typeFilter}
             AND ${
               args.subject.kind === "user"
                 ? sql`user_id = ${args.subject.userId}`
                 : sql`guest_id = ${args.subject.guestId}`
             }
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
            rows
              .map((row) => row.released_ticket_type_id)
              .filter((id): id is string => id !== null),
          ),
        ],
      }
    },

    async listWaitlist(args: {
      cleanupId: string
      ticketTypeId: string | null
      status: WaitlistRecord["status"] | null
      cursor: string | null
      limit: number
    }): Promise<{ rows: WaitlistRecord[]; nextCursor: string | null }> {
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
          SELECT id, cleanup_id, user_id, guest_id, party_size
            FROM cleanup_waitlist
           WHERE ticket_type_id = ${args.ticketTypeId} AND status = 'waiting'
           ORDER BY created_at, id
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        `
        const candidate = candidates[0]
        if (candidate === undefined) return null

        const reserved = await tx<{ id: string }[]>`
          UPDATE cleanup_ticket_types
             SET reserved_seats = reserved_seats + ${candidate.party_size}, updated_at = ${args.now}
           WHERE id = ${args.ticketTypeId}
             AND (capacity IS NULL OR reserved_seats + ${candidate.party_size} <= capacity)
          RETURNING id
        `
        if (reserved.length === 0) return null

        await tx`
          UPDATE cleanup_waitlist
             SET status = 'offered', offered_at = ${args.now}, claim_expires_at = ${expiresAt}
           WHERE id = ${candidate.id}
        `
        return {
          waitlistId: candidate.id,
          cleanupId: candidate.cleanup_id,
          ticketTypeId: args.ticketTypeId,
          userId: candidate.user_id,
          guestId: candidate.guest_id,
          partySize: candidate.party_size,
          claimExpiresAt: expiresAt,
        }
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
          SELECT id, ticket_type_id, user_id, guest_id, party_size
            FROM cleanup_waitlist
           WHERE id = ${args.waitlistId}
             AND cleanup_id = ${args.cleanupId}
             AND status = 'waiting'
           LIMIT 1
           FOR UPDATE
        `
        const candidate = rows[0]
        if (candidate === undefined) return null

        const reserved = await tx<{ id: string }[]>`
          UPDATE cleanup_ticket_types
             SET reserved_seats = reserved_seats + ${candidate.party_size}, updated_at = ${args.now}
           WHERE id = ${candidate.ticket_type_id}
             AND cleanup_id = ${args.cleanupId}
             AND (capacity IS NULL OR reserved_seats + ${candidate.party_size} <= capacity)
          RETURNING id
        `
        if (reserved.length === 0) return null

        await tx`
          UPDATE cleanup_waitlist
             SET status = 'offered', offered_at = ${args.now}, claim_expires_at = ${expiresAt}
           WHERE id = ${candidate.id}
        `
        return {
          waitlistId: candidate.id,
          cleanupId: args.cleanupId,
          ticketTypeId: candidate.ticket_type_id,
          userId: candidate.user_id,
          guestId: candidate.guest_id,
          partySize: candidate.party_size,
          claimExpiresAt: expiresAt,
        }
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

    async claimWaitlistOffer(args: {
      cleanupId: string
      waitlistId: string
      subject: RegistrationSubject | null
      seats: RegisterTxArgs["seats"]
      now: Date
    }): Promise<ClaimWaitlistOutcome> {
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
      const registerArgs: RegisterTxArgs = {
        cleanupId: args.cleanupId,
        subject,
        ticketTypeId: entry.ticketTypeId,
        seats: args.seats.slice(0, entry.partySize),
        accessCodeHash: null,
        answers: [],
        consent: null,
        slotId: null,
        source: "waitlist",
        idempotencyKey: `waitlist:${args.waitlistId}`,
        waitlistId: args.waitlistId,
        now: args.now,
      }

      try {
        return await sql.begin(async (tx) => {
          await tx`SELECT id FROM cleanups WHERE id = ${args.cleanupId} LIMIT 1 FOR SHARE`
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
            subject.kind === "user"
              ? row.user_id === subject.userId
              : row.guest_id === subject.guestId
          if (!owns) throw new ClaimRefusal({ kind: "not_found" })

          const outcome = await registerIn(tx, registerArgs)
          if (outcome.kind === "registered") {
            return { kind: "claimed" as const, registration: outcome.registration }
          }
          if (outcome.kind === "replayed" && outcome.registration !== null) {
            return { kind: "claimed" as const, registration: outcome.registration }
          }
          if (outcome.kind === "registration_closed" || outcome.kind === "closed") {
            await releaseWaitlistHold(tx, args.cleanupId, args.waitlistId, args.now)
            return { kind: "not_offered" as const }
          }
          throw new ClaimRefusal({ kind: "not_offered" })
        })
      } catch (err) {
        if (err instanceof ClaimRefusal) return err.outcome
        const mapped = await registerErrorOutcome(err, registerArgs)
        if (mapped === null) throw err
        if (mapped.kind === "replayed" && mapped.registration !== null) {
          return { kind: "claimed", registration: mapped.registration }
        }
        return { kind: "not_offered" }
      }
    },

    async checkInByToken(args: {
      cleanupId: string
      tokenHash: string
      actorId: string
      method: CheckinMethod
      now: Date
    }): Promise<CheckinResultRecord> {
      const updated = await sql<(SeatRowSelect & { first_time: boolean })[]>`
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
      if (row !== undefined) {
        return buildCheckinResult(
          row.first_time ? "checked_in" : "already",
          row.first_time,
          toSeatRecord(row),
          await loadRegistrationById(sql, args.cleanupId, row.registration_id),
        )
      }
      const probe = await sql<
        { cleanup_id: string; status: SeatRecord["status"]; no_show_at: Date | null }[]
      >`
        SELECT cleanup_id, status, no_show_at FROM cleanup_registration_seats
         WHERE ticket_token_hash = ${args.tokenHash}
         LIMIT 1
      `
      const seat = probe[0]
      if (seat === undefined) return emptyCheckinResult("unknown_token")
      if (seat.cleanup_id !== args.cleanupId) return emptyCheckinResult("wrong_event")
      if (seat.status === "cancelled") return emptyCheckinResult("cancelled")
      if (seat.no_show_at !== null) return emptyCheckinResult("no_show")
      return emptyCheckinResult("unknown_token")
    },

    async checkInSeat(args: {
      cleanupId: string
      seatId: string
      actorId: string
      method: CheckinMethod
      now: Date
    }): Promise<CheckinResultRecord> {
      const updated = await sql<(SeatRowSelect & { first_time: boolean })[]>`
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
      if (row === undefined) {
        const probe = await sql<{ status: SeatRecord["status"] }[]>`
          SELECT status FROM cleanup_registration_seats
           WHERE id = ${args.seatId} AND cleanup_id = ${args.cleanupId}
           LIMIT 1
        `
        const seat = probe[0]
        if (seat === undefined) return emptyCheckinResult("unknown_token")
        return emptyCheckinResult("cancelled")
      }
      return buildCheckinResult(
        row.first_time ? "checked_in" : "already",
        row.first_time,
        toSeatRecord(row),
        await loadRegistrationById(sql, args.cleanupId, row.registration_id),
      )
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
      const totals = await sql<
        {
          registered: number
          checked_in: number
          no_show: number
          waitlisted: number
          capacity: number | null
        }[]
      >`
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
      const byType = await sql<
        {
          ticket_type_id: string
          name: string
          registered: number
          checked_in: number
          waitlisted: number
          capacity: number | null
        }[]
      >`
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
               ), 0) AS waitlisted,
               t.capacity
          FROM cleanup_ticket_types t
         WHERE t.cleanup_id = ${cleanupId}
         ORDER BY t.sort_order, t.id
         LIMIT ${MAX_TICKET_TYPES}
      `
      const arrivals = await sql<{ at: Date; n: number }[]>`
        SELECT to_timestamp(
                 floor(extract(epoch FROM s.checked_in_at) / ${ARRIVAL_BUCKET_MINUTES * 60})
                 * ${ARRIVAL_BUCKET_MINUTES * 60}
               ) AS at,
               count(*)::int AS n
          FROM cleanup_registration_seats s
         WHERE s.cleanup_id = ${cleanupId} AND s.checked_in_at IS NOT NULL
         GROUP BY 1
         ORDER BY 1
         LIMIT 200
      `
      const row = totals[0]
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

    async getPage(cleanupId: string): Promise<PageRecord | null> {
      const rows = await sql<PageRowSelect[]>`
        SELECT c.id AS cleanup_id,
               c.page_slug AS slug,
               COALESCE(p.status, 'draft') AS status,
               COALESCE(p.theme_accent, 'bloom') AS theme_accent,
               p.blocks,
               p.seo,
               c.cover_media_id,
               m.r2_key AS cover_key,
               c.visibility,
               p.published_at,
               p.updated_at,
               p.flagged_at,
               p.flag_reason,
               COALESCE(p.view_count, 0) AS view_count
          FROM cleanups c
          LEFT JOIN cleanup_pages p ON p.cleanup_id = c.id
          LEFT JOIN media_assets m ON m.id = c.cover_media_id AND m.status = 'ready'
         WHERE c.id = ${cleanupId}
         LIMIT 1
      `
      const row = rows[0]
      return row === undefined ? null : toPageRecord(row)
    },

    async mediaKeysFor(
      cleanupId: string,
      mediaIds: readonly string[],
    ): Promise<Map<string, string>> {
      const out = new Map<string, string>()
      if (mediaIds.length === 0) return out
      const rows = await sql<{ id: string; r2_key: string }[]>`
        SELECT media_assets.id, media_assets.r2_key FROM media_assets
         WHERE media_assets.id = ANY(${[...new Set(mediaIds)]}::uuid[])
           AND media_assets.status = 'ready'
           AND (${mediaBoundToCleanup(sql, cleanupId)})
      `
      for (const row of rows) out.set(row.id, row.r2_key)
      return out
    },

    async savePage(args: SavePageArgs): Promise<SavePageOutcome> {
      try {
        return await sql.begin(async (tx) => {
          const locked = await tx<{ id: string }[]>`
            SELECT id FROM cleanups WHERE id = ${args.cleanupId} LIMIT 1 FOR SHARE
          `
          if (locked[0] === undefined) return { kind: "not_found" as const }

          const blockIds = [...new Set(args.blockMediaIds)]
          if (blockIds.length > 0) {
            const claimed = await claimPageMediaInTx(tx, args.cleanupId, blockIds, null)
            if (claimed.length !== blockIds.length) {
              return { kind: "block_media_not_found" as const }
            }
          }

          if (args.coverMediaId !== undefined) {
            if (args.coverMediaId !== null) {
              const claimed = await claimPageMediaInTx(
                tx,
                args.cleanupId,
                [args.coverMediaId],
                "event_cover",
              )
              if (claimed.length !== 1) return { kind: "cover_not_found" as const }
            }
            await tx`
              UPDATE cleanups SET cover_media_id = ${args.coverMediaId}
               WHERE id = ${args.cleanupId}
            `
          }

          await tx`
            DELETE FROM cleanup_page_media
             WHERE cleanup_id = ${args.cleanupId}
               AND NOT (media_id = ANY(${blockIds}::uuid[]))
          `
          if (blockIds.length > 0) {
            await tx`
              INSERT INTO cleanup_page_media (cleanup_id, media_id)
              SELECT ${args.cleanupId}::uuid, t.id FROM unnest(${blockIds}::uuid[]) AS t(id)
              ON CONFLICT (cleanup_id, media_id) DO NOTHING
            `
          }

          if (args.slug !== undefined) {
            await tx`
              UPDATE cleanups SET page_slug = ${args.slug} WHERE id = ${args.cleanupId}
            `
          }

          const blocks = tx.json(args.blocks as unknown as Parameters<typeof tx.json>[0])
          const seo =
            args.seo === undefined
              ? null
              : tx.json(args.seo as unknown as Parameters<typeof tx.json>[0])
          await tx`
            INSERT INTO cleanup_pages (
              cleanup_id, status, theme_accent, blocks, seo, created_at, updated_at
            ) VALUES (
              ${args.cleanupId}, 'draft', ${args.themeAccent ?? "bloom"}, ${blocks},
              COALESCE(${seo}, '{}'::jsonb), ${args.now}, ${args.now}
            )
            ON CONFLICT (cleanup_id) DO UPDATE SET
              theme_accent = COALESCE(${args.themeAccent ?? null}, cleanup_pages.theme_accent),
              blocks = EXCLUDED.blocks,
              seo = COALESCE(${seo}, cleanup_pages.seo),
              updated_at = ${args.now}
          `

          const record = await loadPage(tx, args.cleanupId)
          if (record === null) return { kind: "not_found" as const }
          return { kind: "saved" as const, record }
        })
      } catch (err) {
        if (isUniqueViolationOn(err, "cleanups_page_slug_uidx")) return { kind: "slug_taken" }
        throw err
      }
    },

    async publishPage(args: {
      cleanupId: string
      published: boolean
      actorId: string
      now: Date
    }): Promise<PageRecord | null> {
      const rows = await sql<{ cleanup_id: string }[]>`
        UPDATE cleanup_pages
           SET status = ${args.published ? "published" : "unpublished"},
               published_at = ${args.published ? args.now : sql`published_at`},
               published_by = ${args.published ? args.actorId : sql`published_by`},
               updated_at = ${args.now}
         WHERE cleanup_id = ${args.cleanupId}
        RETURNING cleanup_id
      `
      if (rows.length === 0) return null
      return loadPage(sql, args.cleanupId)
    },

    async slugTaken(cleanupId: string, slug: string): Promise<boolean> {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM cleanups
         WHERE page_slug = ${slug} AND id <> ${cleanupId}
         LIMIT 1
      `
      return rows.length > 0
    },

    async getPublicPage(slug: string): Promise<PublicPageRecord | null> {
      const rows = await sql<
        (PageRowSelect & { donation_url: string | null; logo_key: string | null })[]
      >`
        SELECT c.id AS cleanup_id,
               c.page_slug AS slug,
               COALESCE(p.status, 'draft') AS status,
               COALESCE(p.theme_accent, 'bloom') AS theme_accent,
               p.blocks,
               p.seo,
               c.cover_media_id,
               m.r2_key AS cover_key,
               c.visibility,
               p.published_at,
               p.updated_at,
               p.flagged_at,
               p.flag_reason,
               COALESCE(p.view_count, 0) AS view_count,
               c.donation_url,
               lm.r2_key AS logo_key
          FROM cleanups c
          LEFT JOIN cleanup_pages p ON p.cleanup_id = c.id
          LEFT JOIN media_assets m ON m.id = c.cover_media_id AND m.status = 'ready'
          LEFT JOIN organizations o ON o.id = c.organization_id AND o.deleted_at IS NULL
          LEFT JOIN media_assets lm ON lm.id = o.logo_media_id AND lm.status = 'ready'
         WHERE c.page_slug = ${slug}
         LIMIT 1
      `
      const row = rows[0]
      if (row === undefined) return null
      const event = await eventContextIn(sql, row.cleanup_id)
      if (event === null) return null
      return {
        page: toPageRecord(row),
        event,
        ticketTypes: await loadTicketTypes(sql, [row.cleanup_id]),
        questions: (
          await sql<QuestionRowSelect[]>`
            SELECT ${questionColumns(sql)}
              FROM cleanup_questions
             WHERE cleanup_id = ${row.cleanup_id} AND archived_at IS NULL
             ORDER BY sort_order, id
          `
        ).map(toQuestionRecord),
        organizationId: event.organizationId,
        donationUrl: row.donation_url,
        logoKey: row.logo_key,
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

  return repo
}
