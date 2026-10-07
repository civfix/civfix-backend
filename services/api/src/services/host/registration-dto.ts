import { avatarGradient, DELETED_USER_LABEL } from "@civfix/shared"
import type {
  CleanupDTO,
  EventAnswerDTO,
  EventPageDTO,
  EventQuestionDTO,
  EventRegistrationDTO,
  EventSeatDTO,
  EventWaitlistEntryDTO,
  MyEventRegistrationRef,
  PersonDTO,
  PublicPageTicketType,
  RegistrationState,
  TicketTypeDTO,
} from "@civfix/shared"
import type { Sql } from "../../db/client.js"
import { makeDrizzleHostRegistrationRepository } from "./registration-repository.drizzle.js"
import type {
  AnswerRecord,
  EventRegistrationContext,
  HostRegistrationRepository,
  PageRecord,
  QuestionRecord,
  RegistrantIdentity,
  RegistrationRecord,
  SeatRecord,
  TicketTypeRecord,
  WaitlistRecord,
} from "./registration-repository.js"
import { eventWindowOf, hasEventEnded } from "../cleanup-rules.js"
import { officialPersonFlag } from "../../auth/official-account.js"

export const REGISTRATION_ROSTER_DEFAULT_LIMIT = 25

function toRegistrantPerson(identity: RegistrantIdentity): PersonDTO {
  const userId = identity.userId as string
  if (identity.deletedAt !== null) {
    return {
      id: userId,
      name: DELETED_USER_LABEL,
      handle: null,
      bio: null,
      avatar: avatarGradient(userId),
      followers: 0,
      following: 0,
      isFollowing: false,
      deleted: true,
    }
  }
  return {
    id: userId,
    name: identity.displayName ?? DELETED_USER_LABEL,
    handle: identity.handle,
    bio: identity.bio,
    avatar: avatarGradient(userId),
    ...(identity.avatarUrl !== null ? { avatarUrl: identity.avatarUrl } : {}),
    followers: 0,
    following: 0,
    isFollowing: false,
    ...officialPersonFlag(userId),
  }
}

function iso(at: Date | null): string | null {
  return at === null ? null : at.toISOString()
}

function dateOrNull(value: string | null | undefined): Date | null {
  return value === null || value === undefined ? null : new Date(value)
}

function salesOpenAt(record: TicketTypeRecord, now: Date): boolean {
  if (record.salesOpensAt !== null && now < record.salesOpensAt) return false
  if (record.salesClosesAt !== null && now >= record.salesClosesAt) return false
  return true
}

function remainingSeats(record: TicketTypeRecord): number | null {
  if (record.capacity === null) return null
  return Math.max(record.capacity - record.reservedSeats, 0)
}

export function toTicketTypeDTO(record: TicketTypeRecord, now: Date): TicketTypeDTO {
  const remaining = remainingSeats(record)
  return {
    id: record.id,
    cleanupId: record.cleanupId,
    name: record.name,
    description: record.description,
    capacity: record.capacity,
    reserved: record.reservedSeats,
    sold: record.sold,
    remaining,
    salesOpensAt: iso(record.salesOpensAt),
    salesClosesAt: iso(record.salesClosesAt),
    visibility: record.visibility,
    accessCodeSet: record.accessCodeSet,
    maxPartySize: record.maxPartySize,
    sortOrder: record.sortOrder,
    questionIds: record.questionIds,
    soldOut: remaining !== null && remaining <= 0,
    salesOpen: salesOpenAt(record, now),
    waitlistEnabled: record.waitlistEnabled,
  }
}

export function toPublicTicketType(record: TicketTypeRecord, now: Date): PublicPageTicketType {
  const remaining = remainingSeats(record)
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    maxPartySize: record.maxPartySize,
    salesOpensAt: iso(record.salesOpensAt),
    salesClosesAt: iso(record.salesClosesAt),
    soldOut: remaining !== null && remaining <= 0,
    salesOpen: salesOpenAt(record, now),
    waitlistEnabled: record.waitlistEnabled,
    sortOrder: record.sortOrder,
    requiresAccessCode: record.visibility === "access_code",
  }
}

export interface SeatProjection {
  ticketTokenFor?: (seatId: string) => string
}

export function toSeatDTO(seat: SeatRecord, projection: SeatProjection = {}): EventSeatDTO {
  const token = projection.ticketTokenFor?.(seat.id)
  return {
    id: seat.id,
    seatIndex: seat.seatIndex,
    attendeeName: seat.attendeeName,
    status: seat.status,
    ...(token !== undefined ? { ticketToken: token } : {}),
    checkedInAt: iso(seat.checkedInAt),
    checkinMethod: seat.checkinMethod,
    noShowAt: iso(seat.noShowAt),
  }
}

export interface RegistrationProjection extends SeatProjection {
  includeHostNote?: boolean
  includeAnswersPreview?: boolean
  answers?: EventAnswerDTO[]
  waitlistPosition?: number | null
}

export function toEventRegistrationDTO(
  record: RegistrationRecord,
  projection: RegistrationProjection = {},
): EventRegistrationDTO {
  const seats = record.seats.map((seat) => toSeatDTO(seat, projection))
  return {
    id: record.id,
    cleanupId: record.cleanupId,
    kind: record.userId !== null ? "member" : "guest",
    person: record.identity === null ? null : toRegistrantPerson(record.identity),
    guestName: record.guestName,
    ticketTypeId: record.ticketTypeId,
    ticketTypeName: record.ticketTypeName,
    partySize: record.partySize,
    seatCount: seats.filter((seat) => seat.status === "active").length,
    seats,
    status: record.status,
    source: record.source,
    registeredAt: record.registeredAt.toISOString(),
    cancelledAt: iso(record.cancelledAt),
    checkedInAt: iso(record.checkedInAt),
    ...(record.slotId !== null && record.slotTitle !== null
      ? { slot: { id: record.slotId, title: record.slotTitle } }
      : {}),
    ...(projection.waitlistPosition !== undefined
      ? { waitlistPosition: projection.waitlistPosition }
      : {}),
    ...(projection.includeAnswersPreview === true ? { answersPreview: record.answersPreview } : {}),
    ...(projection.answers !== undefined ? { answers: projection.answers } : {}),
    ...(projection.includeHostNote === true ? { note: record.hostNote } : {}),
  }
}

function toMyRegistrationRef(
  record: RegistrationRecord,
  waitlistPosition: number | null,
  canCancel: boolean,
): MyEventRegistrationRef {
  return {
    id: record.id,
    ticketTypeId: record.ticketTypeId,
    ticketTypeName: record.ticketTypeName,
    status: record.status,
    seatCount: record.seats.filter((seat) => seat.status === "active").length,
    checkedIn: record.checkedInAt !== null,
    waitlistPosition,
    canCancel,
  }
}

export function toWaitlistEntryDTO(record: WaitlistRecord): EventWaitlistEntryDTO {
  return {
    id: record.id,
    cleanupId: record.cleanupId,
    ticketTypeId: record.ticketTypeId,
    ticketTypeName: record.ticketTypeName,
    person: record.identity === null ? null : toRegistrantPerson(record.identity),
    guestName: record.guestName,
    partySize: record.partySize,
    status: record.status,
    position: record.position,
    createdAt: record.createdAt.toISOString(),
    offeredAt: iso(record.offeredAt),
    claimExpiresAt: iso(record.claimExpiresAt),
  }
}

export function toEventQuestionDTO(record: QuestionRecord): EventQuestionDTO {
  return {
    id: record.id,
    cleanupId: record.cleanupId,
    kind: record.kind,
    prompt: record.prompt,
    helpText: record.helpText,
    required: record.required,
    ticketTypeId: record.ticketTypeId,
    options: record.options,
    maxSelections: record.maxSelections,
    consentText: record.consentText,
    showIf: record.showIf,
    sortOrder: record.sortOrder,
    archivedAt: iso(record.archivedAt),
  }
}

export function toEventAnswerDTO(record: AnswerRecord): EventAnswerDTO {
  const value =
    record.scrubbedAt !== null
      ? null
      : record.valueText !== null
        ? record.valueText
        : ((record.valueJson ?? null) as EventAnswerDTO["value"])
  return {
    questionId: record.questionId,
    prompt: record.prompt,
    value,
    scrubbedAt: iso(record.scrubbedAt),
  }
}

export function toEventPageDTO(record: PageRecord, coverUrl: string | null): EventPageDTO {
  return {
    cleanupId: record.cleanupId,
    slug: record.slug,
    status: record.status,
    theme: { accent: record.themeAccent },
    coverMediaId: record.coverMediaId,
    coverUrl,
    blocks: record.blocks,
    seo: record.seo,
    visibility: record.visibility,
    publishedAt: iso(record.publishedAt),
    updatedAt: iso(record.updatedAt),
    flaggedAt: iso(record.flaggedAt),
    flagReason: record.flagReason,
    viewCount: record.viewCount,
  }
}

export function registrationStateOf(
  event: Pick<
    EventRegistrationContext,
    "status" | "scheduledAt" | "endsAt" | "registrationOpensAt" | "registrationClosesAt"
  >,
  ticketTypes: readonly TicketTypeRecord[],
  now: Date,
): RegistrationState {
  if (event.status === "cancelled") return "closed"
  if (hasEventEnded(eventWindowOf(event), now.getTime())) return "closed"
  if (event.registrationOpensAt !== null && now < event.registrationOpensAt) return "not_yet_open"
  if (event.registrationClosesAt !== null && now >= event.registrationClosesAt) return "closed"
  if (ticketTypes.length === 0) return "open"

  const sellable = ticketTypes.filter((t) => t.visibility !== "hidden")
  const pool = sellable.length > 0 ? sellable : ticketTypes
  const open = pool.filter((t) => salesOpenAt(t, now))
  if (open.length === 0) return "closed"
  const withRoom = open.filter((t) => {
    const remaining = remainingSeats(t)
    return remaining === null || remaining > 0
  })
  if (withRoom.length > 0) return "open"
  return open.some((t) => t.waitlistEnabled) ? "waitlist" : "full"
}

interface AttachRegistrationFieldsDeps {
  repo: HostRegistrationRepository
  now?: () => Date
}

async function attachRegistrationFieldsWith(
  deps: AttachRegistrationFieldsDeps,
  dtos: CleanupDTO[],
  viewerUserId: string | null,
): Promise<CleanupDTO[]> {
  if (dtos.length === 0) return dtos
  const now = (deps.now ?? (() => new Date()))()
  const ids = dtos.map((dto) => dto.id)
  const typesByEvent = await deps.repo.listTicketTypesFor(ids)
  const mine =
    viewerUserId === null
      ? new Map<string, RegistrationRecord>()
      : await deps.repo.findRegistrationsFor(ids, viewerUserId)

  for (const dto of dtos) {
    const types = typesByEvent.get(dto.id) ?? []
    dto.ticketTypes = types
      .filter((type) => type.visibility === "public")
      .map((type) => toTicketTypeDTO(type, now))
    dto.registrationState = registrationStateOf(
      {
        status: dto.status,
        scheduledAt: new Date(dto.scheduledAt),
        endsAt: dateOrNull(dto.endsAt),
        registrationOpensAt: dateOrNull(dto.registrationOpensAt),
        registrationClosesAt: dateOrNull(dto.registrationClosesAt),
      },
      types,
      now,
    )
    const registration = mine.get(dto.id)
    dto.myRegistration =
      registration === undefined
        ? null
        : toMyRegistrationRef(registration, null, registration.checkedInAt === null)
  }
  return dtos
}

export async function attachRegistrationFields(
  sql: Sql,
  dtos: CleanupDTO[],
  viewerUserId: string | null,
): Promise<CleanupDTO[]> {
  return attachRegistrationFieldsWith(
    { repo: makeDrizzleHostRegistrationRepository(sql) },
    dtos,
    viewerUserId,
  )
}
