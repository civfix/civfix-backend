import {
  AppError,
  ErrorCode,
  GUEST_OTP_ERROR_FIELD,
  GuestOtpErrorReason,
  MAX_GUEST_NAME,
  type CleanupGuestDTO,
  type CleanupStatus,
  type EventVisibility,
  type GetCleanupGuestsRequest,
  type GetCleanupGuestsResponse,
  type GuestContactChannel,
  type GuestRsvpCancelResponse,
  type GuestRsvpRequestRequest,
  type GuestRsvpRequestResponse,
  type GuestRsvpVerifyRequest,
  type GuestRsvpVerifyResponse,
  type RegisterForEventRequest,
  type RegisterForEventResponse,
  type TicketTypeVisibility,
} from "@civfix/shared"
import { GUEST_RSVP_TURNSTILE_ACTION } from "@civfix/shared/host"
import type { AbuseChecks, Jobs, Mailer, SmsSender } from "@civfix/shared/interfaces"
import {
  OTP_CODE_LENGTH,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_SECONDS,
  OTP_VERIFY_CODE_FAIL_MAX,
  OTP_VERIFY_FAIL_WINDOW_SECONDS,
  OTP_VERIFY_IP_FAIL_MAX,
  REVIEWER_DISPLAY_NAME,
  hashOtpCode,
  verifyOtpCode,
  type ReviewerOtpConfig,
} from "../auth/otp.js"
import {
  constantTimeStringEqual,
  generateNumericCode,
  generateToken,
  sha256Hex,
} from "../auth/crypto.js"
import type { CacheClient } from "../auth/cache.js"
import type { CounterStore } from "../abuse/counter-store.js"
import type { AdminAuditAction } from "./admin/audit.js"
import { honeypotTripped } from "../abuse/honeypot.js"
import { normalizeIp } from "../abuse/ip-rate-limit.js"
import { assertNoSlur } from "../abuse/slur-filter.js"
import { smsFailureKind } from "../errors/sms-failure.js"
import { mapWithLimit } from "./media-presign.js"
import { renderMessage } from "../i18n/renderMessage.js"
import { parseKeysetCursor, type KeysetCursor } from "../db/cursor-helpers.js"
import { eventEndedError, eventWindowOf, hasEventEnded } from "./cleanup-rules.js"
import { isEventPubliclyVisible } from "./host/authz.js"
import { enqueueWaitlistPromotion } from "./host/waitlist-promotion.js"
import { formatEventWhen } from "./host/broadcast-render.js"
import { DEFAULT_EVENT_TIME_ZONE } from "./host/event-fields.js"

export const MAX_GUESTS_PER_EVENT = 500

export const GUEST_OTP_TTL_SECONDS = OTP_TTL_SECONDS

export const GUEST_CONTACT_COOLDOWN_SECONDS = 60

export const GUEST_CONTACT_MAX_PER_DAY = 5

export const GUEST_IP_MAX_PER_HOUR = 10

export const GUEST_IP_WINDOW_SECONDS = 60 * 60

export const DAY_SECONDS = 24 * 60 * 60

export const GUESTS_DEFAULT_LIMIT = 25

type SmsPurpose = "otp" | "confirmation" | "notice"

export const GUEST_SMS_NOTICE_CONCURRENCY = 8

export const SMS_BUDGET_KEY_PREFIX = "sms:day:"

export const SMS_TITLE_MAX_CHARS = 20

export const GUEST_RETENTION_MAX_PAGES = 20

export const GUEST_CONTACT_RETENTION_DAYS = 30

export const GUEST_OTP_RETENTION_HOURS = 24

export const GUEST_RETENTION_BATCH = 500

export const GUEST_CONTACT_READ_COUNTER_KEY = "host:guestContactReads"

export const GUEST_CONTACT_READS_PER_HOUR = 50

export const GUEST_CONTACT_READ_WINDOW_SECONDS = 60 * 60

export interface GuestRegistrationFields {
  ticketTypeId?: string
  partySize?: number
  accessCode?: string
  answers?: RegisterForEventRequest["answers"]
  consent?: RegisterForEventRequest["consent"]
}

export interface GuestTicketTypeGate {
  id: string
  visibility: TicketTypeVisibility
  salesOpensAt: Date | null
  salesClosesAt: Date | null
}

export interface GuestRegistrationGate {
  registrationOpensAt: Date | null
  registrationClosesAt: Date | null
  ticketTypes: GuestTicketTypeGate[]
}

export interface GuestRegistrationBridge {
  register(
    input: RegisterForEventRequest,
    subject: { kind: "guest"; guestId: string },
  ): Promise<RegisterForEventResponse>
  assertInputValid?(cleanupId: string, fields: GuestRegistrationFields): Promise<void>
  registrationGate?(cleanupId: string): Promise<GuestRegistrationGate | null>
}

export interface GuestOtpRecord {
  id: string
  cleanupId: string
  channel: GuestContactChannel
  contact: string
  name: string
  codeHash: string
}

export interface GuestRosterRow {
  id: string
  name: string
  channel: GuestContactChannel
  email: string | null
  phone: string | null
  verifiedAt: Date
  cancelledAt: Date | null
}

export interface GuestRecipient {
  id: string
  name: string
  channel: GuestContactChannel
  email: string | null
  phone: string | null
}

export interface GuestNoticeTarget {
  id: string
  cleanupId: string
  name: string
  email: string | null
  cancelledAt: Date | null
  contactScrubbedAt: Date | null
}

export interface GuestEventView {
  id: string
  title: string
  status: CleanupStatus
  visibility: EventVisibility
  scheduledAt: Date
  endsAt: Date | null
  address: string | null
  timezone: string | null
  lat: number
  lng: number
}

export interface InsertGuestOtpArgs {
  cleanupId: string
  channel: GuestContactChannel
  contact: string
  name: string
  codeHash: string
  expiresAt: Date
}

export interface UpsertGuestArgs {
  cleanupId: string
  name: string
  channel: GuestContactChannel
  contactKey: string
  email: string | null
  phone: string | null
  manageTokenHash: string
  now: Date
}

export interface GuestRetentionResult {
  scrubbedGuests: number
  deletedOtps: number
}

export interface GuestRsvpRepository {
  findEvent(cleanupId: string): Promise<GuestEventView | null>
  countActiveGuests(cleanupId: string): Promise<number>
  goingCount(cleanupId: string): Promise<number>
  isPhoneOptedOut(phone: string): Promise<boolean>
  recordPhoneOptOut(phone: string): Promise<void>
  invalidateActiveOtps(cleanupId: string, contact: string, now: Date): Promise<void>
  insertOtp(args: InsertGuestOtpArgs): Promise<void>
  findLatestActiveOtp(cleanupId: string, contact: string, now: Date): Promise<GuestOtpRecord | null>
  incrementOtpAttempts(otpId: string): Promise<number>
  markOtpConsumed(otpId: string, now: Date): Promise<boolean>
  /** `created` is true when this call inserted the row rather than re-verifying an active one. */
  upsertVerifiedGuest(args: UpsertGuestArgs): Promise<{ id: string; created: boolean }>
  findGuestByManageTokenHash(
    hash: string,
  ): Promise<{ id: string; cleanupId: string; cancelledAt: Date | null } | null>
  findGuestForNotice(guestId: string): Promise<GuestNoticeTarget | null>
  cancelGuest(guestId: string, now: Date): Promise<string[]>
  listGuests(args: {
    cleanupId: string
    cursor: KeysetCursor | null
    limit: number
  }): Promise<{ rows: GuestRosterRow[]; nextCursor: string | null }>
  listContactableGuests(cleanupId: string, limit: number): Promise<GuestRecipient[]>
  scrubExpiredGuestContacts(args: { cutoff: Date; now: Date; batchSize: number }): Promise<number>
  deleteStaleOtps(args: { cutoff: Date; batchSize: number }): Promise<number>
}

export interface GuestRsvpLogger {
  warn(obj: unknown, msg?: string): void
  info(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export interface GuestRsvpServiceDeps {
  repo: GuestRsvpRepository
  mailer: Mailer
  smsSender: SmsSender
  abuseChecks: AbuseChecks
  cache: CacheClient
  counters: CounterStore
  requireGuestContact: (cleanupId: string, userId: string) => Promise<void>
  registrations?: GuestRegistrationBridge
  jobs?: Jobs
  audit?: (input: {
    actorId: string | null
    action: AdminAuditAction
    target: string
    meta?: Record<string, unknown>
  }) => Promise<void>
  smsGuestEnabled: boolean
  smsDailyCap: number
  manageLinkBase: string
  reviewer?: ReviewerOtpConfig
  now?: () => number
  newToken?: () => string
  newCode?: () => string
  logger?: GuestRsvpLogger
}

export interface GuestRequestContext {
  ip: string | null
}

export interface GuestUpdateFanoutJob {
  cleanupId: string
}

export const CLEANUP_GUEST_UPDATE_FANOUT_JOB = "cleanup.guest.update.fanout"

export const GUEST_RETENTION_SWEEP_JOB = "guest.retention.sweep"

export interface GuestRsvpService {
  requestCode(
    input: GuestRsvpRequestRequest,
    ctx: GuestRequestContext,
  ): Promise<GuestRsvpRequestResponse>
  verifyCode(
    input: GuestRsvpVerifyRequest,
    ctx: GuestRequestContext,
  ): Promise<GuestRsvpVerifyResponse>
  cancelRsvp(token: string): Promise<GuestRsvpCancelResponse>
  listGuests(
    query: GetCleanupGuestsRequest,
    viewerUserId: string,
  ): Promise<GetCleanupGuestsResponse>
  runRetentionSweep(): Promise<GuestRetentionResult>
  notifyGuestsBySms(cleanupId: string, kind: "cancelled" | "updated"): Promise<number>
}

export function smsUnavailableError(): AppError {
  return new AppError(
    ErrorCode.CONFLICT,
    "Text message codes aren't available right now. Use email instead.",
    { fields: { channel: "sms_unavailable" } },
  )
}

export function smsOptedOutError(): AppError {
  return new AppError(
    ErrorCode.CONFLICT,
    "That number has opted out of text messages. Use email instead.",
    { fields: { channel: "sms_opted_out" } },
  )
}

function eventClosedError(): AppError {
  return AppError.conflict("This event is closed.")
}

const RETRY_WITH_NEW_CODE = "Check your details, then request a new code to try again."

const RETRY_REQUEST = "Check your details, then try again."

export const GUEST_REGISTRATION_ERROR_FIELD = "registration"

export const GuestRegistrationRefusalReason = {
  soldOut: "sold_out",
  registrationClosed: "registration_closed",
  salesClosed: "sales_closed",
  eventClosed: "event_closed",
  partyTooLarge: "party_too_large",
  ticketTypeUnavailable: "ticket_type_unavailable",
  accessCodeRequired: "access_code_required",
  accessCodeInvalid: "access_code_invalid",
  answersInvalid: "answers_invalid",
} as const

export type GuestRegistrationRefusalReason =
  (typeof GuestRegistrationRefusalReason)[keyof typeof GuestRegistrationRefusalReason]

type GuestSeat = Pick<
  GuestRsvpVerifyResponse,
  "registration" | "registrationOutcome" | "ticketTokens"
> & { refusal: AppError | null }

type RegisterOutcome = RegisterForEventResponse["outcome"]

function refusedConflict(message: string, reason: GuestRegistrationRefusalReason): AppError {
  return new AppError(ErrorCode.CONFLICT, message, {
    fields: { [GUEST_REGISTRATION_ERROR_FIELD]: reason },
  })
}

function refusedInput(
  fields: Record<string, string>,
  reason: GuestRegistrationRefusalReason,
  message: string,
): AppError {
  return AppError.validation({ ...fields, [GUEST_REGISTRATION_ERROR_FIELD]: reason }, message)
}

// The clients map an error code to one generic message, so every refusal also names its reason in
// `fields`, the way the OTP and SMS refusals do, for the guest to be told what to change.
function refusalForOutcome(
  outcome: RegisterOutcome,
  answerFields: Record<string, string> | undefined,
  retryMessage: string,
): AppError | null {
  switch (outcome) {
    case "registered":
    case "replayed":
    case "already_registered":
      return null
    case "full":
    case "waitlisted":
      return refusedConflict(
        "This event has no seats left.",
        GuestRegistrationRefusalReason.soldOut,
      )
    case "registration_closed":
      return refusedConflict(
        "Registration for this event is closed.",
        GuestRegistrationRefusalReason.registrationClosed,
      )
    case "sales_closed":
      return refusedConflict(
        "Ticket sales for this event are closed.",
        GuestRegistrationRefusalReason.salesClosed,
      )
    case "closed":
      return refusedConflict("This event is closed.", GuestRegistrationRefusalReason.eventClosed)
    case "party_too_large":
      return refusedInput(
        { partySize: "more people than seats left" },
        GuestRegistrationRefusalReason.partyTooLarge,
        retryMessage,
      )
    case "ticket_type_not_found":
      return refusedInput(
        { ticketTypeId: "that ticket type is not available" },
        GuestRegistrationRefusalReason.ticketTypeUnavailable,
        retryMessage,
      )
    case "access_code_required":
      return refusedInput(
        { accessCode: "required for this ticket type" },
        GuestRegistrationRefusalReason.accessCodeRequired,
        retryMessage,
      )
    case "access_code_invalid":
      return refusedInput(
        { accessCode: "that code is not valid for this ticket type" },
        GuestRegistrationRefusalReason.accessCodeInvalid,
        retryMessage,
      )
    case "answers_invalid":
      return refusedInput(
        answerFields ?? { answers: "invalid" },
        GuestRegistrationRefusalReason.answersInvalid,
        retryMessage,
      )
    // A host ban reads exactly like an unknown event, as it does for every other guest refusal.
    case "banned":
    case "not_found":
      return AppError.notFound("Event not found")
  }
}

function registrationRefusalError(response: RegisterForEventResponse): AppError | null {
  return refusalForOutcome(response.outcome, response.fields, RETRY_WITH_NEW_CODE)
}

function withinWindow(at: Date, opensAt: Date | null, closesAt: Date | null): boolean {
  if (opensAt !== null && at < opensAt) return false
  if (closesAt !== null && at >= closesAt) return false
  return true
}

/**
 * The refusal registration is certain to give a new guest, judged from the gates a code request can
 * see. It mirrors the order of the registration transaction and answers null whenever that
 * transaction could still accept, so verify stays the authority on everything else.
 */
export function foreseeableGuestRefusal(
  gate: GuestRegistrationGate,
  fields: GuestRegistrationFields,
  at: Date,
): RegisterOutcome | null {
  if (!withinWindow(at, gate.registrationOpensAt, gate.registrationClosesAt)) {
    return "registration_closed"
  }
  const ticketType =
    fields.ticketTypeId !== undefined
      ? gate.ticketTypes.find((t) => t.id === fields.ticketTypeId)
      : gate.ticketTypes.length === 1
        ? gate.ticketTypes[0]
        : undefined
  if (ticketType === undefined || ticketType.visibility === "hidden") return null
  if (ticketType.visibility === "access_code" && fields.accessCode === undefined) {
    return "access_code_required"
  }
  if (!withinWindow(at, ticketType.salesOpensAt, ticketType.salesClosesAt)) return "sales_closed"
  return null
}

function invalidCodeError(): AppError {
  return new AppError(ErrorCode.UNAUTHORIZED, "Invalid or expired code.", {
    fields: { [GUEST_OTP_ERROR_FIELD]: GuestOtpErrorReason.invalidCode },
  })
}

function attemptsExhaustedError(): AppError {
  return new AppError(ErrorCode.UNAUTHORIZED, "Too many incorrect attempts. Request a new code.", {
    fields: { [GUEST_OTP_ERROR_FIELD]: GuestOtpErrorReason.attemptsExhausted },
  })
}

function verifyLockedOutError(): AppError {
  return new AppError(ErrorCode.UNAUTHORIZED, "Too many attempts. Try again later.", {
    fields: { [GUEST_OTP_ERROR_FIELD]: GuestOtpErrorReason.lockedOut },
  })
}

function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10)
}

export function guestContactOf(input: {
  channel: GuestContactChannel
  email?: string | undefined
  phone?: string | undefined
}): string {
  if (input.channel === "email") {
    const email = (input.email ?? "").trim().toLowerCase()
    if (email === "") throw AppError.validation({ email: "required" })
    return email
  }
  const phone = (input.phone ?? "").trim()
  if (phone === "") throw AppError.validation({ phone: "required" })
  return phone
}

export function registrationFieldsOf(
  input: GuestRsvpRequestRequest | GuestRsvpVerifyRequest,
): GuestRegistrationFields {
  return {
    ...(input.ticketTypeId !== undefined ? { ticketTypeId: input.ticketTypeId } : {}),
    ...(input.partySize !== undefined ? { partySize: input.partySize } : {}),
    ...(input.accessCode !== undefined ? { accessCode: input.accessCode } : {}),
    ...(input.answers !== undefined ? { answers: input.answers } : {}),
    ...(input.consent !== undefined ? { consent: input.consent } : {}),
  }
}

export function toCleanupGuestDTO(row: GuestRosterRow): CleanupGuestDTO {
  return {
    id: row.id,
    name: row.name,
    channel: row.channel,
    email: row.email,
    phone: row.phone,
    joinedAt: row.verifiedAt.toISOString(),
    cancelledAt: row.cancelledAt === null ? null : row.cancelledAt.toISOString(),
  }
}

export function makeGuestRsvpService(deps: GuestRsvpServiceDeps): GuestRsvpService {
  const now = deps.now ?? Date.now
  const newToken = deps.newToken ?? (() => generateToken())
  const newCode = deps.newCode ?? (() => generateNumericCode(OTP_CODE_LENGTH))
  const reviewer =
    deps.reviewer !== undefined
      ? { email: deps.reviewer.email.trim().toLowerCase(), code: deps.reviewer.code }
      : null

  function isReviewerContact(channel: GuestContactChannel, contact: string): boolean {
    return reviewer !== null && channel === "email" && contact === reviewer.email
  }

  async function contactDigest(contact: string): Promise<string> {
    return sha256Hex(contact)
  }

  function cooldownKey(cleanupId: string, digest: string): string {
    return `guest:rl:code:${cleanupId}:${digest}`
  }

  function contactDayKey(digest: string): string {
    return `guest:rl:contact:day:${digest}`
  }

  function ipKey(bucket: string): string {
    return `guest:rl:ip:${bucket}`
  }

  function codeFailKey(otpId: string): string {
    return `guest:vf:code:${otpId}`
  }

  function ipFailKey(bucket: string): string {
    return `guest:vf:ip:${bucket}`
  }

  async function readCounter(key: string): Promise<number> {
    const raw = await deps.cache.get(key)
    if (raw === null) return 0
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : 0
  }

  async function bumpVerifyFailure(otpId: string | null, bucket: string | null): Promise<void> {
    if (otpId !== null) {
      await deps.cache.incr(codeFailKey(otpId), OTP_VERIFY_FAIL_WINDOW_SECONDS)
    }
    if (bucket !== null) {
      await deps.cache.incr(ipFailKey(bucket), OTP_VERIFY_FAIL_WINDOW_SECONDS)
    }
  }

  async function reserveSmsBudget(purpose: SmsPurpose): Promise<boolean> {
    let used: number
    try {
      used = await deps.counters.incr(`${SMS_BUDGET_KEY_PREFIX}${utcDayKey(now())}`, DAY_SECONDS)
    } catch (err) {
      deps.logger?.warn(
        { err, purpose },
        "guest rsvp: SMS daily-cap counter unavailable; refusing SMS (fail closed)",
      )
      return false
    }
    if (used > deps.smsDailyCap) {
      deps.logger?.warn(
        { used, cap: deps.smsDailyCap, purpose },
        "guest rsvp: global SMS daily cap reached; refusing SMS",
      )
      return false
    }
    return true
  }

  async function releaseCooldown(key: string): Promise<void> {
    await deps.cache.del(key).catch((err: unknown) => {
      deps.logger?.warn(
        { err },
        "guest rsvp: failed to release the per-contact cooldown after a refused send",
      )
    })
  }

  function smsTitle(title: string): string {
    const points = Array.from(title)
    if (points.length <= SMS_TITLE_MAX_CHARS) return title
    return `${points.slice(0, SMS_TITLE_MAX_CHARS).join("").trimEnd()}...`
  }

  function manageLink(rawToken: string): string {
    return `${deps.manageLinkBase}/guest?token=${encodeURIComponent(rawToken)}`
  }

  async function deliverCode(args: {
    channel: GuestContactChannel
    contact: string
    code: string
    eventTitle: string
  }): Promise<void> {
    if (args.channel === "email") {
      await deps.mailer.sendTransactional(args.contact, "guest_otp", {
        title: args.eventTitle,
        code: args.code,
        minutes: String(Math.floor(GUEST_OTP_TTL_SECONDS / 60)),
      })
      return
    }
    await deps.smsSender.send(
      args.contact,
      renderMessage("en", "sms.guest_otp.body", {
        title: smsTitle(args.eventTitle),
        code: args.code,
      }),
    )
  }

  async function mapDeliveryError(err: unknown, phone: string | null): Promise<AppError | unknown> {
    const kind = smsFailureKind(err)
    if (kind === "opted_out") {
      if (phone !== null) {
        await deps.repo.recordPhoneOptOut(phone).catch((recordErr: unknown) => {
          deps.logger?.warn({ err: recordErr }, "guest rsvp: failed to record SMS opt-out")
        })
      }
      return smsOptedOutError()
    }
    if (kind === "invalid_number") {
      return AppError.validation({ phone: "that number can't receive text messages" })
    }
    if (kind === "temporary" || kind === "permanent") {
      return smsUnavailableError()
    }
    return err
  }

  async function loadOpenEvent(cleanupId: string): Promise<GuestEventView> {
    const event = await deps.repo.findEvent(cleanupId)
    // A guest never has standing on a private event, so it must be indistinguishable from an
    // unknown id, and that check runs first so its cancelled or ended state does not leak either.
    if (event === null || !isEventPubliclyVisible(event.visibility)) {
      throw AppError.notFound("Event not found")
    }
    if (event.status === "cancelled") throw eventClosedError()
    if (hasEventEnded(eventWindowOf(event), now())) throw eventEndedError()
    return event
  }

  async function assertRegistrationInputValid(
    cleanupId: string,
    fields: GuestRegistrationFields,
  ): Promise<void> {
    const hasAnswers = (fields.answers?.length ?? 0) > 0
    if (fields.consent === undefined && !hasAnswers) return
    await deps.registrations?.assertInputValid?.(cleanupId, fields)
  }

  // Judged from public event state and the form alone, never from whether this contact already
  // holds an RSVP: the answer must not tell a caller who is on the guest list.
  async function refuseForeseeableRegistration(
    cleanupId: string,
    fields: GuestRegistrationFields,
  ): Promise<void> {
    const bridge = deps.registrations
    const readGate = bridge?.registrationGate
    if (bridge === undefined || readGate === undefined) return
    let outcome: RegisterOutcome | null
    try {
      const gate = await readGate.call(bridge, cleanupId)
      if (gate === null) return
      outcome = foreseeableGuestRefusal(gate, fields, new Date(now()))
      if (outcome === null) return
    } catch (err) {
      deps.logger?.warn(
        { err, cleanupId },
        "guest rsvp: registration gate lookup failed; the verify step decides",
      )
      return
    }
    const refusal = refusalForOutcome(outcome, undefined, RETRY_REQUEST)
    if (refusal !== null) throw refusal
  }

  async function notifyGuestsBySms(
    cleanupId: string,
    kind: "cancelled" | "updated",
  ): Promise<number> {
    if (!deps.smsGuestEnabled) return 0
    const event = await deps.repo.findEvent(cleanupId)
    if (event === null) return 0
    if (
      kind === "updated" &&
      (event.status === "cancelled" || hasEventEnded(eventWindowOf(event), now()))
    ) {
      return 0
    }

    let recipients: GuestRecipient[]
    try {
      recipients = await deps.repo.listContactableGuests(cleanupId, MAX_GUESTS_PER_EVENT)
    } catch (err) {
      if (kind === "cancelled") throw err
      deps.logger?.warn({ err, cleanupId }, "guest sms: roster read failed (suppressed)")
      return 0
    }

    const texts = recipients.filter(
      (recipient) => recipient.channel === "sms" && recipient.phone !== null,
    )
    if (texts.length === 0) return 0

    const body =
      kind === "cancelled"
        ? renderMessage("en", "sms.guest_cancelled.body", { title: smsTitle(event.title) })
        : renderMessage("en", "sms.guest_updated.body", {
            title: smsTitle(event.title),
            when: formatEventWhen(event.scheduledAt, event.timezone ?? DEFAULT_EVENT_TIME_ZONE),
            place: event.address ?? `${event.lat.toFixed(5)}, ${event.lng.toFixed(5)}`,
          })

    let sent = 0
    await mapWithLimit(texts, GUEST_SMS_NOTICE_CONCURRENCY, async (recipient) => {
      try {
        if (!(await reserveSmsBudget("notice"))) {
          const line = { cleanupId, guestId: recipient.id, kind }
          const msg = "guest sms: budget refused this recipient's text"
          if (kind === "cancelled") deps.logger?.error(line, msg)
          else deps.logger?.warn(line, msg)
          return
        }
        await deps.smsSender.send(recipient.phone as string, body)
        sent += 1
      } catch (err) {
        if (smsFailureKind(err) === "opted_out" && recipient.phone !== null) {
          await deps.repo.recordPhoneOptOut(recipient.phone).catch((recordErr: unknown) => {
            deps.logger?.warn(
              { err: recordErr, cleanupId, guestId: recipient.id },
              "guest sms: failed to record SMS opt-out",
            )
          })
        }
        deps.logger?.warn({ err, cleanupId, guestId: recipient.id, kind }, "guest sms: send failed")
      }
    })
    return sent
  }

  async function registerVerifiedGuest(
    cleanupId: string,
    guestId: string,
    registration: GuestRegistrationFields,
  ): Promise<GuestSeat> {
    const bridge = deps.registrations
    if (bridge === undefined) {
      return { registration: null, registrationOutcome: null, ticketTokens: [], refusal: null }
    }
    try {
      const response = await bridge.register(
        {
          id: cleanupId,
          idempotencyKey: `guest:${guestId}`,
          partySize: registration.partySize ?? 1,
          joinWaitlistIfFull: false,
          ...(registration.ticketTypeId !== undefined
            ? { ticketTypeId: registration.ticketTypeId }
            : {}),
          ...(registration.accessCode !== undefined ? { accessCode: registration.accessCode } : {}),
          ...(registration.answers !== undefined ? { answers: registration.answers } : {}),
          ...(registration.consent !== undefined ? { consent: registration.consent } : {}),
        },
        { kind: "guest", guestId },
      )
      return {
        registration: response.registration,
        registrationOutcome: response.outcome,
        ticketTokens: response.ticketTokens,
        refusal: registrationRefusalError(response),
      }
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCode.VALIDATION) throw err
      deps.logger?.warn(
        { err, cleanupId },
        "guest rsvp: registration failed (suppressed; the RSVP stands)",
      )
      return { registration: null, registrationOutcome: null, ticketTokens: [], refusal: null }
    }
  }

  async function joinAsGuest(args: {
    event: GuestEventView
    name: string
    channel: GuestContactChannel
    contact: string
    confirm: boolean
    registration?: GuestRegistrationFields
  }): Promise<GuestRsvpVerifyResponse> {
    const rawToken = newToken()
    const manageTokenHash = await sha256Hex(rawToken)
    const guest = await deps.repo.upsertVerifiedGuest({
      cleanupId: args.event.id,
      name: args.name,
      channel: args.channel,
      contactKey: args.contact,
      email: args.channel === "email" ? args.contact : null,
      phone: args.channel === "sms" ? args.contact : null,
      manageTokenHash,
      now: new Date(now()),
    })
    // Only a row this verify inserted is rolled back: a re-verifying guest already held the RSVP
    // (possibly with a live registration that cancelGuest would also cancel).
    const rollBackThenThrow = async (refusal: unknown): Promise<never> => {
      if (guest.created) {
        try {
          const released = await deps.repo.cancelGuest(guest.id, new Date(now()))
          await enqueueWaitlistPromotion(deps.jobs, released, deps.logger)
        } catch (err) {
          // The guest must still hear why they were refused; a 500 would hide it.
          deps.logger?.error(
            { err, cleanupId: args.event.id, guestId: guest.id },
            "guest rsvp: rolling back a refused guest failed; the RSVP row may linger",
          )
        }
      }
      throw refusal
    }
    let seat: GuestSeat
    try {
      seat = await registerVerifiedGuest(args.event.id, guest.id, args.registration ?? {})
    } catch (err) {
      return rollBackThenThrow(err)
    }
    if (seat.refusal !== null && guest.created) return rollBackThenThrow(seat.refusal)
    const going = await deps.repo.goingCount(args.event.id)
    if (args.confirm) {
      await sendConfirmation({ ...args, rawToken }).catch((err: unknown) => {
        deps.logger?.warn(
          { err, cleanupId: args.event.id },
          "guest rsvp: confirmation message failed (suppressed; the RSVP stands)",
        )
      })
    }
    return {
      joined: true,
      going,
      manageToken: rawToken,
      registration: seat.registration,
      registrationOutcome: seat.registrationOutcome,
      ticketTokens: seat.ticketTokens,
    }
  }

  async function sendConfirmation(args: {
    event: GuestEventView
    channel: GuestContactChannel
    contact: string
    rawToken: string
  }): Promise<void> {
    if (args.channel === "email") {
      await deps.mailer.sendTransactional(args.contact, "guest_confirmed", {
        title: args.event.title,
        when: formatEventWhen(
          args.event.scheduledAt,
          args.event.timezone ?? DEFAULT_EVENT_TIME_ZONE,
        ),
        ...(args.event.address !== null && args.event.address.length > 0
          ? { place: args.event.address }
          : {}),
        cancelUrl: manageLink(args.rawToken),
      })
      return
    }
    if (!deps.smsGuestEnabled) return
    if (!(await reserveSmsBudget("confirmation"))) {
      deps.logger?.warn(
        { contactChannel: args.channel },
        "guest rsvp: SMS budget refused the confirmation text (the RSVP stands)",
      )
      return
    }
    await deps.smsSender.send(
      args.contact,
      renderMessage("en", "sms.guest_confirmed.body", {
        title: smsTitle(args.event.title),
        link: manageLink(args.rawToken),
      }),
    )
  }

  async function reserveGuestContactBudget(viewerUserId: string): Promise<void> {
    let used: number
    try {
      used = await deps.counters.incr(
        `${GUEST_CONTACT_READ_COUNTER_KEY}:${viewerUserId}`,
        GUEST_CONTACT_READ_WINDOW_SECONDS,
      )
    } catch (err) {
      deps.logger?.warn(
        { err },
        "guest contact: harvest counter unavailable; refusing the read (fail closed)",
      )
      throw AppError.rateLimited("The guest list is temporarily unavailable.")
    }
    if (used > GUEST_CONTACT_READS_PER_HOUR) {
      throw AppError.rateLimited("Too many guest list reads. Try again later.")
    }
  }

  async function drainPages(
    lane: string,
    page: (batchSize: number) => Promise<number>,
  ): Promise<number> {
    let total = 0
    for (let i = 0; i < GUEST_RETENTION_MAX_PAGES; i++) {
      let done: number
      try {
        done = await page(GUEST_RETENTION_BATCH)
      } catch (err) {
        deps.logger?.warn({ err, lane, total }, "guest retention: lane failed (suppressed)")
        return total
      }
      total += done
      if (done < GUEST_RETENTION_BATCH) return total
    }
    deps.logger?.warn(
      { lane, total },
      "guest retention: hit the page ceiling with rows still pending; the next run continues",
    )
    return total
  }

  return {
    async requestCode(
      input: GuestRsvpRequestRequest,
      ctx: GuestRequestContext,
    ): Promise<GuestRsvpRequestResponse> {
      const fakeSuccess: GuestRsvpRequestResponse = {
        sent: true,
        resendAfterSec: GUEST_CONTACT_COOLDOWN_SECONDS,
      }

      if (honeypotTripped(input.website)) {
        deps.logger?.info(
          { cleanupId: input.id, ip: ctx.ip },
          "guest rsvp: honeypot tripped; fake success, nothing sent",
        )
        return fakeSuccess
      }

      const human = await deps.abuseChecks.verifyTurnstile(input.turnstileToken, ctx.ip ?? "", {
        action: GUEST_RSVP_TURNSTILE_ACTION,
      })
      if (!human) throw AppError.turnstileFailed()

      const event = await loadOpenEvent(input.id)
      await assertRegistrationInputValid(event.id, registrationFieldsOf(input))

      const name = input.name.trim()
      if (name.length === 0 || name.length > MAX_GUEST_NAME) {
        throw AppError.validation({ name: `must be 1-${MAX_GUEST_NAME} characters` })
      }
      assertNoSlur(name, "name")

      const contact = guestContactOf(input)

      if (isReviewerContact(input.channel, contact)) {
        return fakeSuccess
      }

      // Refused before any budget is spent or code sent: the guest can fix the form and ask again.
      await refuseForeseeableRegistration(event.id, registrationFieldsOf(input))

      const active = await deps.repo.countActiveGuests(event.id)
      if (active >= MAX_GUESTS_PER_EVENT) {
        throw AppError.conflict("This event has reached its guest limit.")
      }

      if (input.channel === "sms" && !deps.smsGuestEnabled) throw smsUnavailableError()

      const digest = await contactDigest(contact)
      const bucket = ctx.ip === null ? null : normalizeIp(ctx.ip)
      if (bucket !== null) {
        const hits = await deps.cache.incr(ipKey(bucket), GUEST_IP_WINDOW_SECONDS)
        if (hits > GUEST_IP_MAX_PER_HOUR) {
          throw AppError.rateLimited("Too many code requests from this network.")
        }
      }
      const daily = await deps.cache.incr(contactDayKey(digest), DAY_SECONDS)
      if (daily > GUEST_CONTACT_MAX_PER_DAY) {
        throw AppError.rateLimited("Too many code requests for this contact today.")
      }

      if (input.channel === "sms" && (await deps.repo.isPhoneOptedOut(contact))) {
        throw smsOptedOutError()
      }

      const cooldown = cooldownKey(event.id, digest)
      const cooldownHits = await deps.cache.incr(cooldown, GUEST_CONTACT_COOLDOWN_SECONDS)
      if (cooldownHits > 1) {
        throw AppError.rateLimited("Please wait before requesting another code.")
      }

      if (input.channel === "sms" && !(await reserveSmsBudget("otp"))) {
        await releaseCooldown(cooldown)
        throw smsUnavailableError()
      }

      try {
        const at = new Date(now())
        await deps.repo.invalidateActiveOtps(event.id, contact, at)
        const code = newCode()
        const codeHash = await hashOtpCode(code)
        await deps.repo.insertOtp({
          cleanupId: event.id,
          channel: input.channel,
          contact,
          name,
          codeHash,
          expiresAt: new Date(now() + GUEST_OTP_TTL_SECONDS * 1000),
        })
        await deliverCode({ channel: input.channel, contact, code, eventTitle: event.title })
      } catch (err) {
        await releaseCooldown(cooldown)
        throw await mapDeliveryError(err, input.channel === "sms" ? contact : null)
      }

      return fakeSuccess
    },

    async verifyCode(
      input: GuestRsvpVerifyRequest,
      ctx: GuestRequestContext,
    ): Promise<GuestRsvpVerifyResponse> {
      const at = new Date(now())
      const bucket = ctx.ip === null ? null : normalizeIp(ctx.ip)
      if (bucket !== null && (await readCounter(ipFailKey(bucket))) >= OTP_VERIFY_IP_FAIL_MAX) {
        throw verifyLockedOutError()
      }

      const event = await loadOpenEvent(input.id)
      await assertRegistrationInputValid(event.id, registrationFieldsOf(input))
      const contact = guestContactOf(input)

      if (isReviewerContact(input.channel, contact)) {
        if (reviewer !== null && constantTimeStringEqual(input.code, reviewer.code)) {
          return joinAsGuest({
            event,
            name: REVIEWER_DISPLAY_NAME,
            channel: input.channel,
            contact,
            confirm: false,
            registration: registrationFieldsOf(input),
          })
        }
        await bumpVerifyFailure(null, bucket)
        throw invalidCodeError()
      }

      const record = await deps.repo.findLatestActiveOtp(event.id, contact, at)
      if (record === null) {
        await bumpVerifyFailure(null, bucket)
        throw invalidCodeError()
      }

      if ((await readCounter(codeFailKey(record.id))) >= OTP_VERIFY_CODE_FAIL_MAX) {
        await deps.repo.markOtpConsumed(record.id, at)
        throw attemptsExhaustedError()
      }

      const attempts = await deps.repo.incrementOtpAttempts(record.id)
      if (attempts > OTP_MAX_ATTEMPTS) {
        await deps.repo.markOtpConsumed(record.id, at)
        await bumpVerifyFailure(record.id, bucket)
        throw attemptsExhaustedError()
      }

      const ok = await verifyOtpCode(record.codeHash, input.code)
      if (!ok) {
        const burned = attempts >= OTP_MAX_ATTEMPTS
        if (burned) await deps.repo.markOtpConsumed(record.id, at)
        await bumpVerifyFailure(record.id, bucket)
        throw burned ? attemptsExhaustedError() : invalidCodeError()
      }

      const claimed = await deps.repo.markOtpConsumed(record.id, at)
      if (!claimed) throw invalidCodeError()

      const digest = await contactDigest(contact)
      await deps.cache.del(cooldownKey(event.id, digest)).catch((err: unknown) => {
        deps.logger?.warn(
          { err },
          "guest rsvp: failed to release the per-contact cooldown after a successful verify",
        )
      })

      return joinAsGuest({
        event,
        name: record.name,
        channel: record.channel,
        contact,
        confirm: true,
        registration: registrationFieldsOf(input),
      })
    },

    async cancelRsvp(token: string): Promise<GuestRsvpCancelResponse> {
      const hash = await sha256Hex(token)
      const guest = await deps.repo.findGuestByManageTokenHash(hash)
      if (guest === null) {
        throw AppError.notFound("That RSVP link is no longer valid.")
      }
      if (guest.cancelledAt === null) {
        const released = await deps.repo.cancelGuest(guest.id, new Date(now()))
        await enqueueWaitlistPromotion(deps.jobs, released, deps.logger)
      }
      return { ok: true }
    },

    async listGuests(
      query: GetCleanupGuestsRequest,
      viewerUserId: string,
    ): Promise<GetCleanupGuestsResponse> {
      const event = await deps.repo.findEvent(query.id)
      if (event === null) throw AppError.notFound("Event not found")

      await deps.requireGuestContact(event.id, viewerUserId)
      await reserveGuestContactBudget(viewerUserId)

      const limit = query.limit ?? GUESTS_DEFAULT_LIMIT
      const { rows, nextCursor } = await deps.repo.listGuests({
        cleanupId: event.id,
        cursor: parseKeysetCursor(query.cursor, { direction: "desc" }),
        limit,
      })
      const count = await deps.repo.countActiveGuests(event.id)
      await deps
        .audit?.({
          actorId: viewerUserId,
          action: "event.guests_viewed",
          target: `cleanup:${event.id}`,
          meta: { rows: rows.length },
        })
        .catch((err: unknown) => {
          deps.logger?.warn({ err }, "guest contact: audit write failed (suppressed)")
        })
      return { guests: rows.map(toCleanupGuestDTO), count, nextCursor }
    },

    async runRetentionSweep(): Promise<GuestRetentionResult> {
      const at = new Date(now())
      const contactCutoff = new Date(now() - GUEST_CONTACT_RETENTION_DAYS * DAY_SECONDS * 1000)
      const otpCutoff = new Date(now() - GUEST_OTP_RETENTION_HOURS * 60 * 60 * 1000)
      const scrubbedGuests = await drainPages("guest contact scrub", (batchSize) =>
        deps.repo.scrubExpiredGuestContacts({ cutoff: contactCutoff, now: at, batchSize }),
      )
      const deletedOtps = await drainPages("guest otp reap", (batchSize) =>
        deps.repo.deleteStaleOtps({ cutoff: otpCutoff, batchSize }),
      )
      return { scrubbedGuests, deletedOtps }
    },

    notifyGuestsBySms,
  }
}
