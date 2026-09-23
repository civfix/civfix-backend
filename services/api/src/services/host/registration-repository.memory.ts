import { randomUUID } from "node:crypto"
import type { CheckinMethod } from "@civfix/shared"
import {
  encodeTimeCursor,
  pageBeforeTimeCursor,
  pageWith,
  parseTimeCursor,
} from "../../db/cursor-helpers.js"
import {
  DEFAULT_EVENT_DURATION_MS,
  eventEndsAtMs,
  eventWindowOf,
  hasEventEnded,
} from "../cleanup-rules.js"
import { LIVE_TAIL_MS } from "@civfix/shared/host"
import {
  ARRIVAL_BUCKET_MINUTES,
  buildCheckinResult,
  emptyCheckinResult,
} from "./registration-checkin.drizzle.js"
import {
  guestSelfRegistrationOnPrivateEvent,
  subjectOwner,
  withinSalesWindow,
} from "./registration-register.drizzle.js"
import type { AppliedBan } from "./registration-roster.drizzle.js"
import { MAX_TICKET_TYPES } from "./registration-ticket-types.drizzle.js"
import { waitlistEntryAsRegistration } from "./registration-waitlist.drizzle.js"
import type {
  AnswerRecord,
  CancelRegistrationOutcome,
  RemoveRegistrationOutcome,
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
  PublishPageOutcome,
  QuestionRecord,
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
  TicketTypeRecord,
  TicketTypeWriteArgs,
  TransferRegistrationOutcome,
  UpdateTicketTypeOutcome,
  WalkupRegisterArgs,
  WaitlistOffer,
  WaitlistRecord,
} from "./registration-repository.types.js"

interface MemoryRegistration extends RegistrationRecord {
  answers: AnswerRecord[]
}

interface MemoryGuest {
  id: string
  cleanupId: string
  name: string
}

const ARRIVAL_BUCKET_MS = ARRIVAL_BUCKET_MINUTES * 60_000

const SEEDED_EVENT_LEAD_MS = 7 * 24 * 60 * 60 * 1000

function arrivalBuckets(
  seats: readonly { checkedInAt: Date | null }[],
): { at: Date; count: number }[] {
  const byBucket = new Map<number, number>()
  for (const seat of seats) {
    if (seat.checkedInAt === null) continue
    const at = Math.floor(seat.checkedInAt.getTime() / ARRIVAL_BUCKET_MS) * ARRIVAL_BUCKET_MS
    byBucket.set(at, (byBucket.get(at) ?? 0) + 1)
  }
  return [...byBucket]
    .sort((a, b) => a[0] - b[0])
    .map(([at, count]) => ({ at: new Date(at), count }))
}

function subjectMatches(
  record: { userId: string | null; guestId: string | null },
  subject: RegistrationSubject,
): boolean {
  return subject.kind === "user"
    ? record.userId === subject.userId
    : record.guestId === subject.guestId
}

export class InMemoryHostRegistrationRepository implements HostRegistrationRepository {
  readonly events = new Map<string, EventRegistrationContext>()
  readonly ticketTypes = new Map<string, TicketTypeRecord>()
  readonly questions = new Map<string, QuestionRecord>()
  readonly registrations = new Map<string, MemoryRegistration>()
  readonly waitlist = new Map<string, WaitlistRecord>()
  readonly pages = new Map<string, PageRecord>()
  readonly guests = new Map<string, MemoryGuest>()
  readonly bans = new Set<string>()
  readonly members = new Set<string>()
  readonly idempotency = new Map<string, string>()

  constructor(private readonly newId: () => string = () => randomUUID()) {}

  seedEvent(
    partial: Partial<EventRegistrationContext> & { cleanupId: string },
  ): EventRegistrationContext {
    const event: EventRegistrationContext = {
      status: "upcoming",
      visibility: "public",
      capacity: null,
      title: "Test event",
      description: null,
      referenceCode: null,
      lat: 34,
      lng: -118,
      scheduledAt: new Date(Date.now() + SEEDED_EVENT_LEAD_MS),
      endsAt: new Date(Date.now() + SEEDED_EVENT_LEAD_MS + DEFAULT_EVENT_DURATION_MS),
      timezone: null,
      address: null,
      registrationOpensAt: null,
      registrationClosesAt: null,
      pageSlug: null,
      organizerUserId: "00000000-0000-0000-0000-0000000000aa",
      organizationId: null,
      ...partial,
    }
    this.events.set(event.cleanupId, event)
    return event
  }

  seedTicketType(partial: Partial<TicketTypeRecord> & { cleanupId: string }): TicketTypeRecord {
    const record: TicketTypeRecord = {
      id: this.newId(),
      name: "General",
      description: null,
      capacity: null,
      reservedSeats: 0,
      sold: 0,
      salesOpensAt: null,
      salesClosesAt: null,
      visibility: "public",
      accessCodeSet: false,
      maxPartySize: 4,
      sortOrder: this.ticketTypes.size,
      waitlistEnabled: false,
      questionIds: [],
      ...partial,
    }
    this.ticketTypes.set(record.id, record)
    return record
  }

  private accessCodeHashes = new Map<string, string>()

  setAccessCode(ticketTypeId: string, hash: string | null): void {
    const record = this.ticketTypes.get(ticketTypeId)
    if (record === undefined) return
    if (hash === null) {
      this.accessCodeHashes.delete(ticketTypeId)
      record.accessCodeSet = false
      return
    }
    this.accessCodeHashes.set(ticketTypeId, hash)
    record.accessCodeSet = true
  }

  private typesOf(cleanupId: string): TicketTypeRecord[] {
    return [...this.ticketTypes.values()]
      .filter((t) => t.cleanupId === cleanupId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
  }

  private recomputeSold(ticketTypeId: string): void {
    const type = this.ticketTypes.get(ticketTypeId)
    if (type === undefined) return
    type.sold = [...this.registrations.values()]
      .filter((r) => r.ticketTypeId === ticketTypeId && r.status === "registered")
      .reduce((sum, r) => sum + r.partySize, 0)
  }

  async eventContext(cleanupId: string): Promise<EventRegistrationContext | null> {
    return this.events.get(cleanupId) ?? null
  }

  async listTicketTypes(cleanupId: string): Promise<TicketTypeRecord[]> {
    return this.typesOf(cleanupId).map((t) => ({ ...t }))
  }

  async listTicketTypesFor(
    cleanupIds: readonly string[],
  ): Promise<Map<string, TicketTypeRecord[]>> {
    const out = new Map<string, TicketTypeRecord[]>()
    for (const id of cleanupIds) out.set(id, await this.listTicketTypes(id))
    return out
  }

  async ticketTypeIdsMatchingAccessCode(
    cleanupId: string,
    accessCodeHash: string,
  ): Promise<string[]> {
    return this.typesOf(cleanupId)
      .filter(
        (type) =>
          type.visibility === "access_code" &&
          this.accessCodeHashes.get(type.id) === accessCodeHash,
      )
      .map((type) => type.id)
  }

  async getTicketType(cleanupId: string, ticketTypeId: string): Promise<TicketTypeRecord | null> {
    const record = this.ticketTypes.get(ticketTypeId)
    if (record === undefined || record.cleanupId !== cleanupId) return null
    return { ...record }
  }

  private capacityFit(
    cleanupId: string,
    nextCapacity: number | null,
    excludeTicketTypeId: string | null,
  ): { ok: true } | { ok: false; eventCapacity: number; used: number } {
    const eventCapacity = this.events.get(cleanupId)?.capacity ?? null
    if (eventCapacity == null) return { ok: true }
    const siblings = this.typesOf(cleanupId).filter((t) => t.id !== excludeTicketTypeId)
    const used = siblings.reduce((sum, t) => sum + (t.capacity ?? 0), 0)
    if (siblings.some((t) => t.capacity === null)) return { ok: false, eventCapacity, used }
    if (nextCapacity === null) return { ok: false, eventCapacity, used }
    if (used + nextCapacity > eventCapacity) return { ok: false, eventCapacity, used }
    return { ok: true }
  }

  async createTicketType(args: TicketTypeWriteArgs): Promise<CreateTicketTypeOutcome> {
    if (!this.events.has(args.cleanupId)) return { kind: "not_found" }
    const siblings = this.typesOf(args.cleanupId)
    if (siblings.length >= MAX_TICKET_TYPES) return { kind: "too_many" }
    if (siblings.some((t) => t.name.toLowerCase() === args.name.toLowerCase())) {
      return { kind: "name_taken" }
    }
    if (
      args.salesOpensAt !== null &&
      args.salesClosesAt !== null &&
      args.salesClosesAt <= args.salesOpensAt
    ) {
      return { kind: "sales_window" }
    }
    const fit = this.capacityFit(args.cleanupId, args.capacity, null)
    if (!fit.ok) {
      return { kind: "capacity_exceeded", eventCapacity: fit.eventCapacity, used: fit.used }
    }
    const record = this.seedTicketType({
      cleanupId: args.cleanupId,
      name: args.name,
      description: args.description,
      capacity: args.capacity,
      salesOpensAt: args.salesOpensAt,
      salesClosesAt: args.salesClosesAt,
      visibility: args.visibility,
      accessCodeSet: args.accessCodeHash !== null,
      maxPartySize: args.maxPartySize,
      sortOrder: args.sortOrder ?? siblings.length,
      waitlistEnabled: args.waitlistEnabled,
      questionIds: args.questionIds ?? [],
    })
    if (args.accessCodeHash !== null) this.accessCodeHashes.set(record.id, args.accessCodeHash)
    return { kind: "created", record: { ...record } }
  }

  async updateTicketType(
    args: TicketTypeWriteArgs & { ticketTypeId: string; patch: readonly string[] },
  ): Promise<UpdateTicketTypeOutcome> {
    const record = this.ticketTypes.get(args.ticketTypeId)
    if (record === undefined || record.cleanupId !== args.cleanupId) return { kind: "not_found" }
    const patch = new Set(args.patch)
    if (patch.has("capacity") && args.capacity !== null && args.capacity < record.reservedSeats) {
      return { kind: "capacity_below_reserved", reservedSeats: record.reservedSeats }
    }
    if (patch.has("capacity")) {
      const fit = this.capacityFit(args.cleanupId, args.capacity, record.id)
      if (!fit.ok) {
        return { kind: "capacity_exceeded", eventCapacity: fit.eventCapacity, used: fit.used }
      }
    }
    const nextOpens = patch.has("salesOpensAt") ? args.salesOpensAt : record.salesOpensAt
    const nextCloses = patch.has("salesClosesAt") ? args.salesClosesAt : record.salesClosesAt
    if (nextOpens !== null && nextCloses !== null && nextCloses <= nextOpens) {
      return { kind: "sales_window" }
    }
    if (
      patch.has("name") &&
      this.typesOf(args.cleanupId).some(
        (t) => t.id !== record.id && t.name.toLowerCase() === args.name.toLowerCase(),
      )
    ) {
      return { kind: "name_taken" }
    }
    if (patch.has("name")) record.name = args.name
    if (patch.has("description")) record.description = args.description
    if (patch.has("capacity")) record.capacity = args.capacity
    if (patch.has("salesOpensAt")) record.salesOpensAt = args.salesOpensAt
    if (patch.has("salesClosesAt")) record.salesClosesAt = args.salesClosesAt
    if (patch.has("visibility")) record.visibility = args.visibility
    if (patch.has("maxPartySize")) record.maxPartySize = args.maxPartySize
    if (patch.has("waitlistEnabled")) record.waitlistEnabled = args.waitlistEnabled
    if (patch.has("sortOrder") && args.sortOrder !== null) record.sortOrder = args.sortOrder
    if (args.clearAccessCode) this.setAccessCode(record.id, null)
    else if (args.accessCodeHash !== null) this.setAccessCode(record.id, args.accessCodeHash)
    if (args.questionIds !== null) record.questionIds = [...args.questionIds]
    return { kind: "updated", record: { ...record } }
  }

  async deleteTicketType(
    cleanupId: string,
    ticketTypeId: string,
  ): Promise<DeleteTicketTypeOutcome> {
    const record = this.ticketTypes.get(ticketTypeId)
    if (record === undefined || record.cleanupId !== cleanupId) return { kind: "not_found" }
    const referenced =
      [...this.registrations.values()].some((r) => r.ticketTypeId === ticketTypeId) ||
      [...this.waitlist.values()].some((w) => w.ticketTypeId === ticketTypeId)
    if (referenced) return { kind: "in_use" }
    this.ticketTypes.delete(ticketTypeId)
    return { kind: "deleted" }
  }

  async reorderTicketTypes(
    cleanupId: string,
    ticketTypeIds: readonly string[],
  ): Promise<ReorderTicketTypesOutcome> {
    const have = this.typesOf(cleanupId).map((t) => t.id)
    const want = new Set(ticketTypeIds)
    if (have.length !== want.size || have.some((id) => !want.has(id))) return { kind: "mismatch" }
    ticketTypeIds.forEach((id, index) => {
      const record = this.ticketTypes.get(id)
      if (record !== undefined) record.sortOrder = index
    })
    return { kind: "reordered", items: await this.listTicketTypes(cleanupId) }
  }

  async listQuestions(
    cleanupId: string,
    opts?: { ticketTypeId?: string | null; includeArchived?: boolean },
  ): Promise<QuestionRecord[]> {
    return [...this.questions.values()]
      .filter((q) => q.cleanupId === cleanupId)
      .filter((q) => opts?.includeArchived === true || q.archivedAt === null)
      .filter((q) => {
        if (opts === undefined || !("ticketTypeId" in opts)) return true
        const wanted = opts.ticketTypeId ?? null
        return wanted === null
          ? q.ticketTypeId === null
          : q.ticketTypeId === null || q.ticketTypeId === wanted
      })
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
      .map((q) => ({ ...q }))
  }

  async reconcileQuestions(
    cleanupId: string,
    desired: readonly DesiredQuestion[],
    now: Date,
  ): Promise<QuestionRecord[]> {
    const keep = new Set(desired.map((q) => q.id).filter((id): id is string => id !== null))
    for (const question of this.questions.values()) {
      if (question.cleanupId === cleanupId && !keep.has(question.id)) question.archivedAt = now
    }
    for (const q of desired) {
      const id = q.id ?? this.newId()
      this.questions.set(id, {
        id,
        cleanupId,
        ticketTypeId: q.ticketTypeId,
        kind: q.kind,
        prompt: q.prompt,
        helpText: q.helpText,
        required: q.required,
        options: q.options,
        maxSelections: q.maxSelections,
        consentText: q.consentText,
        showIf: q.showIf,
        sortOrder: q.sortOrder,
        archivedAt: null,
      })
    }
    return this.listQuestions(cleanupId)
  }

  async registerWalkupTx(args: WalkupRegisterArgs): Promise<RegisterTxOutcome> {
    const guestId = this.newId()
    this.guests.set(guestId, { id: guestId, cleanupId: args.cleanupId, name: args.name })
    const outcome = await this.registerTx({
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
    })
    if (outcome.kind !== "registered") {
      this.guests.delete(guestId)
      return outcome
    }
    const checkIn = args.checkIn
    if (checkIn === undefined || checkIn === null) return outcome
    const registration = this.registrations.get(outcome.registration.id)
    if (registration === undefined) return outcome
    for (const seat of registration.seats) {
      if (seat.status !== "active" || seat.checkedInAt !== null) continue
      seat.checkedInAt = args.now
      seat.checkedInBy = checkIn.actorId
      seat.checkinMethod = checkIn.method
    }
    return { kind: "registered", registration: this.toRecord(registration) }
  }

  ensureSignupRegistration(args: {
    cleanupId: string
    userId: string
    seatId: string
    now: Date
  }): RegistrationRecord | null {
    if ([...this.ticketTypes.values()].some((t) => t.cleanupId === args.cleanupId)) return null
    const active = [...this.registrations.values()].find(
      (r) =>
        r.cleanupId === args.cleanupId && r.status === "registered" && r.userId === args.userId,
    )
    if (active !== undefined) return null
    const id = this.newId()
    const registration: MemoryRegistration = {
      id,
      cleanupId: args.cleanupId,
      ticketTypeId: null,
      ticketTypeName: null,
      userId: args.userId,
      guestId: null,
      guestName: null,
      identity: {
        userId: args.userId,
        displayName: "Member",
        handle: null,
        bio: null,
        avatarUrl: null,
        deletedAt: null,
      },
      partySize: 1,
      status: "registered",
      source: "self",
      hostNote: null,
      registeredAt: args.now,
      cancelledAt: null,
      checkedInAt: null,
      slotId: null,
      slotTitle: null,
      seats: [
        {
          id: args.seatId,
          registrationId: id,
          seatIndex: 0,
          attendeeName: null,
          status: "active",
          checkedInAt: null,
          checkedInBy: null,
          checkinMethod: null,
          checkinCoarsenedAt: null,
          noShowAt: null,
        },
      ],
      answersPreview: null,
      answers: [],
    }
    this.registrations.set(id, registration)
    this.members.add(`${args.cleanupId}:${args.userId}`)
    return this.toRecord(registration)
  }

  cancelSignupRegistration(args: { cleanupId: string; userId: string; now: Date }): boolean {
    const active = [...this.registrations.values()].find(
      (r) =>
        r.cleanupId === args.cleanupId &&
        r.status === "registered" &&
        r.userId === args.userId &&
        r.ticketTypeId === null,
    )
    if (active === undefined) return false
    active.status = "cancelled"
    active.cancelledAt = args.now
    for (const seat of active.seats) seat.status = "cancelled"
    return true
  }

  private toRecord(registration: MemoryRegistration): RegistrationRecord {
    const type =
      registration.ticketTypeId === null ? null : this.ticketTypes.get(registration.ticketTypeId)
    return {
      ...registration,
      ticketTypeName: type?.name ?? null,
      seats: registration.seats.map((seat) => ({ ...seat })),
      checkedInAt:
        registration.seats
          .filter((seat) => seat.checkedInAt !== null)
          .map((seat) => seat.checkedInAt as Date)
          .sort((a, b) => a.getTime() - b.getTime())[0] ?? null,
    }
  }

  private replayOf(registrationId: string): RegisterTxOutcome {
    const existing = this.registrations.get(registrationId)
    return {
      kind: "replayed",
      registration: existing === undefined ? null : this.toRecord(existing),
    }
  }

  private eventRefusal(
    args: RegisterTxArgs,
    event: EventRegistrationContext,
  ): RegisterTxOutcome | null {
    if (event.status === "cancelled") return { kind: "closed" }
    if (!withinSalesWindow(args.now, event.registrationOpensAt, event.registrationClosesAt)) {
      return { kind: "registration_closed" }
    }
    if (args.subject.kind === "user" && this.isBanned(args.cleanupId, args.subject.userId)) {
      return { kind: "banned" }
    }
    const active = [...this.registrations.values()].find(
      (r) =>
        r.cleanupId === args.cleanupId &&
        r.status === "registered" &&
        subjectMatches(r, args.subject),
    )
    return active === undefined ? null : { kind: "already_registered" }
  }

  private pickTicketType(
    args: RegisterTxArgs,
  ): { refusal: RegisterTxOutcome } | { type: TicketTypeRecord | null } {
    const types = this.typesOf(args.cleanupId)
    let type: TicketTypeRecord | null = null
    if (args.ticketTypeId !== null) {
      type = types.find((t) => t.id === args.ticketTypeId) ?? null
      if (type === null) return { refusal: { kind: "ticket_type_not_found" } }
    } else if (types.length === 1) {
      type = types[0] ?? null
    } else if (types.length > 1) {
      return { refusal: { kind: "ticket_type_not_found" } }
    }
    if (type !== null && type.visibility === "hidden" && args.source === "self") {
      return { refusal: { kind: "ticket_type_not_found" } }
    }
    return { type }
  }

  private ticketTypeRefusal(
    args: RegisterTxArgs,
    type: TicketTypeRecord,
    partySize: number,
  ): RegisterTxOutcome | null {
    if (type.visibility === "access_code" && args.waitlistId === null) {
      const expected = this.accessCodeHashes.get(type.id) ?? null
      if (args.accessCodeHash === null) return { kind: "access_code_required" }
      if (args.accessCodeHash !== expected) return { kind: "access_code_invalid" }
    }
    if (partySize > type.maxPartySize) return { kind: "party_too_large" }
    if (args.waitlistId !== null) return null
    if (!withinSalesWindow(args.now, type.salesOpensAt, type.salesClosesAt)) {
      return { kind: "sales_closed" }
    }
    if (type.capacity !== null && type.reservedSeats + partySize > type.capacity) {
      return { kind: "full" }
    }
    return null
  }

  private eventCapacityRefusal(
    args: RegisterTxArgs,
    event: EventRegistrationContext,
    partySize: number,
  ): RegisterTxOutcome | null {
    if (event.capacity == null || args.waitlistId !== null) return null
    const held = [...this.registrations.values()]
      .filter((r) => r.cleanupId === args.cleanupId && r.status === "registered")
      .reduce((sum, r) => sum + r.partySize, 0)
    return held + partySize > event.capacity ? { kind: "full" } : null
  }

  private newRegistration(
    args: RegisterTxArgs,
    id: string,
    type: TicketTypeRecord | null,
  ): MemoryRegistration {
    const seats: SeatRecord[] = args.seats.map((seat, index) => ({
      id: seat.id,
      registrationId: id,
      seatIndex: index,
      attendeeName: seat.attendeeName,
      status: "active",
      checkedInAt: null,
      checkedInBy: null,
      checkinMethod: null,
      checkinCoarsenedAt: null,
      noShowAt: null,
    }))
    const guest = args.subject.kind === "guest" ? this.guests.get(args.subject.guestId) : undefined
    return {
      id,
      cleanupId: args.cleanupId,
      ticketTypeId: type?.id ?? null,
      ticketTypeName: type?.name ?? null,
      userId: args.subject.kind === "user" ? args.subject.userId : null,
      guestId: args.subject.kind === "guest" ? args.subject.guestId : null,
      guestName: guest?.name ?? null,
      identity:
        args.subject.kind === "user"
          ? {
              userId: args.subject.userId,
              displayName: "Member",
              handle: null,
              bio: null,
              avatarUrl: null,
              deletedAt: null,
            }
          : null,
      partySize: args.seats.length,
      status: "registered",
      source: args.source,
      hostNote: null,
      registeredAt: args.now,
      cancelledAt: null,
      checkedInAt: null,
      slotId: args.slotId,
      slotTitle: null,
      seats,
      answersPreview:
        args.answers
          .map((a) => a.valueText)
          .filter((v) => v !== null)
          .join(" | ") || null,
      answers: args.answers.map((a) => ({
        questionId: a.questionId,
        prompt: this.questions.get(a.questionId)?.prompt ?? "",
        valueText: a.valueText,
        valueJson: a.valueJson,
        scrubbedAt: null,
      })),
    }
  }

  async registerTx(args: RegisterTxArgs): Promise<RegisterTxOutcome> {
    const event = this.events.get(args.cleanupId)
    if (event === undefined) return { kind: "not_found" }
    if (guestSelfRegistrationOnPrivateEvent(args, event.visibility)) return { kind: "not_found" }

    const owner = args.idempotencyOwner ?? subjectOwner(args.subject)
    const idempotencyKey = `${owner}:${args.idempotencyKey}`
    const replayed = this.idempotency.get(idempotencyKey)
    if (replayed !== undefined) return this.replayOf(replayed)

    const eventRefusal = this.eventRefusal(args, event)
    if (eventRefusal !== null) return eventRefusal

    const picked = this.pickTicketType(args)
    if ("refusal" in picked) return picked.refusal
    const { type } = picked
    const partySize = args.seats.length
    const refusal =
      type === null
        ? this.eventCapacityRefusal(args, event, partySize)
        : this.ticketTypeRefusal(args, type, partySize)
    if (refusal !== null) return refusal

    if (args.subject.kind === "user") this.members.add(`${args.cleanupId}:${args.subject.userId}`)
    if (type !== null && args.waitlistId === null) type.reservedSeats += partySize

    const registration = this.newRegistration(args, this.newId(), type)
    this.registrations.set(registration.id, registration)
    this.idempotency.set(idempotencyKey, registration.id)
    if (type !== null) this.recomputeSold(type.id)

    return { kind: "registered", registration: this.toRecord(registration) }
  }

  async findRegistration(
    cleanupId: string,
    registrationId: string,
  ): Promise<RegistrationRecord | null> {
    const record = this.registrations.get(registrationId)
    if (record === undefined || record.cleanupId !== cleanupId) return null
    return this.toRecord(record)
  }

  async findMyRegistration(
    cleanupId: string,
    subject: RegistrationSubject,
  ): Promise<RegistrationRecord | null> {
    const record = [...this.registrations.values()]
      .filter((r) => r.cleanupId === cleanupId && subjectMatches(r, subject))
      .sort((a, b) => Number(b.status === "registered") - Number(a.status === "registered"))[0]
    return record === undefined ? null : this.toRecord(record)
  }

  async findRegistrationsFor(
    cleanupIds: readonly string[],
    userId: string,
  ): Promise<Map<string, RegistrationRecord>> {
    const out = new Map<string, RegistrationRecord>()
    for (const record of this.registrations.values()) {
      if (record.userId !== userId || record.status !== "registered") continue
      if (!cleanupIds.includes(record.cleanupId)) continue
      out.set(record.cleanupId, this.toRecord(record))
    }
    return out
  }

  async listRoster(query: RosterQuery): Promise<RosterPage> {
    if (query.filter === "waitlisted") {
      const page = await this.listWaitlist({
        cleanupId: query.cleanupId,
        ticketTypeId: query.ticketTypeId,
        status: null,
        cursor: query.cursor,
        limit: query.limit,
      })
      return { rows: page.rows.map(waitlistEntryAsRegistration), nextCursor: page.nextCursor }
    }
    let rows = [...this.registrations.values()].filter((r) => r.cleanupId === query.cleanupId)
    switch (query.filter) {
      case "registered":
        rows = rows.filter((r) => r.status === "registered")
        break
      case "cancelled":
        rows = rows.filter((r) => r.status === "cancelled")
        break
      case "guests":
        rows = rows.filter((r) => r.status === "registered" && r.guestId !== null)
        break
      case "members":
        rows = rows.filter((r) => r.status === "registered" && r.userId !== null)
        break
      case "checked_in":
        rows = rows.filter((r) => r.seats.some((s) => s.checkedInAt !== null))
        break
      case "not_checked_in":
        rows = rows.filter(
          (r) => r.status === "registered" && r.seats.every((s) => s.checkedInAt === null),
        )
        break
      case "no_show":
        rows = rows.filter((r) => r.seats.some((s) => s.noShowAt !== null))
        break
      default:
        break
    }
    if (query.ticketTypeId !== null)
      rows = rows.filter((r) => r.ticketTypeId === query.ticketTypeId)
    rows.sort(
      (a, b) => b.registeredAt.getTime() - a.registeredAt.getTime() || b.id.localeCompare(a.id),
    )
    const cursor = parseTimeCursor(query.cursor, { direction: "desc" })
    const page = pageBeforeTimeCursor(rows, cursor, query.limit, (r) => ({
      at: r.registeredAt,
      id: r.id,
    }))
    const out: RosterPage = {
      rows: page.items.map((r) => this.toRecord(r)),
      nextCursor: page.nextCursor,
    }
    if (query.withTotal) {
      out.total = [...this.registrations.values()].filter(
        (r) => r.cleanupId === query.cleanupId && r.status === "registered",
      ).length
    }
    return out
  }

  async listAnswers(cleanupId: string, registrationId: string): Promise<AnswerRecord[]> {
    const record = this.registrations.get(registrationId)
    if (record === undefined || record.cleanupId !== cleanupId) return []
    return record.answers.map((a) => ({ ...a }))
  }

  async setHostNote(
    cleanupId: string,
    registrationId: string,
    note: string | null,
  ): Promise<boolean> {
    const record = this.registrations.get(registrationId)
    if (record === undefined || record.cleanupId !== cleanupId) return false
    record.hostNote = note
    return true
  }

  async cancelRegistration(args: {
    cleanupId: string
    registrationId: string
    actorId: string | null
    now: Date
  }): Promise<CancelRegistrationOutcome> {
    const record = this.registrations.get(args.registrationId)
    if (record === undefined || record.cleanupId !== args.cleanupId) return { kind: "not_found" }
    if (record.status !== "registered") return { kind: "already_cancelled" }
    record.status = "cancelled"
    record.cancelledAt = args.now
    for (const seat of record.seats) seat.status = "cancelled"
    if (record.ticketTypeId !== null) {
      const type = this.ticketTypes.get(record.ticketTypeId)
      if (type !== undefined) {
        type.reservedSeats = Math.max(type.reservedSeats - record.partySize, 0)
        this.recomputeSold(type.id)
      }
    }
    return {
      kind: "cancelled",
      registration: this.toRecord(record),
      ticketTypeId: record.ticketTypeId,
    }
  }

  async removeRegistration(args: {
    cleanupId: string
    registrationId: string
    actorId: string
    ban: boolean
    now: Date
  }): Promise<RemoveRegistrationOutcome> {
    const record = this.registrations.get(args.registrationId)
    if (record === undefined || record.cleanupId !== args.cleanupId) {
      return { kind: "not_found", releasedWaitlistTicketTypeIds: [] }
    }
    if (!args.ban || record.userId === null) {
      const outcome = await this.cancelRegistration(args)
      return { ...outcome, releasedWaitlistTicketTypeIds: [] }
    }
    const ban = this.applyBan({
      cleanupId: args.cleanupId,
      userId: record.userId,
      actorId: args.actorId,
      now: args.now,
    })
    const removed = ban.cancelledRegistrations.find((r) => r.id === record.id)
    if (removed === undefined) {
      const outcome = await this.cancelRegistration(args)
      return { ...outcome, releasedWaitlistTicketTypeIds: ban.releasedTicketTypeIds }
    }
    return {
      kind: "cancelled",
      registration: this.toRecord(record),
      ticketTypeId: removed.ticketTypeId,
      releasedWaitlistTicketTypeIds: ban.releasedTicketTypeIds,
    }
  }

  applyBan(args: { cleanupId: string; userId: string; actorId: string; now: Date }): AppliedBan {
    this.bans.add(`${args.cleanupId}:${args.userId}`)
    this.members.delete(`${args.cleanupId}:${args.userId}`)
    const waitlist = this.cancelWaitlistEntries({
      cleanupId: args.cleanupId,
      ticketTypeId: null,
      subject: { kind: "user", userId: args.userId },
    })
    const cancelled: AppliedBan["cancelledRegistrations"] = []
    for (const record of this.registrations.values()) {
      if (
        record.cleanupId !== args.cleanupId ||
        record.userId !== args.userId ||
        record.status !== "registered"
      ) {
        continue
      }
      record.status = "cancelled"
      record.cancelledAt = args.now
      for (const seat of record.seats) seat.status = "cancelled"
      const type =
        record.ticketTypeId === null ? undefined : this.ticketTypes.get(record.ticketTypeId)
      if (type !== undefined) {
        type.reservedSeats = Math.max(type.reservedSeats - record.partySize, 0)
        this.recomputeSold(type.id)
      }
      cancelled.push({ id: record.id, ticketTypeId: record.ticketTypeId })
    }
    const registrationTypes = cancelled
      .map((r) => r.ticketTypeId)
      .filter((id): id is string => id !== null)
    return {
      cancelledRegistrations: cancelled,
      releasedTicketTypeIds: [
        ...new Set([...waitlist.releasedTicketTypeIds, ...registrationTypes]),
      ],
    }
  }

  async transferRegistration(args: {
    cleanupId: string
    registrationId: string
    ticketTypeId: string
    now: Date
  }): Promise<TransferRegistrationOutcome> {
    const record = this.registrations.get(args.registrationId)
    if (
      record === undefined ||
      record.cleanupId !== args.cleanupId ||
      record.status !== "registered"
    ) {
      return { kind: "not_found" }
    }
    if (record.ticketTypeId === args.ticketTypeId) return { kind: "same_type" }
    const target = this.ticketTypes.get(args.ticketTypeId)
    if (target === undefined || target.cleanupId !== args.cleanupId) {
      return { kind: "ticket_type_not_found" }
    }
    if (record.partySize > target.maxPartySize) return { kind: "party_too_large" }
    if (target.capacity !== null && target.reservedSeats + record.partySize > target.capacity) {
      return { kind: "full" }
    }
    const previousTicketTypeId = record.ticketTypeId
    target.reservedSeats += record.partySize
    if (record.ticketTypeId !== null) {
      const previous = this.ticketTypes.get(record.ticketTypeId)
      if (previous !== undefined) {
        previous.reservedSeats = Math.max(previous.reservedSeats - record.partySize, 0)
        this.recomputeSold(previous.id)
      }
    }
    record.ticketTypeId = target.id
    record.source = "transfer"
    this.recomputeSold(target.id)
    return { kind: "transferred", registration: this.toRecord(record), previousTicketTypeId }
  }

  private isBanned(cleanupId: string, userId: string): boolean {
    return this.bans.has(`${cleanupId}:${userId}`)
  }

  private eventStillLive(cleanupId: string, now: Date): boolean {
    const event = this.events.get(cleanupId)
    if (event === undefined || event.status === "cancelled") return false
    return !hasEventEnded(eventWindowOf(event), now.getTime())
  }

  private entryBanned(entry: WaitlistRecord): boolean {
    return entry.userId !== null && this.isBanned(entry.cleanupId, entry.userId)
  }

  private positionOf(entry: WaitlistRecord): number | null {
    if (entry.status !== "waiting") return null
    const ahead = [...this.waitlist.values()].filter(
      (w) =>
        w.ticketTypeId === entry.ticketTypeId &&
        w.status === "waiting" &&
        !this.entryBanned(w) &&
        (w.createdAt.getTime() < entry.createdAt.getTime() ||
          (w.createdAt.getTime() === entry.createdAt.getTime() && w.id < entry.id)),
    ).length
    return ahead + 1
  }

  private waitlistView(entry: WaitlistRecord): WaitlistRecord {
    return { ...entry, position: this.positionOf(entry) }
  }

  async joinWaitlist(args: {
    cleanupId: string
    ticketTypeId: string
    subject: RegistrationSubject
    partySize: number
    accessCodeHash: string | null
    now: Date
  }): Promise<JoinWaitlistOutcome> {
    const event = this.events.get(args.cleanupId)
    if (event === undefined) return { kind: "not_found" }
    if (event.status === "cancelled") return { kind: "closed" }
    if (hasEventEnded(eventWindowOf(event), args.now.getTime())) return { kind: "ended" }
    if (args.subject.kind === "user" && this.isBanned(args.cleanupId, args.subject.userId)) {
      return { kind: "banned" }
    }
    const type = this.ticketTypes.get(args.ticketTypeId)
    if (type === undefined || type.cleanupId !== args.cleanupId || type.visibility === "hidden") {
      return { kind: "ticket_type_not_found" }
    }
    if (!type.waitlistEnabled) return { kind: "waitlist_disabled" }
    if (type.visibility === "access_code") {
      const expected = this.accessCodeHashes.get(type.id) ?? null
      if (args.accessCodeHash === null) return { kind: "access_code_required" }
      if (args.accessCodeHash !== expected) return { kind: "access_code_invalid" }
    }
    const registered = [...this.registrations.values()].some(
      (r) =>
        r.cleanupId === args.cleanupId &&
        r.status === "registered" &&
        subjectMatches(r, args.subject),
    )
    if (registered) return { kind: "already_registered" }
    const existing = [...this.waitlist.values()].find(
      (w) =>
        w.ticketTypeId === args.ticketTypeId &&
        (w.status === "waiting" || w.status === "offered") &&
        subjectMatches(w, args.subject),
    )
    if (existing !== undefined)
      return { kind: "already_waiting", entry: this.waitlistView(existing) }
    const entry: WaitlistRecord = {
      id: this.newId(),
      cleanupId: args.cleanupId,
      ticketTypeId: args.ticketTypeId,
      ticketTypeName: type.name,
      userId: args.subject.kind === "user" ? args.subject.userId : null,
      guestId: args.subject.kind === "guest" ? args.subject.guestId : null,
      guestName: null,
      identity: null,
      partySize: args.partySize,
      status: "waiting",
      position: null,
      createdAt: args.now,
      offeredAt: null,
      claimExpiresAt: null,
    }
    this.waitlist.set(entry.id, entry)
    return { kind: "joined", entry: this.waitlistView(entry) }
  }

  async leaveWaitlist(args: {
    cleanupId: string
    ticketTypeId: string | null
    subject: RegistrationSubject
    now: Date
  }): Promise<{ left: number; releasedTicketTypeIds: string[] }> {
    return this.cancelWaitlistEntries(args)
  }

  private cancelWaitlistEntries(args: {
    cleanupId: string
    ticketTypeId: string | null
    subject: RegistrationSubject
  }): { left: number; releasedTicketTypeIds: string[] } {
    let left = 0
    const released: string[] = []
    for (const entry of this.waitlist.values()) {
      if (entry.cleanupId !== args.cleanupId) continue
      if (args.ticketTypeId !== null && entry.ticketTypeId !== args.ticketTypeId) continue
      if (entry.status !== "waiting" && entry.status !== "offered") continue
      if (!subjectMatches(entry, args.subject)) continue
      if (entry.status === "offered") {
        const type = this.ticketTypes.get(entry.ticketTypeId)
        if (type !== undefined) {
          type.reservedSeats = Math.max(type.reservedSeats - entry.partySize, 0)
        }
        released.push(entry.ticketTypeId)
      }
      entry.status = "cancelled"
      left += 1
    }
    return { left, releasedTicketTypeIds: [...new Set(released)] }
  }

  async listWaitlist(args: {
    cleanupId: string
    ticketTypeId: string | null
    status: WaitlistRecord["status"] | null
    cursor: string | null
    limit: number
  }): Promise<{ rows: WaitlistRecord[]; nextCursor: string | null }> {
    let rows = [...this.waitlist.values()].filter(
      (w) =>
        w.cleanupId === args.cleanupId &&
        !((w.status === "waiting" || w.status === "offered") && this.entryBanned(w)),
    )
    if (args.ticketTypeId !== null) rows = rows.filter((w) => w.ticketTypeId === args.ticketTypeId)
    rows = rows.filter((w) =>
      args.status === null
        ? w.status === "waiting" || w.status === "offered"
        : w.status === args.status,
    )
    rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    const page = pageWith(rows, args.limit, (last) =>
      encodeTimeCursor({ at: last.createdAt, id: last.id }),
    )
    return {
      rows: page.items.map((entry) => this.waitlistView(entry)),
      nextCursor: page.nextCursor,
    }
  }

  async findWaitlistEntry(cleanupId: string, waitlistId: string): Promise<WaitlistRecord | null> {
    const entry = this.waitlist.get(waitlistId)
    if (entry === undefined || entry.cleanupId !== cleanupId) return null
    return this.waitlistView(entry)
  }

  async ticketTypeIdsWithWaiting(cleanupId: string): Promise<string[]> {
    return [
      ...new Set(
        [...this.waitlist.values()]
          .filter((w) => w.cleanupId === cleanupId && w.status === "waiting")
          .map((w) => w.ticketTypeId),
      ),
    ]
  }

  async offerNextWaitlistEntry(args: {
    ticketTypeId: string
    now: Date
    claimWindowMs: number
  }): Promise<WaitlistOffer | null> {
    const candidates = [...this.waitlist.values()]
      .filter((w) => w.ticketTypeId === args.ticketTypeId && w.status === "waiting")
      .filter((w) => w.userId === null || !this.isBanned(w.cleanupId, w.userId))
      .filter((w) => this.eventStillLive(w.cleanupId, args.now))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    const candidate = candidates[0]
    if (candidate === undefined) return null
    const type = this.ticketTypes.get(args.ticketTypeId)
    if (type === undefined) return null
    if (type.capacity !== null && type.reservedSeats + candidate.partySize > type.capacity)
      return null
    type.reservedSeats += candidate.partySize
    const claimExpiresAt = new Date(args.now.getTime() + args.claimWindowMs)
    candidate.status = "offered"
    candidate.offeredAt = args.now
    candidate.claimExpiresAt = claimExpiresAt
    return {
      waitlistId: candidate.id,
      cleanupId: candidate.cleanupId,
      ticketTypeId: candidate.ticketTypeId,
      userId: candidate.userId,
      guestId: candidate.guestId,
      partySize: candidate.partySize,
      claimExpiresAt,
    }
  }

  async offerWaitlistEntry(args: {
    cleanupId: string
    waitlistId: string
    now: Date
    claimWindowMs: number
  }): Promise<WaitlistOffer | null> {
    const candidate = this.waitlist.get(args.waitlistId)
    if (candidate === undefined || candidate.cleanupId !== args.cleanupId) return null
    if (candidate.status !== "waiting") return null
    if (candidate.userId !== null && this.isBanned(candidate.cleanupId, candidate.userId)) {
      return null
    }
    if (!this.eventStillLive(candidate.cleanupId, args.now)) return null
    const type = this.ticketTypes.get(candidate.ticketTypeId)
    if (type === undefined) return null
    if (type.capacity !== null && type.reservedSeats + candidate.partySize > type.capacity) {
      return null
    }
    type.reservedSeats += candidate.partySize
    const claimExpiresAt = new Date(args.now.getTime() + args.claimWindowMs)
    candidate.status = "offered"
    candidate.offeredAt = args.now
    candidate.claimExpiresAt = claimExpiresAt
    return {
      waitlistId: candidate.id,
      cleanupId: candidate.cleanupId,
      ticketTypeId: candidate.ticketTypeId,
      userId: candidate.userId,
      guestId: candidate.guestId,
      partySize: candidate.partySize,
      claimExpiresAt,
    }
  }

  async expireWaitlistOffers(args: { now: Date; limit: number }): Promise<string[]> {
    const expired: string[] = []
    for (const entry of this.waitlist.values()) {
      if (expired.length >= args.limit) break
      if (entry.status !== "offered") continue
      if (entry.claimExpiresAt === null || entry.claimExpiresAt > args.now) continue
      entry.status = "expired"
      const type = this.ticketTypes.get(entry.ticketTypeId)
      if (type !== undefined) type.reservedSeats = Math.max(type.reservedSeats - entry.partySize, 0)
      expired.push(entry.ticketTypeId)
    }
    return [...new Set(expired)]
  }

  async claimWaitlistOffer(args: {
    cleanupId: string
    waitlistId: string
    subject: RegistrationSubject | null
    seats: RegisterTxArgs["seats"]
    now: Date
  }): Promise<ClaimWaitlistOutcome> {
    const entry = this.waitlist.get(args.waitlistId)
    if (entry === undefined || entry.cleanupId !== args.cleanupId) return { kind: "not_found" }
    if (entry.status === "expired") return { kind: "expired" }
    if (entry.status !== "offered") return { kind: "not_offered" }
    if (entry.claimExpiresAt !== null && entry.claimExpiresAt <= args.now) {
      entry.status = "expired"
      const type = this.ticketTypes.get(entry.ticketTypeId)
      if (type !== undefined) type.reservedSeats = Math.max(type.reservedSeats - entry.partySize, 0)
      return { kind: "expired" }
    }
    if (args.subject !== null && !subjectMatches(entry, args.subject)) return { kind: "not_found" }
    if (entry.partySize !== args.seats.slice(0, entry.partySize).length) {
      return { kind: "not_offered" }
    }

    const event = this.events.get(args.cleanupId)
    if (event !== undefined && hasEventEnded(eventWindowOf(event), args.now.getTime())) {
      entry.status = "expired"
      const type = this.ticketTypes.get(entry.ticketTypeId)
      if (type !== undefined) type.reservedSeats = Math.max(type.reservedSeats - entry.partySize, 0)
      return { kind: "not_offered" }
    }

    const subject: RegistrationSubject =
      entry.userId !== null
        ? { kind: "user", userId: entry.userId }
        : { kind: "guest", guestId: entry.guestId as string }
    entry.status = "claimed"
    const outcome = await this.registerTx({
      cleanupId: args.cleanupId,
      subject,
      ticketTypeId: entry.ticketTypeId,
      seats: args.seats.slice(0, entry.partySize),
      accessCodeHash: null,
      answers: [],
      consent: null,
      slotId: null,
      source: "waitlist",
      idempotencyKey: `waitlist:${entry.id}`,
      waitlistId: entry.id,
      now: args.now,
    })
    if (outcome.kind === "registered")
      return { kind: "claimed", registration: outcome.registration }
    if (outcome.kind === "replayed" && outcome.registration !== null) {
      return { kind: "claimed", registration: outcome.registration }
    }
    entry.status = "offered"
    return { kind: "not_offered" }
  }

  private seatById(
    cleanupId: string,
    seatId: string,
  ): { seat: SeatRecord; registration: MemoryRegistration } | null {
    for (const registration of this.registrations.values()) {
      if (registration.cleanupId !== cleanupId) continue
      const seat = registration.seats.find((s) => s.id === seatId)
      if (seat !== undefined) return { seat, registration }
    }
    return null
  }

  private seatByTokenHash(
    tokenHash: string,
    hashOf: (seatId: string) => string,
  ): { seat: SeatRecord; registration: MemoryRegistration } | null {
    for (const registration of this.registrations.values()) {
      const seat = registration.seats.find((s) => hashOf(s.id) === tokenHash)
      if (seat !== undefined) return { seat, registration }
    }
    return null
  }

  tokenHashResolver: (seatId: string) => string = (seatId) => seatId

  async checkInByToken(args: {
    cleanupId: string
    tokenHash: string
    actorId: string
    method: CheckinMethod
    now: Date
  }): Promise<CheckinResultRecord> {
    const found = this.seatByTokenHash(args.tokenHash, this.tokenHashResolver)
    if (found === null) return emptyCheckinResult("unknown_token")
    if (found.registration.cleanupId !== args.cleanupId) return emptyCheckinResult("wrong_event")
    if (found.seat.status === "cancelled") return emptyCheckinResult("cancelled")
    if (found.seat.noShowAt !== null) return emptyCheckinResult("no_show")
    const firstTime = found.seat.checkedInAt === null
    if (firstTime) {
      found.seat.checkedInAt = args.now
      found.seat.checkedInBy = args.actorId
      found.seat.checkinMethod = args.method
    }
    return buildCheckinResult(
      firstTime ? "checked_in" : "already",
      firstTime,
      { ...found.seat },
      this.toRecord(found.registration),
    )
  }

  async checkInSeat(args: {
    cleanupId: string
    seatId: string
    actorId: string
    method: CheckinMethod
    now: Date
  }): Promise<CheckinResultRecord> {
    const found = this.seatById(args.cleanupId, args.seatId)
    if (found === null) return emptyCheckinResult("unknown_token")
    if (found.seat.status === "cancelled") return emptyCheckinResult("cancelled")
    const firstTime = found.seat.checkedInAt === null
    if (firstTime) {
      found.seat.checkedInAt = args.now
      found.seat.checkedInBy = args.actorId
      found.seat.checkinMethod = args.method
      found.seat.noShowAt = null
    }
    return buildCheckinResult(
      firstTime ? "checked_in" : "already",
      firstTime,
      { ...found.seat },
      this.toRecord(found.registration),
    )
  }

  async undoCheckIn(args: { cleanupId: string; seatId: string }): Promise<SeatRecord | null> {
    const found = this.seatById(args.cleanupId, args.seatId)
    if (found === null) return null
    found.seat.checkedInAt = null
    found.seat.checkedInBy = null
    found.seat.checkinMethod = null
    found.seat.checkinCoarsenedAt = null
    return { ...found.seat }
  }

  async markNoShows(args: {
    cleanupId: string
    seatIds: readonly string[] | null
    now: Date
  }): Promise<number> {
    let marked = 0
    for (const registration of this.registrations.values()) {
      if (registration.cleanupId !== args.cleanupId) continue
      for (const seat of registration.seats) {
        if (seat.status !== "active" || seat.checkedInAt !== null || seat.noShowAt !== null)
          continue
        if (args.seatIds !== null && !args.seatIds.includes(seat.id)) continue
        seat.noShowAt = args.now
        marked += 1
      }
    }
    return marked
  }

  async sweepNoShows(args: { now: Date; limit: number }): Promise<number> {
    let marked = 0
    for (const registration of this.registrations.values()) {
      const event = this.events.get(registration.cleanupId)
      if (event === undefined || event.status === "cancelled") continue
      const endsAtMs = eventEndsAtMs(eventWindowOf(event))
      if (endsAtMs === null || endsAtMs + LIVE_TAIL_MS > args.now.getTime()) continue
      for (const seat of registration.seats) {
        if (marked >= args.limit) return marked
        if (seat.status !== "active" || seat.checkedInAt !== null || seat.noShowAt !== null)
          continue
        seat.noShowAt = args.now
        marked += 1
      }
    }
    return marked
  }

  async checkinCounters(cleanupId: string): Promise<CheckinCountersRecord> {
    const registrations = [...this.registrations.values()].filter((r) => r.cleanupId === cleanupId)
    const active = registrations.filter((r) => r.status === "registered")
    const seats = registrations.flatMap((r) => r.seats)
    const types = this.typesOf(cleanupId)
    return {
      registered: active.reduce((sum, r) => sum + r.partySize, 0),
      checkedIn: seats.filter((s) => s.status === "active" && s.checkedInAt !== null).length,
      waitlisted: [...this.waitlist.values()]
        .filter(
          (w) =>
            w.cleanupId === cleanupId &&
            (w.status === "waiting" || w.status === "offered") &&
            !this.entryBanned(w),
        )
        .reduce((sum, w) => sum + w.partySize, 0),
      noShow: seats.filter((s) => s.status === "active" && s.noShowAt !== null).length,
      capacity:
        types.length === 0
          ? (this.events.get(cleanupId)?.capacity ?? null)
          : types.some((t) => t.capacity === null)
            ? null
            : types.reduce((sum, t) => sum + (t.capacity ?? 0), 0),
      byTicketType: types.map((type) => ({
        ticketTypeId: type.id,
        name: type.name,
        registered: active
          .filter((r) => r.ticketTypeId === type.id)
          .reduce((sum, r) => sum + r.partySize, 0),
        checkedIn: active
          .filter((r) => r.ticketTypeId === type.id)
          .flatMap((r) => r.seats)
          .filter((s) => s.checkedInAt !== null).length,
        waitlisted: [...this.waitlist.values()]
          .filter(
            (w) =>
              w.ticketTypeId === type.id &&
              (w.status === "waiting" || w.status === "offered") &&
              !this.entryBanned(w),
          )
          .reduce((sum, w) => sum + w.partySize, 0),
        capacity: type.capacity,
      })),
      arrivals: arrivalBuckets(seats),
    }
  }

  async getPage(cleanupId: string): Promise<PageRecord | null> {
    const event = this.events.get(cleanupId)
    if (event === undefined) return null
    const page = this.pages.get(cleanupId)
    if (page !== undefined) return { ...page, slug: event.pageSlug, visibility: event.visibility }
    return {
      cleanupId,
      slug: event.pageSlug,
      status: "draft",
      themeAccent: "bloom",
      blocks: [],
      seo: { noindex: false },
      coverMediaId: null,
      coverKey: null,
      visibility: event.visibility,
      publishedAt: null,
      updatedAt: null,
      flaggedAt: null,
      flagReason: null,
      viewCount: 0,
    }
  }

  async savePage(args: SavePageArgs): Promise<SavePageOutcome> {
    const event = this.events.get(args.cleanupId)
    if (event === undefined) return { kind: "not_found" }
    const blockIds = [...new Set(args.blockMediaIds)]
    if (blockIds.some((id) => !this.mediaKeys.has(id))) {
      return { kind: "block_media_not_found" }
    }
    if (
      args.coverMediaId !== undefined &&
      args.coverMediaId !== null &&
      !this.mediaKeys.has(args.coverMediaId)
    ) {
      return { kind: "cover_not_found" }
    }
    if (args.slug !== undefined && args.slug !== null) {
      const taken = [...this.events.values()].some(
        (e) => e.cleanupId !== args.cleanupId && e.pageSlug === args.slug,
      )
      if (taken) return { kind: "slug_taken" }
      event.pageSlug = args.slug
    }
    const current = (await this.getPage(args.cleanupId)) as PageRecord
    const next: PageRecord = {
      ...current,
      themeAccent: args.themeAccent ?? current.themeAccent,
      blocks: args.blocks,
      seo: args.seo ?? current.seo,
      coverMediaId: args.coverMediaId === undefined ? current.coverMediaId : args.coverMediaId,
      updatedAt: args.now,
    }
    this.pages.set(args.cleanupId, next)
    this.pageMedia.set(args.cleanupId, new Set(blockIds))
    return { kind: "saved", record: next }
  }

  async publishPage(args: {
    cleanupId: string
    published: boolean
    actorId: string
    now: Date
  }): Promise<PublishPageOutcome> {
    const current = this.pages.get(args.cleanupId)
    if (current === undefined) return { kind: "not_found" }
    if (args.published && current.flaggedAt !== null) return { kind: "flagged" }
    current.status = args.published ? "published" : "unpublished"
    if (args.published) current.publishedAt = args.now
    current.updatedAt = args.now
    return { kind: "published", record: { ...current } }
  }

  readonly mediaKeys = new Map<string, string>()
  readonly pageMedia = new Map<string, Set<string>>()

  async mediaKeysFor(cleanupId: string, mediaIds: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const bound = this.pageMedia.get(cleanupId) ?? new Set<string>()
    const cover = this.pages.get(cleanupId)?.coverMediaId ?? null
    for (const id of new Set(mediaIds)) {
      if (!bound.has(id) && id !== cover) continue
      const key = this.mediaKeys.get(id)
      if (key !== undefined) out.set(id, key)
    }
    return out
  }

  async slugTaken(cleanupId: string, slug: string): Promise<boolean> {
    return [...this.events.values()].some((e) => e.cleanupId !== cleanupId && e.pageSlug === slug)
  }

  async getPublicPage(slug: string): Promise<PublicPageRecord | null> {
    const event = [...this.events.values()].find((e) => e.pageSlug === slug)
    if (event === undefined) return null
    const page = await this.getPage(event.cleanupId)
    if (page === null) return null
    return {
      page,
      event,
      ticketTypes: await this.listTicketTypes(event.cleanupId),
      questions: await this.listQuestions(event.cleanupId),
      organizationId: event.organizationId,
      donationUrl: null,
      logoKey: null,
    }
  }

  async hostedEventCounts(cleanupIds: readonly string[]): Promise<Map<string, HostedEventCounts>> {
    const out = new Map<string, HostedEventCounts>()
    for (const cleanupId of cleanupIds) {
      const counters = await this.checkinCounters(cleanupId)
      out.set(cleanupId, {
        registeredCount: counters.registered,
        waitlistCount: counters.waitlisted,
        checkedInCount: counters.checkedIn,
      })
    }
    return out
  }
}
