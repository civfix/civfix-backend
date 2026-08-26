import {
  AppError,
  ErrorCode,
  MAX_GUEST_NAME,
  type CleanupGuestDTO,
  type CleanupMemberRole,
  type CleanupStatus,
  type GetCleanupGuestsRequest,
  type GetCleanupGuestsResponse,
  type GuestContactChannel,
  type GuestRsvpCancelResponse,
  type GuestRsvpRequestRequest,
  type GuestRsvpRequestResponse,
  type GuestRsvpVerifyRequest,
  type GuestRsvpVerifyResponse,
} from "@civfix/shared"
import type { AbuseChecks, Mailer, SmsSender } from "@civfix/shared/interfaces"
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
import { honeypotTripped } from "../abuse/honeypot.js"
import { normalizeIp } from "../abuse/ip-rate-limit.js"
import { assertNoSlur } from "../abuse/slur-filter.js"
import { smsFailureKind } from "../errors/sms-failure.js"
import { renderMessage } from "../i18n/renderMessage.js"
import { encodeTimeCursor, parseTimeCursor } from "../db/cursor-helpers.js"
import { isCleanupTerminal } from "./cleanup-rules.js"
import { mapWithLimit } from "./media-presign.js"

export const GUEST_TURNSTILE_ACTION = "guest-rsvp"

export const MAX_GUESTS_PER_EVENT = 500

export const GUEST_OTP_TTL_SECONDS = OTP_TTL_SECONDS

export const GUEST_CONTACT_COOLDOWN_SECONDS = 60

export const GUEST_CONTACT_MAX_PER_DAY = 5

export const GUEST_IP_MAX_PER_HOUR = 10

export const GUEST_IP_WINDOW_SECONDS = 60 * 60

export const DAY_SECONDS = 24 * 60 * 60

export const GUESTS_DEFAULT_LIMIT = 25

export const GUEST_FANOUT_CONCURRENCY = 8

type GuestFanoutLane = "throttled" | "critical"

export const SMS_TITLE_MAX_CHARS = 20

export const GUEST_FANOUT_PER_EVENT_PER_HOUR = 3

export const GUEST_FANOUT_WINDOW_SECONDS = 60 * 60

export const GUEST_RETENTION_MAX_PAGES = 20

export const GUEST_CONTACT_RETENTION_DAYS = 30

export const GUEST_OTP_RETENTION_HOURS = 24

export const GUEST_RETENTION_BATCH = 500

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

export interface GuestEventView {
  id: string
  title: string
  status: CleanupStatus
  scheduledAt: Date
  address: string | null
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
  countGuests(cleanupId: string): Promise<number>
  goingCount(cleanupId: string): Promise<number>
  isPhoneOptedOut(phone: string): Promise<boolean>
  recordPhoneOptOut(phone: string): Promise<void>
  invalidateActiveOtps(cleanupId: string, contact: string, now: Date): Promise<void>
  insertOtp(args: InsertGuestOtpArgs): Promise<void>
  findLatestActiveOtp(
    cleanupId: string,
    contact: string,
    now: Date,
  ): Promise<GuestOtpRecord | null>
  incrementOtpAttempts(otpId: string): Promise<number>
  markOtpConsumed(otpId: string, now: Date): Promise<boolean>
  upsertVerifiedGuest(args: UpsertGuestArgs): Promise<{ id: string }>
  findGuestByManageTokenHash(
    hash: string,
  ): Promise<{ id: string; cleanupId: string; cancelledAt: Date | null } | null>
  cancelGuest(guestId: string, now: Date): Promise<void>
  listGuests(args: {
    cleanupId: string
    cursor: string | null
    limit: number
  }): Promise<{ rows: GuestRosterRow[]; nextCursor: string | null }>
  listContactableGuests(cleanupId: string, limit: number): Promise<GuestRecipient[]>
  scrubExpiredGuestContacts(args: { cutoff: Date; now: Date; batchSize: number }): Promise<number>
  deleteStaleOtps(args: { cutoff: Date; batchSize: number }): Promise<number>
}

export interface GuestRsvpLogger {
  warn(obj: unknown, msg?: string): void
  info(obj: unknown, msg?: string): void
}

export interface GuestRsvpServiceDeps {
  repo: GuestRsvpRepository
  mailer: Mailer
  smsSender: SmsSender
  abuseChecks: AbuseChecks
  cache: CacheClient
  counters: CounterStore
  roleOf: (cleanupId: string, userId: string) => Promise<CleanupMemberRole | null>
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
  notifyEventCancelled(cleanupId: string, reason: string | null): Promise<void>
  notifyEventUpdated(job: GuestUpdateFanoutJob): Promise<void>
  runRetentionSweep(): Promise<GuestRetentionResult>
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

function invalidCodeError(): AppError {
  return AppError.unauthorized("Invalid or expired code.")
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

  async function reserveSmsBudget(): Promise<void> {
    let used: number
    try {
      used = await deps.counters.incr(`sms:otp:day:${utcDayKey(now())}`, DAY_SECONDS)
    } catch (err) {
      deps.logger?.warn(
        { err },
        "guest rsvp: SMS daily-cap counter unavailable; refusing SMS (fail closed)",
      )
      throw smsUnavailableError()
    }
    if (used > deps.smsDailyCap) {
      deps.logger?.warn(
        { used, cap: deps.smsDailyCap },
        "guest rsvp: global SMS daily cap reached; refusing SMS",
      )
      throw smsUnavailableError()
    }
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

  async function sendGuestEmail(to: string, subject: string, message: string): Promise<void> {
    await deps.mailer.sendTransactional(to, "generic", { subject, message })
  }

  async function deliverCode(args: {
    channel: GuestContactChannel
    contact: string
    code: string
    eventTitle: string
  }): Promise<void> {
    if (args.channel === "email") {
      await sendGuestEmail(
        args.contact,
        renderMessage("en", "email.guest_otp.subject", { title: args.eventTitle }),
        renderMessage("en", "email.guest_otp.body", {
          title: args.eventTitle,
          code: args.code,
          minutes: Math.floor(GUEST_OTP_TTL_SECONDS / 60),
        }),
      )
      return
    }
    await deps.smsSender.send(
      args.contact,
      renderMessage("en", "sms.guest_otp.body", { title: args.eventTitle, code: args.code }),
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
    if (event === null) throw AppError.notFound("Event not found")
    if (isCleanupTerminal(event.status)) throw eventClosedError()
    return event
  }

  async function joinAsGuest(args: {
    cleanupId: string
    eventTitle: string
    name: string
    channel: GuestContactChannel
    contact: string
  }): Promise<GuestRsvpVerifyResponse> {
    const rawToken = newToken()
    const manageTokenHash = await sha256Hex(rawToken)
    await deps.repo.upsertVerifiedGuest({
      cleanupId: args.cleanupId,
      name: args.name,
      channel: args.channel,
      contactKey: args.contact,
      email: args.channel === "email" ? args.contact : null,
      phone: args.channel === "sms" ? args.contact : null,
      manageTokenHash,
      now: new Date(now()),
    })
    const going = await deps.repo.goingCount(args.cleanupId)
    await sendConfirmation({ ...args, rawToken }).catch((err: unknown) => {
      deps.logger?.warn(
        { err, cleanupId: args.cleanupId },
        "guest rsvp: confirmation message failed (suppressed; the RSVP stands)",
      )
    })
    return { joined: true, going, manageToken: rawToken }
  }

  async function sendConfirmation(args: {
    eventTitle: string
    channel: GuestContactChannel
    contact: string
    rawToken: string
  }): Promise<void> {
    if (args.channel === "email") {
      await sendGuestEmail(
        args.contact,
        renderMessage("en", "email.guest_confirmed.subject", { title: args.eventTitle }),
        renderMessage("en", "email.guest_confirmed.body", {
          title: args.eventTitle,
          link: manageLink(args.rawToken),
        }),
      )
      return
    }
    await deps.smsSender.send(
      args.contact,
      renderMessage("en", "sms.guest_confirmed.body", {
        title: smsTitle(args.eventTitle),
        link: manageLink(args.rawToken),
      }),
    )
  }

  async function fanoutAllowed(cleanupId: string): Promise<boolean> {
    let sends: number
    try {
      sends = await deps.counters.incr(
        `guest:fanout:${cleanupId}`,
        GUEST_FANOUT_WINDOW_SECONDS,
      )
    } catch (err) {
      deps.logger?.warn(
        { err, cleanupId },
        "guest fanout: throttle counter unavailable; refusing the fanout (fail closed)",
      )
      return false
    }
    if (sends > GUEST_FANOUT_PER_EVENT_PER_HOUR) {
      deps.logger?.warn(
        { cleanupId, sends },
        "guest fanout: per-event hourly throttle reached; skipping",
      )
      return false
    }
    return true
  }

  async function fanOutToGuests(
    cleanupId: string,
    lane: GuestFanoutLane,
    build: (recipient: GuestRecipient) => { subject: string; message: string; sms: string },
  ): Promise<void> {
    const critical = lane === "critical"
    let recipients: GuestRecipient[]
    try {
      recipients = await deps.repo.listContactableGuests(cleanupId, MAX_GUESTS_PER_EVENT)
    } catch (err) {
      if (critical) throw err
      deps.logger?.warn({ err, cleanupId }, "guest fanout: roster read failed (suppressed)")
      return
    }
    if (recipients.length === 0) return
    if (!critical && !(await fanoutAllowed(cleanupId))) return

    await mapWithLimit(recipients, GUEST_FANOUT_CONCURRENCY, async (recipient) => {
      const copy = build(recipient)
      try {
        if (recipient.channel === "email" && recipient.email !== null) {
          await sendGuestEmail(recipient.email, copy.subject, copy.message)
          return
        }
        if (recipient.channel === "sms" && recipient.phone !== null) {
          if (!deps.smsGuestEnabled) return
          await deps.smsSender.send(recipient.phone, copy.sms)
        }
      } catch (err) {
        if (smsFailureKind(err) === "opted_out" && recipient.phone !== null) {
          await deps.repo.recordPhoneOptOut(recipient.phone).catch(() => {})
        }
        deps.logger?.warn(
          { err, cleanupId, guestId: recipient.id, lane },
          "guest fanout: message failed (suppressed)",
        )
      }
    })
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
        action: GUEST_TURNSTILE_ACTION,
      })
      if (!human) throw AppError.turnstileFailed()

      const event = await loadOpenEvent(input.id)

      const name = input.name.trim()
      if (name.length === 0 || name.length > MAX_GUEST_NAME) {
        throw AppError.validation({ name: `must be 1-${MAX_GUEST_NAME} characters` })
      }
      assertNoSlur(name, "name")

      const contact = guestContactOf(input)

      if (isReviewerContact(input.channel, contact)) {
        return fakeSuccess
      }

      const active = await deps.repo.countActiveGuests(event.id)
      if (active >= MAX_GUESTS_PER_EVENT) {
        throw AppError.conflict("This event has reached its guest limit.")
      }

      if (input.channel === "sms") {
        if (!deps.smsGuestEnabled) throw smsUnavailableError()
        if (await deps.repo.isPhoneOptedOut(contact)) throw smsOptedOutError()
      }

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
      const cooldown = cooldownKey(event.id, digest)
      const cooldownHits = await deps.cache.incr(cooldown, GUEST_CONTACT_COOLDOWN_SECONDS)
      if (cooldownHits > 1) {
        throw AppError.rateLimited("Please wait before requesting another code.")
      }

      if (input.channel === "sms") {
        try {
          await reserveSmsBudget()
        } catch (err) {
          await releaseCooldown(cooldown)
          throw err
        }
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
        throw AppError.unauthorized("Too many attempts. Try again later.")
      }

      const event = await loadOpenEvent(input.id)
      const contact = guestContactOf(input)

      if (isReviewerContact(input.channel, contact)) {
        if (reviewer !== null && constantTimeStringEqual(input.code, reviewer.code)) {
          return joinAsGuest({
            cleanupId: event.id,
            eventTitle: event.title,
            name: REVIEWER_DISPLAY_NAME,
            channel: input.channel,
            contact,
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
        throw AppError.unauthorized("Too many incorrect attempts. Request a new code.")
      }

      const attempts = await deps.repo.incrementOtpAttempts(record.id)
      if (attempts > OTP_MAX_ATTEMPTS) {
        await deps.repo.markOtpConsumed(record.id, at)
        await bumpVerifyFailure(record.id, bucket)
        throw AppError.unauthorized("Too many incorrect attempts. Request a new code.")
      }

      const ok = await verifyOtpCode(record.codeHash, input.code)
      if (!ok) {
        if (attempts >= OTP_MAX_ATTEMPTS) {
          await deps.repo.markOtpConsumed(record.id, at)
        }
        await bumpVerifyFailure(record.id, bucket)
        throw invalidCodeError()
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
        cleanupId: event.id,
        eventTitle: event.title,
        name: record.name,
        channel: input.channel,
        contact,
      })
    },

    async cancelRsvp(token: string): Promise<GuestRsvpCancelResponse> {
      const hash = await sha256Hex(token)
      const guest = await deps.repo.findGuestByManageTokenHash(hash)
      if (guest === null) {
        throw AppError.notFound("That RSVP link is no longer valid.")
      }
      if (guest.cancelledAt === null) {
        await deps.repo.cancelGuest(guest.id, new Date(now()))
      }
      return { ok: true }
    },

    async listGuests(
      query: GetCleanupGuestsRequest,
      viewerUserId: string,
    ): Promise<GetCleanupGuestsResponse> {
      const event = await deps.repo.findEvent(query.id)
      if (event === null) throw AppError.notFound("Event not found")

      const role = await deps.roleOf(event.id, viewerUserId)
      if (role !== "organizer" && role !== "cohost") {
        throw AppError.forbidden("Only the event hosts can see the guest list.")
      }

      const limit = query.limit ?? GUESTS_DEFAULT_LIMIT
      const cursor = parseTimeCursor(query.cursor, { direction: "desc" })
      const { rows, nextCursor } = await deps.repo.listGuests({
        cleanupId: event.id,
        cursor: cursor === null ? null : encodeTimeCursor(cursor),
        limit,
      })
      const count = await deps.repo.countGuests(event.id)
      return { guests: rows.map(toCleanupGuestDTO), count, nextCursor }
    },

    async notifyEventCancelled(cleanupId: string, reason: string | null): Promise<void> {
      const event = await deps.repo.findEvent(cleanupId)
      if (event === null) return
      const subject = renderMessage("en", "email.guest_cancelled.subject", { title: event.title })
      const message =
        reason !== null
          ? renderMessage("en", "email.guest_cancelled.body_reason", {
              title: event.title,
              reason,
            })
          : renderMessage("en", "email.guest_cancelled.body", { title: event.title })
      const sms = renderMessage("en", "sms.guest_cancelled.body", { title: event.title })
      await fanOutToGuests(cleanupId, "critical", () => ({ subject, message, sms }))
    },

    async notifyEventUpdated(job: GuestUpdateFanoutJob): Promise<void> {
      const event = await deps.repo.findEvent(job.cleanupId)
      if (event === null || isCleanupTerminal(event.status)) return
      const when = event.scheduledAt.toISOString()
      const place = event.address ?? `${event.lat.toFixed(5)}, ${event.lng.toFixed(5)}`
      const subject = renderMessage("en", "email.guest_updated.subject", { title: event.title })
      const message = renderMessage("en", "email.guest_updated.body", {
        title: event.title,
        when,
        place,
      })
      const sms = renderMessage("en", "sms.guest_updated.body", {
        title: event.title,
        when,
        place,
      })
      await fanOutToGuests(job.cleanupId, "throttled", () => ({ subject, message, sms }))
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
  }
}
