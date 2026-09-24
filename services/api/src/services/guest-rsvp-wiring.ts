import type { Container } from "../di.js"
import { REVIEWER_OTP_EMAIL } from "../auth/otp.js"
import { writeAudit } from "./admin/audit.js"
import { requireCapability } from "./host/authz.js"
import { makeContainerRegistrationServices } from "./host/registration-wiring.js"
import { webBaseUrlOf } from "../lib/base-url.js"
import { makeDrizzleGuestRsvpRepository } from "./guest-rsvp-repository.drizzle.js"
import {
  makeGuestRsvpService,
  type GuestRsvpService,
  type GuestRsvpServiceDeps,
} from "./guest-rsvp-service.js"

export interface GuestRsvpOverrides {
  repo: GuestRsvpServiceDeps["repo"]
  requireGuestContact?: GuestRsvpServiceDeps["requireGuestContact"]
  registrations?: GuestRsvpServiceDeps["registrations"]
  audit?: GuestRsvpServiceDeps["audit"]
  mailer?: GuestRsvpServiceDeps["mailer"]
  smsSender?: GuestRsvpServiceDeps["smsSender"]
  abuseChecks?: GuestRsvpServiceDeps["abuseChecks"]
  cache?: GuestRsvpServiceDeps["cache"]
  counters?: GuestRsvpServiceDeps["counters"]
  reviewer?: GuestRsvpServiceDeps["reviewer"]
  now?: GuestRsvpServiceDeps["now"]
}

export function guestReviewerConfig(container: Container): GuestRsvpServiceDeps["reviewer"] {
  const code = container.env.REVIEWER_OTP_CODE
  if (!container.env.REVIEWER_OTP_BYPASS || code === undefined || code.length === 0) {
    return undefined
  }
  return { email: REVIEWER_OTP_EMAIL, code }
}

export function makeContainerGuestRsvpService(
  container: Container,
  overrides?: GuestRsvpOverrides,
  logger?: GuestRsvpServiceDeps["logger"],
): GuestRsvpService {
  const reviewer = overrides?.reviewer ?? guestReviewerConfig(container)
  const repo = overrides?.repo ?? makeDrizzleGuestRsvpRepository(container.getDb().sql)
  const requireGuestContact =
    overrides?.requireGuestContact ??
    (async (cleanupId: string, userId: string) => {
      await requireCapability(container.getDb().sql, cleanupId, userId, "view_guest_contact")
    })
  const registrations: GuestRsvpServiceDeps["registrations"] = overrides?.registrations ?? {
    register: (input, subject) =>
      makeContainerRegistrationServices(container, undefined, logger).registrations.register(
        input,
        subject,
      ),
    assertInputValid: (cleanupId, fields) =>
      makeContainerRegistrationServices(
        container,
        undefined,
        logger,
      ).registrations.assertInputValid({
        id: cleanupId,
        ...(fields.ticketTypeId !== undefined ? { ticketTypeId: fields.ticketTypeId } : {}),
        ...(fields.answers !== undefined ? { answers: fields.answers } : {}),
        ...(fields.consent !== undefined ? { consent: fields.consent } : {}),
      }),
  }
  const audit: GuestRsvpServiceDeps["audit"] =
    overrides?.audit ??
    (async (input) => {
      await writeAudit(container.getDb().sql, {
        actorId: input.actorId,
        action: input.action,
        target: input.target,
        meta: input.meta ?? null,
      })
    })
  return makeGuestRsvpService({
    repo,
    requireGuestContact,
    registrations,
    audit,
    jobs: container.jobs,
    mailer: overrides?.mailer ?? container.mailer,
    smsSender: overrides?.smsSender ?? container.smsSender,
    abuseChecks: overrides?.abuseChecks ?? container.abuseChecks,
    cache: overrides?.cache ?? container.getCache(),
    counters: overrides?.counters ?? container.getCounterStore(),
    smsGuestEnabled: container.env.SMS_GUEST_ENABLED,
    smsDailyCap: container.env.SMS_DAILY_CAP,
    manageLinkBase: webBaseUrlOf(container.env),
    ...(reviewer !== undefined ? { reviewer } : {}),
    ...(overrides?.now !== undefined ? { now: overrides.now } : {}),
    ...(logger !== undefined ? { logger } : {}),
  })
}
