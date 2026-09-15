import { AppError, currentVersion } from "@civfix/shared"
import type {
  CancelEventRegistrationRequest,
  CancelEventRegistrationResponse,
  CreateWalkupRegistrationRequest,
  CreateWalkupRegistrationResponse,
  EventConsentInput,
  EventRegistrationDTO,
  GetEventRegistrationAnswersResponse,
  ListEventRegistrationsRequest,
  ListEventRegistrationsResponse,
  NotificationType,
  RegisterForEventRequest,
  RegisterForEventResponse,
  RegisterOutcome,
  RemoveEventRegistrationRequest,
  SetEventRegistrationNoteRequest,
  TransferEventRegistrationRequest,
  TransferEventRegistrationResponse,
} from "@civfix/shared"
import type { Jobs } from "@civfix/shared/interfaces"
import type { UserChannel } from "@civfix/shared/interfaces"
import { assertNoSlur } from "../../abuse/slur-filter.js"
import { eventEndedError, eventWindowOf, hasEventEnded } from "../cleanup-rules.js"
import { sha256Hex } from "../../auth/crypto.js"
import type { CounterStore } from "../../abuse/counter-store.js"
import { validateAnswers } from "./question-validation.js"
import {
  REGISTRATION_ROSTER_DEFAULT_LIMIT,
  toEventAnswerDTO,
  toEventRegistrationDTO,
} from "./registration-dto.js"
import { enqueueWaitlistPromotion } from "./waitlist-promotion.js"
import type { InsightsInvalidator } from "./host-analytics-cache.js"
import { NO_AFFILIATIONS, withAffiliation, type AffiliationLoader } from "../affiliation.js"
import type { TicketTokenSigner } from "./ticket-token.js"
import type {
  ConsentWrite,
  HostRegistrationRepository,
  RegistrationRecord,
  RegistrationSubject,
  SeatDraft,
} from "./registration-repository.types.js"

export const REGISTER_FLIP_COUNTER_KEY = "event:register"

export const REGISTER_FLIPS_PER_HOUR = 20

export const REGISTER_FLIP_WINDOW_SECONDS = 60 * 60

export const HOST_ROSTER_READ_COUNTER_KEY = "host:rosterReads"

export const HOST_ROSTER_READS_PER_HOUR = 200

export const HOST_TEAM_SIGNAL_CAP = 50

export const WALKUP_IDEMPOTENCY_BUCKET_MS = 60_000

export function walkupIdempotencyKey(
  actorId: string,
  name: string,
  partySize: number,
  at: Date,
): string {
  const bucket = Math.floor(at.getTime() / WALKUP_IDEMPOTENCY_BUCKET_MS)
  return `walkup:${actorId}:${name.toLowerCase()}:${partySize}:${bucket}`
}

export interface RegistrationProjection {
  includeHostNote: boolean
  includeAnswersPreview: boolean
}

export interface RegistrationNotifier {
  createNotification(
    userId: string,
    input: { type: NotificationType; title: string; body: string; link?: string },
  ): Promise<unknown>
}

export interface RegistrationAudit {
  (input: {
    actorId: string | null
    action: string
    target: string
    meta?: Record<string, unknown>
  }): Promise<void>
}

export interface RegistrationServiceDeps {
  repo: HostRegistrationRepository
  tokens: TicketTokenSigner
  jobs?: Jobs
  notifier?: RegistrationNotifier
  userChannel?: UserChannel
  counters?: CounterStore
  audit?: RegistrationAudit
  insightsInvalidator?: InsightsInvalidator
  teamUserIds?: (cleanupId: string) => Promise<string[]>
  affiliations?: AffiliationLoader
  now?: () => Date
  newId?: () => string
  logger?: { warn(obj: unknown, msg?: string): void }
}

export interface RegistrationService {
  register(
    input: RegisterForEventRequest,
    subject: RegistrationSubject,
  ): Promise<RegisterForEventResponse>
  listRoster(
    query: ListEventRegistrationsRequest,
    actorId: string,
    projection: RegistrationProjection,
  ): Promise<ListEventRegistrationsResponse>
  getRegistration(
    cleanupId: string,
    registrationId: string,
    actorId: string,
    projection: RegistrationProjection,
  ): Promise<EventRegistrationDTO>
  getAnswers(
    cleanupId: string,
    registrationId: string,
    actorId: string,
  ): Promise<GetEventRegistrationAnswersResponse>
  cancel(
    input: CancelEventRegistrationRequest,
    actorId: string,
    byHost: boolean,
  ): Promise<CancelEventRegistrationResponse>
  remove(input: RemoveEventRegistrationRequest, actorId: string): Promise<{ ok: true }>
  transfer(
    input: TransferEventRegistrationRequest,
    actorId: string,
  ): Promise<TransferEventRegistrationResponse>
  setNote(input: SetEventRegistrationNoteRequest, actorId: string): Promise<{ ok: true }>
  walkup(
    input: CreateWalkupRegistrationRequest,
    actorId: string,
  ): Promise<CreateWalkupRegistrationResponse>
  eventChanged(cleanupId: string): Promise<void>
  buildSeatDrafts(partySize: number, attendeeNames: readonly string[] | undefined): SeatDraft[]
  consentWriteOf(consent: EventConsentInput | undefined): ConsentWrite | null
  assertInputValid(input: {
    id: string
    ticketTypeId?: string | undefined
    answers?: RegisterForEventRequest["answers"]
    consent?: EventConsentInput | undefined
  }): Promise<void>
}

const REFUSAL_OUTCOMES: ReadonlySet<RegisterOutcome> = new Set<RegisterOutcome>([
  "already_registered",
  "waitlisted",
  "full",
  "party_too_large",
  "sales_closed",
  "registration_closed",
  "ticket_type_not_found",
  "access_code_required",
  "access_code_invalid",
  "answers_invalid",
  "banned",
  "closed",
])

export function isRegisterRefusal(outcome: RegisterOutcome): boolean {
  return REFUSAL_OUTCOMES.has(outcome)
}

export function makeRegistrationService(deps: RegistrationServiceDeps): RegistrationService {
  const now = deps.now ?? (() => new Date())
  const newId = deps.newId ?? (() => crypto.randomUUID())

  function buildSeatDrafts(
    partySize: number,
    attendeeNames: readonly string[] | undefined,
  ): SeatDraft[] {
    return Array.from({ length: partySize }, (_unused, index) => {
      const id = newId()
      const name = attendeeNames?.[index]?.trim()
      return {
        id,
        attendeeName: name === undefined || name.length === 0 ? null : name,
        tokenHash: deps.tokens.hashFor(id),
      }
    })
  }

  function consentWriteOf(consent: EventConsentInput | undefined): ConsentWrite | null {
    if (consent === undefined) return null
    if (consent.termsVersion !== currentVersion("terms")) {
      throw AppError.validation({ "consent.termsVersion": "out of date — re-accept the terms" })
    }
    if (consent.disclosureVersion !== currentVersion("privacy")) {
      throw AppError.validation({
        "consent.disclosureVersion": "out of date — re-accept the privacy notice",
      })
    }
    return {
      termsVersion: consent.termsVersion,
      disclosureVersion: consent.disclosureVersion,
      hostContactOptIn: consent.hostContactOptIn,
      smsOptIn: consent.smsOptIn ?? null,
      surface: consent.surface ?? null,
    }
  }

  async function publishToTeam(cleanupId: string): Promise<void> {
    if (deps.userChannel === undefined || deps.teamUserIds === undefined) return
    try {
      const ids = (await deps.teamUserIds(cleanupId)).slice(0, HOST_TEAM_SIGNAL_CAP)
      if (ids.length === 0) return
      await deps.userChannel.publishToUsers(ids, { topic: "host", id: cleanupId })
    } catch (err) {
      deps.logger?.warn({ err, cleanupId }, "host signal: publish failed (suppressed)")
    }
  }

  async function eventChanged(cleanupId: string): Promise<void> {
    await deps.insightsInvalidator?.bumpInsightsGeneration(cleanupId)
    await publishToTeam(cleanupId)
  }

  async function reserveFlipBudget(subject: RegistrationSubject): Promise<void> {
    if (deps.counters === undefined) return
    const owner = subject.kind === "user" ? subject.userId : subject.guestId
    let used: number
    try {
      used = await deps.counters.incr(
        `${REGISTER_FLIP_COUNTER_KEY}:${owner}`,
        REGISTER_FLIP_WINDOW_SECONDS,
      )
    } catch (err) {
      deps.logger?.warn(
        { err },
        "registration: abuse counter unavailable; refusing the write (fail closed)",
      )
      throw AppError.rateLimited("Registration is temporarily unavailable. Try again shortly.")
    }
    if (used > REGISTER_FLIPS_PER_HOUR) {
      throw AppError.rateLimited("Too many registration changes. Try again later.")
    }
  }

  async function reserveRosterBudget(actorId: string): Promise<void> {
    if (deps.counters === undefined) return
    let used: number
    try {
      used = await deps.counters.incr(
        `${HOST_ROSTER_READ_COUNTER_KEY}:${actorId}`,
        REGISTER_FLIP_WINDOW_SECONDS,
      )
    } catch (err) {
      deps.logger?.warn(
        { err },
        "roster: harvest counter unavailable; refusing the read (fail closed)",
      )
      throw AppError.rateLimited("The roster is temporarily unavailable.")
    }
    if (used > HOST_ROSTER_READS_PER_HOUR) {
      throw AppError.rateLimited("Too many roster reads. Try again later.")
    }
  }

  async function notifyRegistered(
    subject: RegistrationSubject,
    record: RegistrationRecord,
    eventTitle: string,
  ): Promise<void> {
    if (deps.notifier === undefined || subject.kind !== "user") return
    try {
      await deps.notifier.createNotification(subject.userId, {
        type: "system",
        title: "You're registered",
        body: `Your place at ${eventTitle} is confirmed.`,
        link: `/cleanups/${record.cleanupId}`,
      })
    } catch (err) {
      deps.logger?.warn(
        { err, cleanupId: record.cleanupId },
        "registration: confirmation notification failed (suppressed)",
      )
    }
  }

  async function assertInputValid(input: {
    id: string
    ticketTypeId?: string | undefined
    answers?: RegisterForEventRequest["answers"]
    consent?: EventConsentInput | undefined
  }): Promise<void> {
    consentWriteOf(input.consent)
    const questions = await deps.repo.listQuestions(input.id, {
      ticketTypeId: input.ticketTypeId ?? null,
    })
    const validation = validateAnswers(questions, input.answers ?? [])
    if (!validation.ok) throw AppError.validation(validation.fields)
  }

  async function registerOnce(
    input: RegisterForEventRequest,
    subject: RegistrationSubject,
    source: "self" | "walkup",
  ): Promise<RegisterForEventResponse> {
    const event = await deps.repo.eventContext(input.id)
    if (event === null) throw AppError.notFound("Cleanup not found")
    if (source === "self" && hasEventEnded(eventWindowOf(event), now().getTime())) {
      throw eventEndedError()
    }

    const questions = await deps.repo.listQuestions(input.id, {
      ticketTypeId: input.ticketTypeId ?? null,
    })
    const validation = validateAnswers(questions, input.answers ?? [])
    if (!validation.ok) {
      return {
        outcome: "answers_invalid",
        registration: null,
        ticketTokens: [],
        fields: validation.fields,
      }
    }

    const consent = consentWriteOf(input.consent)
    const seats = buildSeatDrafts(input.partySize, input.attendeeNames)

    const outcome = await deps.repo.registerTx({
      cleanupId: input.id,
      subject,
      ticketTypeId: input.ticketTypeId ?? null,
      seats,
      accessCodeHash:
        input.accessCode === undefined ? null : await sha256Hex(input.accessCode.trim()),
      answers: validation.writes,
      consent,
      slotId: input.slotId ?? null,
      source,
      idempotencyKey: input.idempotencyKey,
      waitlistId: null,
      now: now(),
    })

    if (outcome.kind === "registered" || outcome.kind === "replayed") {
      const registration = outcome.registration
      if (registration === null) {
        return { outcome: "already_registered", registration: null, ticketTokens: [] }
      }
      if (outcome.kind === "registered") {
        await notifyRegistered(subject, registration, event.title)
        await eventChanged(input.id)
      }
      return {
        outcome: outcome.kind,
        registration: toEventRegistrationDTO(registration, {
          ticketTokenFor: (seatId) => deps.tokens.tokenFor(seatId),
        }),
        ticketTokens: registration.seats
          .filter((seat) => seat.status === "active")
          .map((seat) => deps.tokens.tokenFor(seat.id)),
      }
    }

    if (outcome.kind === "not_found") throw AppError.notFound("Cleanup not found")

    if (outcome.kind === "full" && input.joinWaitlistIfFull && input.ticketTypeId != null) {
      const joined = await deps.repo.joinWaitlist({
        cleanupId: input.id,
        ticketTypeId: input.ticketTypeId,
        subject,
        partySize: input.partySize,
        accessCodeHash:
          input.accessCode === undefined ? null : await sha256Hex(input.accessCode.trim()),
        now: now(),
      })
      if (joined.kind === "joined" || joined.kind === "already_waiting") {
        await eventChanged(input.id)
        return {
          outcome: "waitlisted",
          registration: null,
          ticketTokens: [],
          waitlistPosition: joined.entry.position,
        }
      }
    }

    return { outcome: outcome.kind, registration: null, ticketTokens: [] }
  }

  return {
    buildSeatDrafts,
    consentWriteOf,
    assertInputValid,
    eventChanged,

    async register(input, subject): Promise<RegisterForEventResponse> {
      await reserveFlipBudget(subject)
      return registerOnce(input, subject, "self")
    },

    async listRoster(query, actorId, projection): Promise<ListEventRegistrationsResponse> {
      await reserveRosterBudget(actorId)
      const limit = query.limit ?? REGISTRATION_ROSTER_DEFAULT_LIMIT
      const page = await deps.repo.listRoster({
        cleanupId: query.id,
        filter: query.filter ?? "all",
        ticketTypeId: query.ticketTypeId ?? null,
        slotId: query.slotId ?? null,
        sort: query.sort ?? "registered_at_desc",
        q: query.q ?? null,
        cursor: query.cursor ?? null,
        limit,
        withTotal: query.cursor === undefined || query.cursor === null,
      })
      await deps.audit?.({
        actorId,
        action: "event.roster_viewed",
        target: `cleanup:${query.id}`,
        meta: { rows: page.rows.length, filter: query.filter ?? "all" },
      })
      if (projection.includeAnswersPreview) {
        await deps.audit?.({
          actorId,
          action: "event.answers_viewed",
          target: `cleanup:${query.id}`,
          meta: { rows: page.rows.length, surface: "roster" },
        })
      }
      const items = page.rows.map((record) => toEventRegistrationDTO(record, projection))
      const affiliations = deps.affiliations
        ? await deps.affiliations(
            items.map((i) => i.person?.id).filter((id): id is string => id != null),
            actorId,
          )
        : NO_AFFILIATIONS
      return {
        items: items.map((item) =>
          item.person === null || item.person === undefined
            ? item
            : { ...item, person: withAffiliation(item.person, affiliations) },
        ),
        nextCursor: page.nextCursor,
        ...(page.total !== undefined ? { total: page.total } : {}),
      }
    },

    async getRegistration(
      cleanupId,
      registrationId,
      actorId,
      projection,
    ): Promise<EventRegistrationDTO> {
      const record = await deps.repo.findRegistration(cleanupId, registrationId)
      if (record === null) throw AppError.notFound("Registration not found")
      if (projection.includeAnswersPreview) {
        await deps.audit?.({
          actorId,
          action: "event.answers_viewed",
          target: `registration:${registrationId}`,
          meta: { cleanupId, surface: "roster_detail" },
        })
      }
      return toEventRegistrationDTO(record, projection)
    },

    async getAnswers(
      cleanupId,
      registrationId,
      actorId,
    ): Promise<GetEventRegistrationAnswersResponse> {
      const record = await deps.repo.findRegistration(cleanupId, registrationId)
      if (record === null) throw AppError.notFound("Registration not found")
      const answers = await deps.repo.listAnswers(cleanupId, registrationId)
      await deps.audit?.({
        actorId,
        action: "event.answers_viewed",
        target: `registration:${registrationId}`,
        meta: { cleanupId },
      })
      const scrubbedAt = answers.find((answer) => answer.scrubbedAt !== null)?.scrubbedAt ?? null
      return {
        answers: answers.map(toEventAnswerDTO),
        scrubbedAt: scrubbedAt === null ? null : scrubbedAt.toISOString(),
      }
    },

    async cancel(input, actorId, byHost): Promise<CancelEventRegistrationResponse> {
      const outcome = await deps.repo.cancelRegistration({
        cleanupId: input.id,
        registrationId: input.registrationId,
        actorId,
        now: now(),
      })
      if (outcome.kind === "not_found") throw AppError.notFound("Registration not found")
      if (outcome.kind === "already_cancelled") return { ok: true, registration: null }

      await enqueueWaitlistPromotion(deps.jobs, [outcome.ticketTypeId], deps.logger)
      await eventChanged(input.id)
      if (byHost) {
        await deps.audit?.({
          actorId,
          action: "event.attendee_removed",
          target: `registration:${input.registrationId}`,
          meta: { cleanupId: input.id, reason: input.reason ?? null },
        })
      }
      return {
        ok: true,
        registration: toEventRegistrationDTO(outcome.registration, { includeHostNote: byHost }),
      }
    },

    async remove(input, actorId): Promise<{ ok: true }> {
      const outcome = await deps.repo.removeRegistration({
        cleanupId: input.id,
        registrationId: input.registrationId,
        actorId,
        ban: input.ban,
        now: now(),
      })
      if (outcome.kind === "not_found") throw AppError.notFound("Registration not found")
      if (outcome.kind === "cancelled") {
        await enqueueWaitlistPromotion(deps.jobs, [outcome.ticketTypeId], deps.logger)
        await eventChanged(input.id)
      }
      await deps.audit?.({
        actorId,
        action: "event.attendee_removed",
        target: `registration:${input.registrationId}`,
        meta: { cleanupId: input.id, banned: input.ban, reason: input.reason ?? null },
      })
      return { ok: true }
    },

    async transfer(input, actorId): Promise<TransferEventRegistrationResponse> {
      const outcome = await deps.repo.transferRegistration({
        cleanupId: input.id,
        registrationId: input.registrationId,
        ticketTypeId: input.ticketTypeId,
        now: now(),
      })
      switch (outcome.kind) {
        case "transferred":
          await eventChanged(input.id)
          await deps.audit?.({
            actorId,
            action: "event.attendee_transferred",
            target: `registration:${input.registrationId}`,
            meta: { cleanupId: input.id, ticketTypeId: input.ticketTypeId },
          })
          return {
            ok: true,
            registration: toEventRegistrationDTO(outcome.registration, {
              includeHostNote: true,
            }),
          }
        case "full":
          throw AppError.conflict("That ticket type is full.")
        case "party_too_large":
          throw AppError.conflict("That ticket type does not allow a party this size.")
        case "same_type":
          throw AppError.conflict("The registration is already on that ticket type.")
        case "ticket_type_not_found":
          throw AppError.notFound("Ticket type not found")
        case "not_found":
          throw AppError.notFound("Registration not found")
      }
    },

    async setNote(input, actorId): Promise<{ ok: true }> {
      const note = input.note === null ? null : input.note.trim()
      const updated = await deps.repo.setHostNote(
        input.id,
        input.registrationId,
        note === null || note.length === 0 ? null : note,
      )
      if (!updated) throw AppError.notFound("Registration not found")
      await deps.audit?.({
        actorId,
        action: "event.attendee_note_set",
        target: `registration:${input.registrationId}`,
        meta: { cleanupId: input.id, cleared: note === null || note.length === 0 },
      })
      return { ok: true }
    },

    async walkup(input, actorId): Promise<CreateWalkupRegistrationResponse> {
      const at = now()
      const name = input.name.trim()
      assertNoSlur(name, "name")

      const outcome = await deps.repo.registerWalkupTx({
        cleanupId: input.id,
        name,
        manageTokenHash: await sha256Hex(`walkup:${newId()}`),
        ticketTypeId: input.ticketTypeId ?? null,
        seats: buildSeatDrafts(input.partySize, [name]),
        idempotencyKey: walkupIdempotencyKey(actorId, name, input.partySize, at),
        idempotencyOwner: `user:${actorId}`,
        now: at,
      })

      if (outcome.kind === "not_found") throw AppError.notFound("Cleanup not found")
      if (outcome.kind !== "registered" && outcome.kind !== "replayed") {
        return { outcome: outcome.kind, registration: null }
      }
      const registration = outcome.registration
      if (registration === null) return { outcome: "already_registered", registration: null }

      if (input.checkInNow) {
        for (const seat of registration.seats) {
          await deps.repo.checkInSeat({
            cleanupId: input.id,
            seatId: seat.id,
            actorId,
            method: "walkup",
            now: at,
          })
        }
      }

      await deps.audit?.({
        actorId,
        action: "event.attendee_registered_by_host",
        target: `registration:${registration.id}`,
        meta: { cleanupId: input.id, partySize: input.partySize },
      })
      await eventChanged(input.id)

      const reloaded = await deps.repo.findRegistration(input.id, registration.id)
      return {
        outcome: outcome.kind,
        registration: toEventRegistrationDTO(reloaded ?? registration, {
          includeHostNote: false,
        }),
      }
    },
  }
}
