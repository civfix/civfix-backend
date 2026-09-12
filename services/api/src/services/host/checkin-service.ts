import { AppError } from "@civfix/shared"
import type {
  CheckInEventSeatRequest,
  CheckinResultDTO,
  EventCheckinCountersDTO,
  GetEventCheckinCountersRequest,
  GetGuestEventTicketRequest,
  GetMyEventTicketRequest,
  MarkEventNoShowsRequest,
  MarkEventNoShowsResponse,
  MyEventTicketDTO,
  ScanEventTicketRequest,
  UndoEventCheckInRequest,
  UndoEventCheckInResponse,
} from "@civfix/shared"
import { sha256Hex } from "../../auth/crypto.js"
import type { InsightsInvalidator } from "./host-analytics-cache.js"
import { toEventRegistrationDTO, toSeatDTO } from "./registration-dto.js"
import type {
  CheckinResultRecord,
  HostRegistrationRepository,
  RegistrationRecord,
} from "./registration-repository.types.js"
import type { RegistrationAudit, RegistrationService } from "./registration-service.js"
import { normalizeTicketToken, type TicketTokenSigner } from "./ticket-token.js"

export const CHECKIN_NOSHOW_SWEEP_BATCH = 1000

export interface GuestTicketLookup {
  (manageTokenHash: string): Promise<{ id: string; cleanupId: string; cancelledAt: Date | null } | null>
}

export interface CheckinServiceDeps {
  repo: HostRegistrationRepository
  tokens: TicketTokenSigner
  registrations: Pick<RegistrationService, "signalTeam">
  insightsInvalidator?: InsightsInvalidator
  guestByManageToken?: GuestTicketLookup
  publicApiUrl?: string
  audit?: RegistrationAudit
  now?: () => Date
  logger?: { warn(obj: unknown, msg?: string): void }
}

export interface CheckinService {
  scan(input: ScanEventTicketRequest, actorId: string): Promise<CheckinResultDTO>
  checkIn(input: CheckInEventSeatRequest, actorId: string): Promise<CheckinResultDTO>
  undo(input: UndoEventCheckInRequest, actorId: string): Promise<UndoEventCheckInResponse>
  markNoShows(
    input: MarkEventNoShowsRequest,
    actorId: string,
  ): Promise<MarkEventNoShowsResponse>
  counters(query: GetEventCheckinCountersRequest): Promise<EventCheckinCountersDTO>
  myTicket(query: GetMyEventTicketRequest, userId: string): Promise<MyEventTicketDTO>
  guestTicket(input: GetGuestEventTicketRequest): Promise<MyEventTicketDTO>
  runNoShowSweep(): Promise<number>
}

function toCheckinResultDTO(record: CheckinResultRecord): CheckinResultDTO {
  return {
    outcome: record.outcome,
    firstTime: record.firstTime,
    seat: record.seat === null ? null : toSeatDTO(record.seat),
    registration:
      record.registration === null ? null : toEventRegistrationDTO(record.registration),
    attendeeName: record.attendeeName,
    ticketTypeName: record.ticketTypeName,
    partySize: record.partySize,
    checkedInAt: record.checkedInAt === null ? null : record.checkedInAt.toISOString(),
  }
}

export function makeCheckinService(deps: CheckinServiceDeps): CheckinService {
  const now = deps.now ?? (() => new Date())

  async function bumpInsights(cleanupId: string): Promise<void> {
    await deps.insightsInvalidator?.bumpInsightsGeneration(cleanupId)
  }

  async function buildTicket(
    cleanupId: string,
    registration: RegistrationRecord,
  ): Promise<MyEventTicketDTO> {
    const event = await deps.repo.eventContext(cleanupId)
    if (event === null) throw AppError.notFound("Cleanup not found")
    return {
      cleanupId,
      title: event.title,
      startsAt: event.scheduledAt.toISOString(),
      endsAt: event.endsAt === null ? null : event.endsAt.toISOString(),
      timezone: event.timezone,
      address: event.address,
      registrationId: registration.id,
      ticketTypeName: registration.ticketTypeName,
      status: registration.status,
      waitlistPosition: null,
      seats: registration.seats
        .filter((seat) => seat.status === "active")
        .map((seat) => ({
          id: seat.id,
          seatIndex: seat.seatIndex,
          ticketToken: deps.tokens.tokenFor(seat.id),
          holderName: seat.attendeeName,
          checkedInAt: seat.checkedInAt === null ? null : seat.checkedInAt.toISOString(),
        })),
      canCancel: registration.status === "registered" && registration.checkedInAt === null,
      icsUrl:
        deps.publicApiUrl === undefined || deps.publicApiUrl.length === 0
          ? null
          : `${deps.publicApiUrl.replace(/\/+$/, "")}/v1/cleanups/${cleanupId}/ics`,
    }
  }

  return {
    async scan(input, actorId): Promise<CheckinResultDTO> {
      const token = normalizeTicketToken(input.token)
      const record = await deps.repo.checkInByToken({
        cleanupId: input.id,
        tokenHash: deps.tokens.hashOf(token),
        actorId,
        method: "scan",
        now: now(),
      })
      if (record.outcome === "checked_in") {
        await deps.audit?.({
          actorId,
          action: "event.attendee_checked_in",
          target: `seat:${record.seat?.id ?? "unknown"}`,
          meta: { cleanupId: input.id, method: "scan" },
        })
        await bumpInsights(input.id)
        await deps.registrations.signalTeam(input.id)
      }
      return toCheckinResultDTO(record)
    },

    async checkIn(input, actorId): Promise<CheckinResultDTO> {
      const record = await deps.repo.checkInSeat({
        cleanupId: input.id,
        seatId: input.seatId,
        actorId,
        method: input.method,
        now: now(),
      })
      if (record.outcome === "unknown_token") throw AppError.notFound("Seat not found")
      if (record.outcome === "checked_in") {
        await deps.audit?.({
          actorId,
          action: "event.attendee_checked_in",
          target: `seat:${input.seatId}`,
          meta: { cleanupId: input.id, method: input.method },
        })
        await bumpInsights(input.id)
        await deps.registrations.signalTeam(input.id)
      }
      return toCheckinResultDTO(record)
    },

    async undo(input, actorId): Promise<UndoEventCheckInResponse> {
      const seat = await deps.repo.undoCheckIn({ cleanupId: input.id, seatId: input.seatId })
      if (seat === null) throw AppError.notFound("Seat not found")
      await deps.audit?.({
        actorId,
        action: "event.attendee_checkin_undone",
        target: `seat:${input.seatId}`,
        meta: { cleanupId: input.id },
      })
      await bumpInsights(input.id)
      await deps.registrations.signalTeam(input.id)
      return { ok: true, seat: toSeatDTO(seat) }
    },

    async markNoShows(input, actorId): Promise<MarkEventNoShowsResponse> {
      if (!input.all && (input.seatIds ?? []).length === 0) {
        throw AppError.validation({ seatIds: "list the seats, or set all" })
      }
      const marked = await deps.repo.markNoShows({
        cleanupId: input.id,
        seatIds: input.all ? null : (input.seatIds ?? []),
        now: now(),
      })
      if (marked > 0) {
        await deps.audit?.({
          actorId,
          action: "event.attendees_marked_no_show",
          target: `cleanup:${input.id}`,
          meta: { marked },
        })
        await bumpInsights(input.id)
        await deps.registrations.signalTeam(input.id)
      }
      return { ok: true, marked }
    },

    async counters(query): Promise<EventCheckinCountersDTO> {
      const record = await deps.repo.checkinCounters(query.id)
      return {
        registered: record.registered,
        checkedIn: record.checkedIn,
        waitlisted: record.waitlisted,
        noShow: record.noShow,
        capacity: record.capacity,
        byTicketType: record.byTicketType,
        arrivals: record.arrivals.map((bucket) => ({
          at: bucket.at.toISOString(),
          count: bucket.count,
        })),
        asOf: now().toISOString(),
      }
    },

    async myTicket(query, userId): Promise<MyEventTicketDTO> {
      const registration = await deps.repo.findMyRegistration(query.id, {
        kind: "user",
        userId,
      })
      if (registration === null) throw AppError.notFound("You are not registered for this event.")
      return buildTicket(query.id, registration)
    },

    async guestTicket(input): Promise<MyEventTicketDTO> {
      if (deps.guestByManageToken === undefined) {
        throw AppError.notFound("That ticket link is no longer valid.")
      }
      const guest = await deps.guestByManageToken(await sha256Hex(input.token))
      if (guest === null || guest.cancelledAt !== null) {
        throw AppError.notFound("That ticket link is no longer valid.")
      }
      const registration = await deps.repo.findMyRegistration(guest.cleanupId, {
        kind: "guest",
        guestId: guest.id,
      })
      if (registration === null) {
        throw AppError.notFound("That ticket link is no longer valid.")
      }
      return buildTicket(guest.cleanupId, registration)
    },

    async runNoShowSweep(): Promise<number> {
      return deps.repo.sweepNoShows({ now: now(), limit: CHECKIN_NOSHOW_SWEEP_BATCH })
    },
  }
}
