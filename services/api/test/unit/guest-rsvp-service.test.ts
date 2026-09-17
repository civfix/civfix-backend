import { beforeEach, describe, expect, it } from "vitest"
import { AppError } from "@civfix/shared"
import { randomUUID } from "node:crypto"
import { FakeAbuseChecks, FakeMailer, FakeSmsSender } from "@civfix/shared/fakes"
import {
  GUEST_OTP_ERROR_FIELD,
  GuestOtpErrorReason,
  type GuestRsvpRequestRequest,
  type GuestRsvpVerifyRequest,
} from "@civfix/shared"
import { GUEST_RSVP_TURNSTILE_ACTION } from "@civfix/shared/host"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { InMemoryCounterStore, type CounterStore } from "../../src/abuse/counter-store.js"
import { InMemoryGuestRsvpRepository } from "../helpers/guest-rsvp.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"
import { smsFailure } from "../../src/errors/sms-failure.js"
import { formatEventWhen } from "../../src/services/host/broadcast-render.js"
import { generateToken } from "../../src/auth/crypto.js"
import {
  GUEST_CONTACT_MAX_PER_DAY,
  MAX_GUESTS_PER_EVENT,
  SMS_BUDGET_KEY_PREFIX,
  makeGuestRsvpService,
  type GuestRsvpService,
  type GuestRsvpServiceDeps,
} from "../../src/services/guest-rsvp-service.js"

const EVENT_ID = "11111111-1111-1111-1111-111111111111"
const HOST_ID = "22222222-2222-2222-2222-222222222222"
const MEMBER_ID = "33333333-3333-3333-3333-333333333333"
const REVIEWER_EMAIL = "reviewer@civfix.org"
const REVIEWER_CODE = "civfix-local-reviewer-code"
const CODE = "424242"
const IP = "203.0.113.10"

interface Harness {
  service: GuestRsvpService
  repo: InMemoryGuestRsvpRepository
  mailer: FakeMailer
  sms: FakeSmsSender
  abuse: FakeAbuseChecks
  cache: InMemoryCacheClient
  counters: InMemoryCounterStore
  roles: Map<string, "organizer" | "cohost" | "member">
  advance(ms: number): void
}

function build(
  opts: {
    smsGuestEnabled?: boolean
    smsDailyCap?: number
    counters?: CounterStore
    reviewer?: { email: string; code: string } | null
    sms?: FakeSmsSender
    newToken?: () => string
    registrations?: GuestRsvpServiceDeps["registrations"]
    jobs?: GuestRsvpServiceDeps["jobs"]
  } = {},
): Harness {
  let clock = Date.parse("2026-08-25T12:00:00.000Z")
  const now = (): number => clock
  const repo = new InMemoryGuestRsvpRepository({ now })
  repo.seedEvent({ id: EVENT_ID, title: "Beach cleanup" })
  repo.memberCounts.set(EVENT_ID, 3)

  const mailer = new FakeMailer()
  const sms = opts.sms ?? new FakeSmsSender()
  const abuse = new FakeAbuseChecks()
  const cache = new InMemoryCacheClient(now)
  const counters = new InMemoryCounterStore(now)
  const roles = new Map<string, "organizer" | "cohost" | "member">([[HOST_ID, "organizer"]])
  const reviewer =
    opts.reviewer === null ? undefined : (opts.reviewer ?? { email: REVIEWER_EMAIL, code: REVIEWER_CODE })

  const service = makeGuestRsvpService({
    repo,
    mailer,
    smsSender: sms,
    abuseChecks: abuse,
    cache,
    counters: opts.counters ?? counters,
    requireGuestContact: (_cleanupId: string, userId: string) => {
      const role = roles.get(userId) ?? null
      if (role !== "organizer" && role !== "cohost") {
        return Promise.reject(AppError.forbidden("Only the event hosts can see the guest list."))
      }
      return Promise.resolve()
    },
    smsGuestEnabled: opts.smsGuestEnabled ?? false,
    smsDailyCap: opts.smsDailyCap ?? 50,
    manageLinkBase: "https://civfix.org",
    ...(opts.registrations !== undefined ? { registrations: opts.registrations } : {}),
    ...(opts.jobs !== undefined ? { jobs: opts.jobs } : {}),
    ...(reviewer !== undefined ? { reviewer } : {}),
    now,
    newCode: () => CODE,
    newToken: opts.newToken ?? (() => `manage-token-${randomUUID()}`),
  })

  return {
    service,
    repo,
    mailer,
    sms,
    abuse,
    cache,
    counters,
    roles,
    advance(ms: number) {
      clock += ms
    },
  }
}

function emailRequest(over: Partial<GuestRsvpRequestRequest> = {}): GuestRsvpRequestRequest {
  return {
    id: EVENT_ID,
    name: "Ada Lovelace",
    channel: "email",
    email: "ada@example.org",
    turnstileToken: "ok",
    ...over,
  } as GuestRsvpRequestRequest
}

function smsRequest(over: Partial<GuestRsvpRequestRequest> = {}): GuestRsvpRequestRequest {
  return {
    id: EVENT_ID,
    name: "Ada Lovelace",
    channel: "sms",
    phone: "+15552223333",
    turnstileToken: "ok",
    ...over,
  } as GuestRsvpRequestRequest
}

function emailVerify(over: Partial<GuestRsvpVerifyRequest> = {}): GuestRsvpVerifyRequest {
  return {
    id: EVENT_ID,
    channel: "email",
    email: "ada@example.org",
    code: CODE,
    ...over,
  } as GuestRsvpVerifyRequest
}

const ctx = { ip: IP }

describe("guest rsvp: requesting a code", () => {
  let h: Harness
  beforeEach(() => {
    h = build()
  })

  it("emails a code and reports the resend cooldown", async () => {
    const result = await h.service.requestCode(emailRequest(), ctx)

    expect(result).toEqual({ sent: true, resendAfterSec: 60 })
    expect(h.mailer.sent).toHaveLength(1)
    expect(h.mailer.sent[0]?.to).toBe("ada@example.org")
    expect(String(h.mailer.sent[0]?.vars?.message)).toContain(CODE)
    expect(String(h.mailer.sent[0]?.vars?.subject)).toContain("Beach cleanup")
    expect(h.repo.otps).toHaveLength(1)
    expect(h.repo.otps[0]?.name).toBe("Ada Lovelace")
  })

  it("pins the turnstile action so a token minted elsewhere cannot be replayed here", async () => {
    await h.service.requestCode(emailRequest(), ctx)
    expect(h.abuse.lastVerifyExpect).toEqual({ action: GUEST_RSVP_TURNSTILE_ACTION })
  })

  it("rejects a failed turnstile before anything is written or sent", async () => {
    await expect(
      h.service.requestCode(emailRequest({ turnstileToken: "fail" }), ctx),
    ).rejects.toMatchObject({ code: "TURNSTILE_FAILED" })
    expect(h.repo.otps).toHaveLength(0)
    expect(h.mailer.sent).toHaveLength(0)
  })

  it("accepts-and-flags a tripped honeypot: fake success, nothing written, nothing sent", async () => {
    const result = await h.service.requestCode(emailRequest({ website: "buy-cheap-pills" }), ctx)

    expect(result).toEqual({ sent: true, resendAfterSec: 60 })
    expect(h.repo.otps).toHaveLength(0)
    expect(h.mailer.sent).toHaveLength(0)
  })

  it("404s an unknown event and refuses a cancelled one", async () => {
    await expect(
      h.service.requestCode(emailRequest({ id: randomUUID() }), ctx),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })

    h.repo.seedEvent({ id: EVENT_ID, status: "cancelled" })
    await expect(h.service.requestCode(emailRequest(), ctx)).rejects.toMatchObject({
      code: "CONFLICT",
    })
  })

  it("refuses an event that has already ended, even though nobody marked it complete", async () => {
    const startedAt = new Date(Date.parse("2026-08-24T09:00:00.000Z"))
    h.repo.seedEvent({
      id: EVENT_ID,
      scheduledAt: startedAt,
      endsAt: new Date(Date.parse("2026-08-24T12:00:00.000Z")),
    })

    await expect(h.service.requestCode(emailRequest(), ctx)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This event has already ended.",
    })
    expect(h.mailer.sent).toHaveLength(0)

    h.repo.seedEvent({ id: EVENT_ID, scheduledAt: startedAt, endsAt: null })
    await expect(h.service.requestCode(emailRequest(), ctx)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This event has already ended.",
    })
  })

  it("holds a 60s per-contact cooldown and lets the same contact resend once it lapses", async () => {
    await h.service.requestCode(emailRequest(), ctx)
    await expect(h.service.requestCode(emailRequest(), ctx)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
    expect(h.mailer.sent).toHaveLength(1)

    h.advance(61_000)
    await expect(h.service.requestCode(emailRequest(), ctx)).resolves.toEqual({
      sent: true,
      resendAfterSec: 60,
    })
    expect(h.mailer.sent).toHaveLength(2)
  })

  it("caps a single contact per day", async () => {
    for (let i = 0; i < GUEST_CONTACT_MAX_PER_DAY; i++) {
      await h.service.requestCode(emailRequest(), ctx)
      h.advance(61_000)
    }
    await expect(h.service.requestCode(emailRequest(), ctx)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
  })

  it("releases the cooldown when the send itself fails, so the guest can retry", async () => {
    const failing = new FakeSmsSender()
    failing.send = () => Promise.reject(smsFailure("temporary", "provider down"))
    const harness = build({ smsGuestEnabled: true, sms: failing })

    await expect(harness.service.requestCode(smsRequest(), ctx)).rejects.toMatchObject({
      code: "CONFLICT",
    })

    harness.sms.send = () => Promise.resolve({ id: "sms-1" })
    await expect(harness.service.requestCode(smsRequest(), ctx)).resolves.toMatchObject({
      sent: true,
    })
  })

  it("refuses once the event is at its guest limit", async () => {
    for (let i = 0; i < MAX_GUESTS_PER_EVENT; i++) {
      h.repo.guests.push({
        id: randomUUID(),
        cleanupId: EVENT_ID,
        name: `Guest ${i}`,
        channel: "email",
        email: `g${i}@example.org`,
        phone: null,
        contactKey: `g${i}@example.org`,
        manageTokenHash: `hash-${i}`,
        verifiedAt: new Date(),
        cancelledAt: null,
        contactScrubbedAt: null,
        createdAt: new Date(),
      })
    }
    await expect(h.service.requestCode(emailRequest(), ctx)).rejects.toMatchObject({
      code: "CONFLICT",
    })
  })

  it("skips every send and every counter for the reviewer contact", async () => {
    const result = await h.service.requestCode(emailRequest({ email: REVIEWER_EMAIL }), ctx)

    expect(result).toEqual({ sent: true, resendAfterSec: 60 })
    expect(h.mailer.sent).toHaveLength(0)
    expect(h.repo.otps).toHaveLength(0)
    expect(h.cache.size()).toBe(0)
  })
})

describe("guest rsvp: the SMS channel is gated and cost-capped", () => {
  it("refuses SMS when the deployment switch is off, and email still works", async () => {
    const h = build({ smsGuestEnabled: false })

    await expect(h.service.requestCode(smsRequest(), ctx)).rejects.toMatchObject({
      code: "CONFLICT",
      fields: { channel: "sms_unavailable" },
    })
    expect(h.sms.sent).toHaveLength(0)

    await expect(h.service.requestCode(emailRequest(), ctx)).resolves.toMatchObject({ sent: true })
  })

  it("sends a text with the STOP disclosure when the switch is on", async () => {
    const h = build({ smsGuestEnabled: true })
    await h.service.requestCode(smsRequest(), ctx)

    expect(h.sms.sent).toHaveLength(1)
    expect(h.sms.sent[0]?.to).toBe("+15552223333")
    expect(h.sms.sent[0]?.body).toContain(CODE)
    expect(h.sms.sent[0]?.body).toContain("Reply STOP to opt out")
  })

  it("refuses a number on the STOP suppression list", async () => {
    const h = build({ smsGuestEnabled: true })
    h.repo.optOuts.add("+15552223333")

    await expect(h.service.requestCode(smsRequest(), ctx)).rejects.toMatchObject({
      code: "CONFLICT",
      fields: { channel: "sms_opted_out" },
    })
    expect(h.sms.sent).toHaveLength(0)
  })

  it("records the opt-out when the provider reports one, so we never text that number again", async () => {
    const optedOut = new FakeSmsSender()
    optedOut.send = () => Promise.reject(smsFailure("opted_out", "recipient opted out"))
    const h = build({ smsGuestEnabled: true, sms: optedOut })

    await expect(h.service.requestCode(smsRequest(), ctx)).rejects.toMatchObject({
      fields: { channel: "sms_opted_out" },
    })
    expect(h.repo.optOuts.has("+15552223333")).toBe(true)
  })

  it("fails CLOSED at the global daily cap, leaving email unaffected", async () => {
    const h = build({ smsGuestEnabled: true, smsDailyCap: 1 })

    await expect(h.service.requestCode(smsRequest(), ctx)).resolves.toMatchObject({ sent: true })
    h.advance(61_000)
    await expect(
      h.service.requestCode(smsRequest({ phone: "+15554445555" }), ctx),
    ).rejects.toMatchObject({ code: "CONFLICT", fields: { channel: "sms_unavailable" } })
    expect(h.sms.sent).toHaveLength(1)

    await expect(h.service.requestCode(emailRequest(), ctx)).resolves.toMatchObject({ sent: true })
  })

  it("fails CLOSED when the counter store itself is unreachable", async () => {
    const broken: CounterStore = {
      incr: () => Promise.reject(new Error("redis is down")),
      incrBy: () => Promise.reject(new Error("redis is down")),
    }
    const h = build({ smsGuestEnabled: true, counters: broken })

    await expect(h.service.requestCode(smsRequest(), ctx)).rejects.toMatchObject({
      code: "CONFLICT",
      fields: { channel: "sms_unavailable" },
    })
    expect(h.sms.sent).toHaveLength(0)
  })
})

describe("guest rsvp: verifying a code", () => {
  let h: Harness
  beforeEach(async () => {
    h = build()
    await h.service.requestCode(emailRequest(), ctx)
  })

  it("joins the event, returns the raw manage token once, and counts the guest in going", async () => {
    const result = await h.service.verifyCode(emailVerify(), ctx)

    expect(result.joined).toBe(true)
    expect(result.going).toBe(4)
    expect(result.manageToken.length).toBeGreaterThanOrEqual(20)
    expect(h.repo.guests).toHaveLength(1)
    expect(h.repo.guests[0]?.name).toBe("Ada Lovelace")
    expect(h.repo.guests[0]?.manageTokenHash).not.toBe(result.manageToken)
  })

  it("sends a confirmation carrying the tokenized cancel link", async () => {
    const result = await h.service.verifyCode(emailVerify(), ctx)
    const confirmation = h.mailer.sent.at(-1)

    expect(String(confirmation?.vars?.message)).toContain(
      `https://civfix.org/guest?token=${encodeURIComponent(result.manageToken)}`,
    )
  })

  it("rejects a wrong code without joining, naming the reason in fields", async () => {
    await expect(h.service.verifyCode(emailVerify({ code: "000000" }), ctx)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      fields: { [GUEST_OTP_ERROR_FIELD]: GuestOtpErrorReason.invalidCode },
    })
    expect(h.repo.guests).toHaveLength(0)
  })

  it("rejects an absent or expired code as invalid_code, not as a generic failure", async () => {
    const fresh = build()
    await expect(fresh.service.verifyCode(emailVerify(), ctx)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      fields: { [GUEST_OTP_ERROR_FIELD]: GuestOtpErrorReason.invalidCode },
    })
  })

  it("burns the code after three wrong attempts, and the burning attempt says start over", async () => {
    for (let i = 0; i < 2; i++) {
      await expect(
        h.service.verifyCode(emailVerify({ code: "000000" }), ctx),
      ).rejects.toMatchObject({
        code: "UNAUTHORIZED",
        fields: { [GUEST_OTP_ERROR_FIELD]: GuestOtpErrorReason.invalidCode },
      })
    }
    await expect(h.service.verifyCode(emailVerify({ code: "000000" }), ctx)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      fields: { [GUEST_OTP_ERROR_FIELD]: GuestOtpErrorReason.attemptsExhausted },
    })
    await expect(h.service.verifyCode(emailVerify(), ctx)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      fields: { [GUEST_OTP_ERROR_FIELD]: GuestOtpErrorReason.invalidCode },
    })
    expect(h.repo.guests).toHaveLength(0)
  })


  it("refuses to join when the single-use consume is lost to a concurrent verify", async () => {
    h.repo.markOtpConsumed = () => Promise.resolve(false)

    await expect(h.service.verifyCode(emailVerify(), ctx)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    })
    expect(h.repo.guests).toHaveLength(0)
  })

  it("is idempotent: re-verifying rotates the manage token onto the SAME guest row", async () => {
    const first = await h.service.verifyCode(emailVerify(), ctx)
    h.advance(61_000)
    await h.service.requestCode(emailRequest(), ctx)
    const second = await h.service.verifyCode(emailVerify(), ctx)

    expect(h.repo.guests).toHaveLength(1)
    expect(second.manageToken).not.toBe(first.manageToken)
    expect(second.going).toBe(4)
  })

  it("accepts the reviewer long code for the reviewer contact only, sending nothing", async () => {
    const fresh = build()
    const result = await fresh.service.verifyCode(
      emailVerify({ email: REVIEWER_EMAIL, code: REVIEWER_CODE }),
      ctx,
    )
    expect(result.joined).toBe(true)
    expect(fresh.mailer.sent).toHaveLength(0)
    expect(fresh.sms.sent).toHaveLength(0)

    await expect(
      h.service.verifyCode(emailVerify({ email: "someone@example.org", code: REVIEWER_CODE }), ctx),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" })
  })

  it("does not let the reviewer bypass attach an arbitrary phone number", async () => {
    const sms = build({ smsGuestEnabled: true })
    await expect(
      sms.service.verifyCode(
        {
          id: EVENT_ID,
          channel: "sms",
          phone: "+15559998888",
          code: REVIEWER_CODE,
        } as GuestRsvpVerifyRequest,
        ctx,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" })
    expect(sms.repo.guests).toHaveLength(0)
  })
})

describe("guest rsvp: cancelling", () => {
  it("cancels once, drops the contact, and is idempotent on replay", async () => {
    const h = build()
    await h.service.requestCode(emailRequest(), ctx)
    const { manageToken } = await h.service.verifyCode(emailVerify(), ctx)

    await expect(h.service.cancelRsvp(manageToken)).resolves.toEqual({ ok: true })
    const guest = h.repo.guests[0]
    expect(guest?.cancelledAt).not.toBeNull()
    expect(guest?.email).toBeNull()
    expect(guest?.contactKey).toBeNull()

    await expect(h.service.cancelRsvp(manageToken)).resolves.toEqual({ ok: true })
    expect(h.repo.guests).toHaveLength(1)
  })

  it("404s an unknown token without revealing anything about it", async () => {
    const h = build()
    await expect(h.service.cancelRsvp("not-a-real-manage-token-value")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("reports the registration outcome when the event has no seat left", async () => {
    const h = build({
      registrations: {
        register: () =>
          Promise.resolve({ outcome: "full" as const, registration: null, ticketTokens: [] }),
      },
    })
    await h.service.requestCode(emailRequest(), ctx)
    const verified = await h.service.verifyCode(emailVerify(), ctx)

    expect(verified.joined).toBe(true)
    expect(verified.registration).toBeNull()
    expect(verified.registrationOutcome).toBe("full")
  })

  it("refuses a stale consent version before the code is ever sent", async () => {
    const consent = {
      termsVersion: "1900-01-01",
      disclosureVersion: "1900-01-01",
      hostContactOptIn: true,
    }
    const h = build({
      registrations: {
        register: () =>
          Promise.resolve({ outcome: "registered" as const, registration: null, ticketTokens: [] }),
        assertInputValid: () =>
          Promise.reject(AppError.validation({ "consent.termsVersion": "out of date" })),
      },
    })

    await expect(
      h.service.requestCode(emailRequest({ consent } as never), ctx),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    expect(h.repo.otps).toHaveLength(0)
  })

  it("refuses a stale consent version before the otp is consumed, never joined:true", async () => {
    const consent = {
      termsVersion: "1900-01-01",
      disclosureVersion: "1900-01-01",
      hostContactOptIn: true,
    }
    let valid = true
    const h = build({
      registrations: {
        register: () =>
          Promise.resolve({ outcome: "registered" as const, registration: null, ticketTokens: [] }),
        assertInputValid: () =>
          valid
            ? Promise.resolve()
            : Promise.reject(AppError.validation({ "consent.termsVersion": "out of date" })),
      },
    })

    await h.service.requestCode(emailRequest(), ctx)
    valid = false
    await expect(
      h.service.verifyCode(emailVerify({ consent } as never), ctx),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    expect(h.repo.otps[0]?.consumedAt ?? null).toBeNull()
    expect(h.repo.guests).toHaveLength(0)
  })

  it("re-offers the freed seats to the waitlist when a guest cancels", async () => {
    const enqueued: { name: string; data: unknown }[] = []
    const h = build({
      jobs: {
        enqueue: (name, data) => {
          enqueued.push({ name, data })
          return Promise.resolve("job")
        },
        schedule: () => Promise.resolve(),
        work: () => Promise.resolve(),
        complete: () => Promise.resolve(),
        fail: () => Promise.resolve(),
      },
    })
    await h.service.requestCode(emailRequest(), ctx)
    const { manageToken } = await h.service.verifyCode(emailVerify(), ctx)
    h.repo.releaseOnCancel = ["11111111-1111-4111-8111-111111111111"]

    await h.service.cancelRsvp(manageToken)

    expect(enqueued).toEqual([
      {
        name: "waitlist.promote",
        data: { ticketTypeId: "11111111-1111-4111-8111-111111111111" },
      },
    ])
  })

  it("removes the guest from going once cancelled", async () => {
    const h = build()
    await h.service.requestCode(emailRequest(), ctx)
    const { manageToken, going } = await h.service.verifyCode(emailVerify(), ctx)
    expect(going).toBe(4)

    await h.service.cancelRsvp(manageToken)
    await expect(h.repo.goingCount(EVENT_ID)).resolves.toBe(3)
    expect(h.repo.activeGuestCount(EVENT_ID)).toBe(0)
  })
})

describe("guest rsvp: the host roster", () => {
  async function seedGuest(h: Harness, email: string): Promise<string> {
    await h.service.requestCode(emailRequest({ email }), ctx)
    const { manageToken } = await h.service.verifyCode(emailVerify({ email }), ctx)
    h.advance(61_000)
    return manageToken
  }

  it("is visible to the organizer and to a cohost", async () => {
    const h = build()
    await seedGuest(h, "ada@example.org")

    const asHost = await h.service.listGuests({ id: EVENT_ID }, HOST_ID)
    expect(asHost.guests).toHaveLength(1)
    expect(asHost.count).toBe(1)
    expect(asHost.guests[0]?.email).toBe("ada@example.org")

    h.roles.set(MEMBER_ID, "cohost")
    await expect(h.service.listGuests({ id: EVENT_ID }, MEMBER_ID)).resolves.toMatchObject({
      count: 1,
    })
  })

  it("is FORBIDDEN to a plain member and to a non-member", async () => {
    const h = build()
    await seedGuest(h, "ada@example.org")

    h.roles.set(MEMBER_ID, "member")
    await expect(h.service.listGuests({ id: EVENT_ID }, MEMBER_ID)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(h.service.listGuests({ id: EVENT_ID }, randomUUID())).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })

  it("lists cancelled guests with null contact, and counts only the active ones", async () => {
    const h = build()
    const token = await seedGuest(h, "ada@example.org")
    await seedGuest(h, "grace@example.org")
    await h.service.cancelRsvp(token)

    const page = await h.service.listGuests({ id: EVENT_ID }, HOST_ID)
    expect(page.guests).toHaveLength(2)
    expect(page.count).toBe(1)
    const cancelled = page.guests.find((g) => g.cancelledAt !== null)
    expect(cancelled?.email).toBeNull()
    expect(cancelled?.phone).toBeNull()
  })

  it("returns scrubbed contacts as null once retention has run", async () => {
    const h = build()
    await seedGuest(h, "ada@example.org")
    h.repo.seedEvent({ id: EVENT_ID, scheduledAt: new Date(Date.parse("2026-01-01T00:00:00.000Z")) })

    const result = await h.service.runRetentionSweep()
    expect(result.scrubbedGuests).toBe(1)

    const page = await h.service.listGuests({ id: EVENT_ID }, HOST_ID)
    expect(page.guests[0]?.email).toBeNull()
    expect(page.guests[0]?.cancelledAt).toBeNull()
  })

  it("pages newest-first with a keyset cursor", async () => {
    const h = build()
    await seedGuest(h, "a@example.org")
    await seedGuest(h, "b@example.org")
    await seedGuest(h, "c@example.org")

    const first = await h.service.listGuests({ id: EVENT_ID, limit: 2 }, HOST_ID)
    expect(first.guests).toHaveLength(2)
    expect(first.guests[0]?.email).toBe("c@example.org")
    expect(first.nextCursor).not.toBeNull()

    const second = await h.service.listGuests(
      { id: EVENT_ID, limit: 2, cursor: first.nextCursor as string },
      HOST_ID,
    )
    expect(second.guests).toHaveLength(1)
    expect(second.guests[0]?.email).toBe("a@example.org")
    expect(second.nextCursor).toBeNull()
    expect(second.count).toBe(3)
  })
})

describe("guest rsvp: retention", () => {
  it("scrubs contact for a finished event and reaps guest OTPs older than 24h", async () => {
    const h = build()
    await h.service.requestCode(emailRequest(), ctx)
    await h.service.verifyCode(emailVerify(), ctx)

    h.repo.seedEvent({ id: EVENT_ID, scheduledAt: new Date(Date.parse("2026-01-01T00:00:00.000Z")) })
    h.advance(25 * 60 * 60 * 1000)

    const result = await h.service.runRetentionSweep()
    expect(result).toEqual({ scrubbedGuests: 1, deletedOtps: 1 })

    const guest = h.repo.guests[0]
    expect(guest?.email).toBeNull()
    expect(guest?.contactKey).toBeNull()
    expect(guest?.contactScrubbedAt).not.toBeNull()
    expect(guest?.cancelledAt).toBeNull()
    expect(h.repo.otps).toHaveLength(0)
  })

  it("leaves an upcoming event's guests alone", async () => {
    const h = build()
    await h.service.requestCode(emailRequest(), ctx)
    await h.service.verifyCode(emailVerify(), ctx)

    const result = await h.service.runRetentionSweep()
    expect(result.scrubbedGuests).toBe(0)
    expect(h.repo.guests[0]?.email).toBe("ada@example.org")
  })
})

describe("guest rsvp: SMS title truncation", () => {
  it("truncates a long event title in the CODE text too, not just the confirmation", async () => {
    const h = build({ smsGuestEnabled: true })
    h.repo.seedEvent({
      id: EVENT_ID,
      title: "Annual Ballona Creek Wetlands Restoration and Cleanup Day",
    })

    await h.service.requestCode(smsRequest(), ctx)

    const body = h.sms.sent.at(-1)?.body ?? ""
    expect(body).toContain("...")
    expect(body).not.toContain("Restoration")
    expect(body.length).toBeLessThanOrEqual(160)
  })

  it("keeps the confirmation SMS to one GSM-7 segment when the event title is long", async () => {
    const h = build({ smsGuestEnabled: true, newToken: () => generateToken() })
    h.repo.seedEvent({
      id: EVENT_ID,
      title: "Annual Ballona Creek Wetlands Restoration and Cleanup Day",
    })
    await h.service.requestCode(smsRequest(), ctx)
    await h.service.verifyCode(
      { id: EVENT_ID, channel: "sms", phone: "+15552223333", code: CODE } as GuestRsvpVerifyRequest,
      ctx,
    )

    const body = h.sms.sent.at(-1)?.body ?? ""
    expect(body).toContain("Annual Ballona Creek")
    expect(body).toContain("...")
    expect(body).not.toContain("Restoration")
    expect(body).toContain("Reply STOP to opt out")
    expect(body.length).toBeLessThanOrEqual(160)
  })

  it("leaves a short event title intact in the confirmation SMS", async () => {
    const h = build({ smsGuestEnabled: true })
    await h.service.requestCode(smsRequest(), ctx)
    await h.service.verifyCode(
      { id: EVENT_ID, channel: "sms", phone: "+15552223333", code: CODE } as GuestRsvpVerifyRequest,
      ctx,
    )

    const body = h.sms.sent.at(-1)?.body ?? ""
    expect(body).toContain("Beach cleanup")
    expect(body).not.toContain("...")
  })

})

describe("going: members plus verified, non-cancelled guests", () => {
  it("agrees across the cleanup repository once a guest source is wired", async () => {
    const cleanups = new InMemoryCleanupRepository()
    const guests = new InMemoryGuestRsvpRepository()
    cleanups.guestSource = guests

    const record = await cleanups.createCleanupTx({
      cleanupId: EVENT_ID,
      organizerUserId: HOST_ID,
      type: "site",
      eventKind: "cleanup",
      title: "Beach cleanup",
      description: null,
      lat: 33.99,
      lng: -118.47,
      scheduledAt: new Date(Date.parse("2026-09-01T17:00:00.000Z")),
      status: "upcoming",
      bring: null,
      address: null,
      addressSource: null,
      jurisdictionGeoid: null,
      jurCode: 1,
      linkedReportIds: [],
      slots: [],
      host: { endsAt: new Date(Date.parse("2026-09-01T21:00:00.000Z")) },
    })
    expect(record.record.going).toBe(1)
    expect(record.record.guestCount).toBe(0)

    guests.guests.push(
      {
        id: randomUUID(),
        cleanupId: EVENT_ID,
        name: "Ada",
        channel: "email",
        email: "ada@example.org",
        phone: null,
        contactKey: "ada@example.org",
        manageTokenHash: "h1",
        verifiedAt: new Date(),
        cancelledAt: null,
        contactScrubbedAt: null,
        createdAt: new Date(),
      },
      {
        id: randomUUID(),
        cleanupId: EVENT_ID,
        name: "Grace",
        channel: "email",
        email: null,
        phone: null,
        contactKey: null,
        manageTokenHash: "h2",
        verifiedAt: new Date(),
        cancelledAt: new Date(),
        contactScrubbedAt: new Date(),
        createdAt: new Date(),
      },
    )

    const reread = await cleanups.findCleanupById(EVENT_ID, null)
    expect(reread?.going).toBe(2)
    expect(reread?.guestCount).toBe(1)
    await expect(cleanups.goingCount(EVENT_ID)).resolves.toBe(2)
  })
})

describe("guest rsvp: one global SMS budget covers every outbound text", () => {
  const BUDGET_KEY = `${SMS_BUDGET_KEY_PREFIX}2026-08-25`

  it("does not burn global budget on a request the throttles refuse", async () => {
    const h = build({ smsGuestEnabled: true, smsDailyCap: 2 })

    await h.service.requestCode(smsRequest(), ctx)
    await expect(h.service.requestCode(smsRequest(), ctx)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
    expect(h.counters.peek(BUDGET_KEY)).toBe(1)

    h.advance(61_000)
    await expect(h.service.requestCode(smsRequest(), ctx)).resolves.toMatchObject({ sent: true })
    expect(h.sms.sent).toHaveLength(2)
  })

  it("charges the confirmation text to the same budget as the code", async () => {
    const h = build({ smsGuestEnabled: true, smsDailyCap: 50 })

    await h.service.requestCode(smsRequest(), ctx)
    await h.service.verifyCode(
      { id: EVENT_ID, channel: "sms", phone: "+15552223333", code: CODE } as GuestRsvpVerifyRequest,
      ctx,
    )

    expect(h.counters.peek(BUDGET_KEY)).toBe(2)
    expect(h.sms.sent).toHaveLength(2)
  })

  it("keeps the RSVP when the budget refuses the confirmation text", async () => {
    const h = build({ smsGuestEnabled: true, smsDailyCap: 1 })

    await h.service.requestCode(smsRequest(), ctx)
    const result = await h.service.verifyCode(
      { id: EVENT_ID, channel: "sms", phone: "+15552223333", code: CODE } as GuestRsvpVerifyRequest,
      ctx,
    )

    expect(result.joined).toBe(true)
    expect(h.repo.guests).toHaveLength(1)
    expect(h.sms.sent).toHaveLength(1)
  })

  it("releases the per-contact cooldown when the cap refuses the send", async () => {
    const h = build({ smsGuestEnabled: true, smsDailyCap: 0 })

    await expect(h.service.requestCode(smsRequest(), ctx)).rejects.toMatchObject({
      fields: { channel: "sms_unavailable" },
    })
    await expect(h.service.requestCode(emailRequest(), ctx)).resolves.toMatchObject({ sent: true })
  })
})

describe("guest rsvp: retention drains rather than shaving one batch", () => {
  it("keeps paging until the backlog is gone", async () => {
    const h = build()
    h.repo.seedEvent({ id: EVENT_ID, scheduledAt: new Date(Date.parse("2026-01-01T00:00:00.000Z")) })
    for (let i = 0; i < 1200; i++) {
      h.repo.guests.push({
        id: randomUUID(),
        cleanupId: EVENT_ID,
        name: `Guest ${i}`,
        channel: "email",
        email: `g${i}@example.org`,
        phone: null,
        contactKey: `g${i}@example.org`,
        manageTokenHash: `drain-${i}`,
        verifiedAt: new Date(),
        cancelledAt: null,
        contactScrubbedAt: null,
        createdAt: new Date(),
      })
    }

    const result = await h.service.runRetentionSweep()
    expect(result.scrubbedGuests).toBe(1200)
    expect(h.repo.guests.every((g) => g.email === null)).toBe(true)
  })

  it("keeps reaping OTPs even when the contact scrub lane throws", async () => {
    const h = build()
    h.repo.scrubExpiredGuestContacts = () => Promise.reject(new Error("scrub exploded"))
    await h.service.requestCode(emailRequest(), ctx)
    h.advance(25 * 60 * 60 * 1000)

    const result = await h.service.runRetentionSweep()
    expect(result.scrubbedGuests).toBe(0)
    expect(result.deletedOtps).toBe(1)
  })
})

describe("guest rsvp: the SMS half of the cancel/update notice", () => {
  async function withSmsGuest(): Promise<Harness> {
    const h = build({ smsGuestEnabled: true })
    await h.service.requestCode(smsRequest(), ctx)
    await h.service.verifyCode(
      { id: EVENT_ID, channel: "sms", phone: "+15552223333", code: CODE } as GuestRsvpVerifyRequest,
      ctx,
    )
    h.mailer.sent.length = 0
    h.sms.reset()
    return h
  }

  it("texts an SMS-only guest that the event was cancelled — the broadcast pipeline cannot see them", async () => {
    const h = await withSmsGuest()
    const sent = await h.service.notifyGuestsBySms(EVENT_ID, "cancelled")
    expect(sent).toBe(1)
    expect(h.sms.sent).toHaveLength(1)
    expect(h.sms.sent[0]?.to).toBe("+15552223333")
    expect(h.sms.sent[0]?.body).toContain("cancelled")
    expect(h.mailer.sent).toHaveLength(0)
  })

  it("leaves an EMAIL guest to the broadcast pipeline rather than texting them", async () => {
    const h = build({ smsGuestEnabled: true })
    await h.service.requestCode(emailRequest(), ctx)
    await h.service.verifyCode(emailVerify(), ctx)
    h.sms.reset()

    expect(await h.service.notifyGuestsBySms(EVENT_ID, "cancelled")).toBe(0)
    expect(h.sms.sent).toHaveLength(0)
  })

  it("is inert while the guest SMS channel is switched off", async () => {
    const h = build({ smsGuestEnabled: false })
    expect(await h.service.notifyGuestsBySms(EVENT_ID, "cancelled")).toBe(0)
    expect(h.sms.sent).toHaveLength(0)
  })

  it("lets a roster-read failure ESCAPE the cancellation so pg-boss redelivers", async () => {
    const h = await withSmsGuest()
    h.repo.listContactableGuests = () => Promise.reject(new Error("db down"))
    await expect(h.service.notifyGuestsBySms(EVENT_ID, "cancelled")).rejects.toThrow("db down")
  })

  it("suppresses a roster-read failure on the UPDATE lane, which is best-effort", async () => {
    const h = await withSmsGuest()
    h.repo.listContactableGuests = () => Promise.reject(new Error("db down"))
    await expect(h.service.notifyGuestsBySms(EVENT_ID, "updated")).resolves.toBe(0)
  })

  it("prints the new time in Pacific Time, not as a raw ISO timestamp", async () => {
    const h = await withSmsGuest()
    h.repo.seedEvent({
      id: EVENT_ID,
      scheduledAt: new Date(Date.parse("2026-09-05T17:00:00.000Z")),
      timezone: "America/Los_Angeles",
    })

    expect(await h.service.notifyGuestsBySms(EVENT_ID, "updated")).toBe(1)
    const body = h.sms.sent[0]?.body ?? ""
    expect(body).toContain(
      formatEventWhen(
        new Date(Date.parse("2026-09-05T17:00:00.000Z")),
        "America/Los_Angeles",
      ),
    )
    expect(body).toContain("10:00 AM PDT")
    expect(body).not.toContain("2026-09-05T17:00:00.000Z")
  })

  it("falls back to Pacific Time when the event carries no timezone", async () => {
    const h = await withSmsGuest()
    h.repo.seedEvent({
      id: EVENT_ID,
      scheduledAt: new Date(Date.parse("2026-09-05T17:00:00.000Z")),
      timezone: null,
    })

    expect(await h.service.notifyGuestsBySms(EVENT_ID, "updated")).toBe(1)
    expect(h.sms.sent[0]?.body ?? "").toContain("10:00 AM PDT")
  })

  it("records an opt-out reported mid-send without failing the notice", async () => {
    const h = await withSmsGuest()
    h.sms.send = () => Promise.reject(smsFailure("opted_out", "recipient opted out"))
    await expect(h.service.notifyGuestsBySms(EVENT_ID, "cancelled")).resolves.toBe(0)
    expect(h.repo.optOuts.has("+15552223333")).toBe(true)
  })
})
