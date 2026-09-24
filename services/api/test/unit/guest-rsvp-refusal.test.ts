import { describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import {
  AppError,
  type GuestRsvpRequestRequest,
  type GuestRsvpVerifyRequest,
  type RegisterForEventResponse,
} from "@civfix/shared"
import { FakeAbuseChecks, FakeMailer, FakeSmsSender } from "@civfix/shared/fakes"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { InMemoryGuestRsvpRepository } from "../helpers/guest-rsvp.js"
import {
  makeGuestRsvpService,
  type GuestRegistrationBridge,
  type UpsertGuestArgs,
} from "../../src/services/guest-rsvp-service.js"

const EVENT_ID = "11111111-1111-1111-1111-111111111111"
const CODE = "424242"
const ctx = { ip: "203.0.113.10" }

function refusal(
  outcome: RegisterForEventResponse["outcome"],
  extra: Partial<RegisterForEventResponse> = {},
): RegisterForEventResponse {
  return { outcome, registration: null, ticketTokens: [], ...extra }
}

function build(register: GuestRegistrationBridge["register"]) {
  let clock = Date.parse("2026-08-25T12:00:00.000Z")
  const now = (): number => clock
  const repo = new InMemoryGuestRsvpRepository({ now })
  repo.seedEvent({ id: EVENT_ID, title: "Beach cleanup" })
  repo.memberCounts.set(EVENT_ID, 3)
  const mailer = new FakeMailer()
  const service = makeGuestRsvpService({
    repo,
    mailer,
    smsSender: new FakeSmsSender(),
    abuseChecks: new FakeAbuseChecks(),
    cache: new InMemoryCacheClient(now),
    counters: new InMemoryCounterStore(now),
    requireGuestContact: () => Promise.resolve(),
    registrations: { register },
    smsGuestEnabled: false,
    smsDailyCap: 50,
    manageLinkBase: "https://civfix.org",
    now,
    newCode: () => CODE,
    newToken: () => `manage-token-${randomUUID()}`,
  })
  return {
    service,
    repo,
    mailer,
    advance(ms: number) {
      clock += ms
    },
  }
}

const request: GuestRsvpRequestRequest = {
  id: EVENT_ID,
  name: "Ada Lovelace",
  channel: "email",
  email: "ada@example.org",
  turnstileToken: "ok",
} as GuestRsvpRequestRequest

const verify: GuestRsvpVerifyRequest = {
  id: EVENT_ID,
  channel: "email",
  email: "ada@example.org",
  code: CODE,
} as GuestRsvpVerifyRequest

function confirmations(mailer: FakeMailer): number {
  return mailer.sent.filter((m) => m.template === "guest_confirmed").length
}

describe("guest rsvp: a refused registration does not leave the guest on the list", () => {
  it("refuses a sold-out event with CONFLICT, counts nobody and confirms nothing", async () => {
    const h = build(() => Promise.resolve(refusal("full")))
    await h.service.requestCode(request, ctx)

    await expect(h.service.verifyCode(verify, ctx)).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(h.repo.countActiveGuests(EVENT_ID)).resolves.toBe(0)
    await expect(h.repo.goingCount(EVENT_ID)).resolves.toBe(3)
    expect(confirmations(h.mailer)).toBe(0)
  })

  it.each([
    ["registration_closed", "CONFLICT"],
    ["sales_closed", "CONFLICT"],
    ["closed", "CONFLICT"],
    ["waitlisted", "CONFLICT"],
    ["party_too_large", "VALIDATION"],
    ["ticket_type_not_found", "VALIDATION"],
    ["access_code_required", "VALIDATION"],
    ["access_code_invalid", "VALIDATION"],
    ["banned", "NOT_FOUND"],
  ] as const)("maps a %s refusal to %s and rolls the new guest back", async (outcome, code) => {
    const h = build(() => Promise.resolve(refusal(outcome)))
    await h.service.requestCode(request, ctx)

    await expect(h.service.verifyCode(verify, ctx)).rejects.toMatchObject({ code })
    await expect(h.repo.countActiveGuests(EVENT_ID)).resolves.toBe(0)
    expect(confirmations(h.mailer)).toBe(0)
  })

  it("carries the bridge's per-question fields on an answers_invalid refusal", async () => {
    const h = build(() =>
      Promise.resolve(refusal("answers_invalid", { fields: { "answers.q1": "required" } })),
    )
    await h.service.requestCode(request, ctx)

    await expect(h.service.verifyCode(verify, ctx)).rejects.toMatchObject({
      code: "VALIDATION",
      fields: { "answers.q1": "required" },
    })
    await expect(h.repo.countActiveGuests(EVENT_ID)).resolves.toBe(0)
  })

  it("rolls the new guest back when the bridge throws VALIDATION, so no uncancellable RSVP is left", async () => {
    const h = build(() => Promise.reject(AppError.validation({ partySize: "too large" })))
    await h.service.requestCode(request, ctx)

    await expect(h.service.verifyCode(verify, ctx)).rejects.toMatchObject({ code: "VALIDATION" })
    await expect(h.repo.countActiveGuests(EVENT_ID)).resolves.toBe(0)
    expect(confirmations(h.mailer)).toBe(0)
  })

  it("still joins when the guest is already registered under this guest row", async () => {
    const h = build(() => Promise.resolve(refusal("already_registered")))
    await h.service.requestCode(request, ctx)

    const result = await h.service.verifyCode(verify, ctx)
    expect(result.joined).toBe(true)
    await expect(h.repo.countActiveGuests(EVENT_ID)).resolves.toBe(1)
    expect(confirmations(h.mailer)).toBe(1)
  })

  it("never cancels an RSVP that existed before this verify, even when the bridge now refuses", async () => {
    let answer: RegisterForEventResponse = refusal("registered")
    const h = build(() => Promise.resolve(answer))
    await h.service.requestCode(request, ctx)
    await h.service.verifyCode(verify, ctx)

    answer = refusal("registration_closed")
    h.advance(61_000)
    await h.service.requestCode(request, ctx)
    const again = await h.service.verifyCode(verify, ctx)

    expect(again.joined).toBe(true)
    expect(again.registrationOutcome).toBe("registration_closed")
    await expect(h.repo.countActiveGuests(EVENT_ID)).resolves.toBe(1)
  })
})

describe("guest rsvp: the stored channel is the one the code was delivered on", () => {
  it("records the OTP's channel even when the verify request names another", async () => {
    const h = build(() => Promise.resolve(refusal("registered")))
    await h.service.requestCode(request, ctx)

    await h.service.verifyCode(
      {
        id: EVENT_ID,
        channel: "sms",
        phone: "ada@example.org",
        code: CODE,
      } as GuestRsvpVerifyRequest,
      ctx,
    )

    expect(h.repo.guests[0]).toMatchObject({
      channel: "email",
      email: "ada@example.org",
      phone: null,
    })
  })
})

describe("the in-memory guest repository reports an insert as the Postgres upsert does", () => {
  const upsert: UpsertGuestArgs = {
    cleanupId: EVENT_ID,
    name: "Ada Lovelace",
    channel: "email",
    contactKey: "ada@example.org",
    email: "ada@example.org",
    phone: null,
    manageTokenHash: "a".repeat(64),
    now: new Date("2026-08-25T12:00:00.000Z"),
  }

  it("marks the first verify as created and a re-verify of the active guest as not", async () => {
    const repo = new InMemoryGuestRsvpRepository()

    const first = await repo.upsertVerifiedGuest(upsert)
    const again = await repo.upsertVerifiedGuest({ ...upsert, manageTokenHash: "b".repeat(64) })

    expect(first.created).toBe(true)
    expect(again).toEqual({ id: first.id, created: false })
  })

  it("creates a fresh row once the earlier guest was cancelled", async () => {
    const repo = new InMemoryGuestRsvpRepository()
    const first = await repo.upsertVerifiedGuest(upsert)
    await repo.cancelGuest(first.id, upsert.now)

    const fresh = await repo.upsertVerifiedGuest(upsert)

    expect(fresh.created).toBe(true)
    expect(fresh.id).not.toBe(first.id)
  })
})
