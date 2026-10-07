import { AppError } from "@civfix/shared"
import { eventEndedError } from "../cleanup-rules.js"
import type {
  ClaimWaitlistOfferRequest,
  ClaimWaitlistOfferResponse,
  JoinEventWaitlistRequest,
  JoinEventWaitlistResponse,
  LeaveEventWaitlistRequest,
  ListEventWaitlistRequest,
  ListEventWaitlistResponse,
  PromoteFromWaitlistRequest,
  PromoteFromWaitlistResponse,
} from "@civfix/shared"
import type { Jobs } from "@civfix/shared/interfaces"
import { sha256Hex } from "../../auth/crypto.js"
import type { GuestPromotionNotifier } from "../guest-notify.js"
import { toWaitlistEntryDTO } from "./registration-dto.js"
import { enqueueWaitlistPromotion } from "./waitlist-promotion.js"
import type {
  HostRegistrationRepository,
  RegistrationSubject,
  WaitlistOffer,
} from "./registration-repository.js"
import type {
  RegistrationAudit,
  RegistrationNotifier,
  RegistrationService,
} from "./registration-service.js"

export const WAITLIST_CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000

const WAITLIST_EXPIRE_BATCH = 500

const WAITLIST_PROMOTE_MAX_PER_RUN = 50

const WAITLIST_DEFAULT_LIMIT = 25

export interface WaitlistServiceDeps {
  repo: HostRegistrationRepository
  registrations: Pick<RegistrationService, "buildSeatDrafts" | "eventChanged">
  jobs?: Jobs
  notifier?: RegistrationNotifier
  guests?: GuestPromotionNotifier
  audit?: RegistrationAudit
  now?: () => Date
  claimWindowMs?: number
  logger?: { warn(obj: unknown, msg?: string): void; info(obj: unknown, msg?: string): void }
}

export interface WaitlistPromoteJob {
  ticketTypeId: string
}

export interface WaitlistService {
  join(
    input: JoinEventWaitlistRequest,
    subject: RegistrationSubject,
  ): Promise<JoinEventWaitlistResponse>
  leave(input: LeaveEventWaitlistRequest, subject: RegistrationSubject): Promise<{ ok: true }>
  list(query: ListEventWaitlistRequest): Promise<ListEventWaitlistResponse>
  claim(
    input: ClaimWaitlistOfferRequest,
    subject: RegistrationSubject,
  ): Promise<ClaimWaitlistOfferResponse>
  promote(input: PromoteFromWaitlistRequest, actorId: string): Promise<PromoteFromWaitlistResponse>
  runPromote(job: WaitlistPromoteJob): Promise<number>
  runExpireSweep(): Promise<number>
}

export function makeWaitlistService(deps: WaitlistServiceDeps): WaitlistService {
  const now = deps.now ?? (() => new Date())
  const claimWindowMs = deps.claimWindowMs ?? WAITLIST_CLAIM_WINDOW_MS

  async function notifyOffered(offer: WaitlistOffer): Promise<void> {
    try {
      if (offer.userId !== null) {
        await deps.notifier?.createNotification(offer.userId, {
          type: "cleanup_slot",
          title: "A place opened up",
          body: "You moved off the waitlist. Claim your place before the hold expires.",
          link: `/cleanups/${offer.cleanupId}`,
        })
        return
      }
      if (offer.guestId === null) return
      await deps.guests?.notifyGuestPromoted(offer.guestId)
    } catch (err) {
      deps.logger?.warn(
        { err, cleanupId: offer.cleanupId },
        "waitlist: promotion notification failed (suppressed)",
      )
    }
  }

  async function enqueuePromote(ticketTypeIds: readonly (string | null)[]): Promise<void> {
    await enqueueWaitlistPromotion(deps.jobs, ticketTypeIds, deps.logger)
  }

  return {
    async join(input, subject): Promise<JoinEventWaitlistResponse> {
      const outcome = await deps.repo.joinWaitlist({
        cleanupId: input.id,
        ticketTypeId: input.ticketTypeId,
        subject,
        partySize: input.partySize,
        accessCodeHash:
          input.accessCode === undefined ? null : await sha256Hex(input.accessCode.trim()),
        now: now(),
      })
      switch (outcome.kind) {
        case "joined":
        case "already_waiting":
          await deps.registrations.eventChanged(input.id)
          return { entry: toWaitlistEntryDTO(outcome.entry) }
        case "already_registered":
          throw AppError.conflict("You are already registered for this event.")
        case "waitlist_disabled":
          throw AppError.conflict("This ticket type has no waitlist.")
        case "access_code_required":
          throw AppError.validation({ accessCode: "required for this ticket type" })
        case "access_code_invalid":
          throw AppError.validation({ accessCode: "that code is not valid for this ticket type" })
        case "ticket_type_not_found":
          throw AppError.notFound("Ticket type not found")
        case "banned":
          throw AppError.forbidden("A host removed you from this event.")
        case "closed":
          throw AppError.conflict("This event is closed.")
        case "ended":
          throw eventEndedError()
        case "not_found":
          throw AppError.notFound("Cleanup not found")
      }
    },

    async leave(input, subject): Promise<{ ok: true }> {
      const { left, releasedTicketTypeIds } = await deps.repo.leaveWaitlist({
        cleanupId: input.id,
        ticketTypeId: input.ticketTypeId ?? null,
        subject,
        now: now(),
      })
      await enqueuePromote(releasedTicketTypeIds)
      if (left > 0) await deps.registrations.eventChanged(input.id)
      return { ok: true }
    },

    async list(query): Promise<ListEventWaitlistResponse> {
      const limit = query.limit ?? WAITLIST_DEFAULT_LIMIT
      const page = await deps.repo.listWaitlist({
        cleanupId: query.id,
        ticketTypeId: query.ticketTypeId ?? null,
        status: query.status ?? null,
        cursor: query.cursor ?? null,
        limit,
      })
      return { items: page.rows.map(toWaitlistEntryDTO), nextCursor: page.nextCursor }
    },

    async claim(input, subject): Promise<ClaimWaitlistOfferResponse> {
      const entry = await deps.repo.findWaitlistEntry(input.id, input.waitlistId)
      if (entry === null) return { outcome: "not_found", registrationId: null }

      const outcome = await deps.repo.claimWaitlistOffer({
        cleanupId: input.id,
        waitlistId: input.waitlistId,
        subject,
        seats: deps.registrations.buildSeatDrafts(entry.partySize, undefined),
        now: now(),
      })
      if (outcome.kind === "claimed") {
        await deps.registrations.eventChanged(input.id)
        return { outcome: "claimed", registrationId: outcome.registration.id }
      }
      if (outcome.kind === "expired") await enqueuePromote([entry.ticketTypeId])
      return { outcome: outcome.kind, registrationId: null }
    },

    async promote(input, actorId): Promise<PromoteFromWaitlistResponse> {
      const entry = await deps.repo.findWaitlistEntry(input.id, input.waitlistId)
      if (entry === null) throw AppError.notFound("Waitlist entry not found")
      if (entry.status !== "waiting") {
        throw AppError.conflict("That waitlist entry is no longer waiting.")
      }

      const offer = await deps.repo.offerWaitlistEntry({
        cleanupId: input.id,
        waitlistId: input.waitlistId,
        now: now(),
        claimWindowMs,
      })
      if (offer === null) throw AppError.conflict("That ticket type has no room to promote into.")
      await notifyOffered(offer)
      await deps.audit?.({
        actorId,
        action: "event.waitlist_promoted",
        target: `waitlist:${offer.waitlistId}`,
        meta: { cleanupId: input.id, ticketTypeId: entry.ticketTypeId },
      })
      await deps.registrations.eventChanged(input.id)

      const promoted = await deps.repo.findWaitlistEntry(input.id, offer.waitlistId)
      if (promoted === null) throw AppError.notFound("Waitlist entry not found")
      return { entry: toWaitlistEntryDTO(promoted) }
    },

    async runPromote(job): Promise<number> {
      let offered = 0
      for (let i = 0; i < WAITLIST_PROMOTE_MAX_PER_RUN; i++) {
        const offer = await deps.repo.offerNextWaitlistEntry({
          ticketTypeId: job.ticketTypeId,
          now: now(),
          claimWindowMs,
        })
        if (offer === null) break
        offered += 1
        await notifyOffered(offer)
        await deps.registrations.eventChanged(offer.cleanupId)
      }
      return offered
    },

    async runExpireSweep(): Promise<number> {
      const ticketTypeIds = await deps.repo.expireWaitlistOffers({
        now: now(),
        limit: WAITLIST_EXPIRE_BATCH,
      })
      await enqueuePromote(ticketTypeIds)
      return ticketTypeIds.length
    },
  }
}
