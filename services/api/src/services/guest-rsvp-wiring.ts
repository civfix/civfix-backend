import type { Container } from "../di.js"
import { REVIEWER_OTP_EMAIL } from "../auth/otp.js"
import { makeDrizzleCleanupRepository } from "./cleanup-repository.drizzle.js"
import { makeDrizzleGuestRsvpRepository } from "./guest-rsvp-repository.drizzle.js"
import {
  makeGuestRsvpService,
  type GuestRsvpService,
  type GuestRsvpServiceDeps,
} from "./guest-rsvp-service.js"

export interface GuestRsvpOverrides {
  repo: GuestRsvpServiceDeps["repo"]
  roleOf?: GuestRsvpServiceDeps["roleOf"]
  mailer?: GuestRsvpServiceDeps["mailer"]
  smsSender?: GuestRsvpServiceDeps["smsSender"]
  abuseChecks?: GuestRsvpServiceDeps["abuseChecks"]
  cache?: GuestRsvpServiceDeps["cache"]
  counters?: GuestRsvpServiceDeps["counters"]
  reviewer?: GuestRsvpServiceDeps["reviewer"]
  now?: GuestRsvpServiceDeps["now"]
}

export function guestManageLinkBase(webOrigins: readonly string[]): string {
  const origin = webOrigins[0]
  return origin !== undefined && origin.length > 0
    ? origin.replace(/\/+$/, "")
    : "https://civfix.org"
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
  const roleOf =
    overrides?.roleOf ??
    ((cleanupId: string, userId: string) =>
      makeDrizzleCleanupRepository(container.getDb().sql).roleOf(cleanupId, userId))
  return makeGuestRsvpService({
    repo,
    roleOf,
    mailer: overrides?.mailer ?? container.mailer,
    smsSender: overrides?.smsSender ?? container.smsSender,
    abuseChecks: overrides?.abuseChecks ?? container.abuseChecks,
    cache: overrides?.cache ?? container.getCache(),
    counters: overrides?.counters ?? container.getCounterStore(),
    smsGuestEnabled: container.env.SMS_GUEST_ENABLED,
    smsDailyCap: container.env.SMS_DAILY_CAP,
    manageLinkBase: guestManageLinkBase(container.env.WEB_ORIGINS),
    ...(reviewer !== undefined ? { reviewer } : {}),
    ...(overrides?.now !== undefined ? { now: overrides.now } : {}),
    ...(logger !== undefined ? { logger } : {}),
  })
}
