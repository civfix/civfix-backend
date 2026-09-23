import { describe, expect, it, vi } from "vitest"
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
  GUEST_REGISTRATION_ERROR_FIELD,
  makeGuestRsvpService,
  type GuestRegistrationBridge,
  type GuestRegistrationGate,
} from "../../src/services/guest-rsvp-service.js"

const EVENT_ID = "11111111-1111-1111-1111-111111111111"
const PUBLIC_TYPE = "22222222-2222-2222-2222-222222222222"
const CODE_TYPE = "33333333-3333-3333-3333-333333333333"
const CODE = "424242"
const NOW = Date.parse("2026-08-25T12:00:00.000Z")
const ctx = { ip: "203.0.113.10" }

function refusal(
  outcome: RegisterForEventResponse["outcome"],
  extra: Partial<RegisterForEventResponse> = {},
): RegisterForEventResponse {
  return { outcome, registration: null, ticketTokens: [], ...extra }
}

function openGate(overrides: Partial<GuestRegistrationGate> = {}): GuestRegistrationGate {
  return {
    registrationOpensAt: null,
    registrationClosesAt: null,
    ticketTypes: [
      { id: PUBLIC_TYPE, visibility: "public", salesOpensAt: null, salesClosesAt: null },
      { id: CODE_TYPE, visibility: "access_code", salesOpensAt: null, salesClosesAt: null },
    ],
    ...overrides,
  }
}

interface BuildOptions {
  register?: GuestRegistrationBridge["register"]
  gate?: GuestRegistrationBridge["registrationGate"]
}

function build(opts: BuildOptions = {}) {
  let clock = NOW
  const now = (): number => clock
  const repo = new InMemoryGuestRsvpRepository({ now })
  repo.seedEvent({ id: EVENT_ID, title: "Beach cleanup" })
  const mailer = new FakeMailer()
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
  const registrations: GuestRegistrationBridge = {
    register: opts.register ?? (() => Promise.resolve(refusal("registered"))),
    ...(opts.gate !== undefined ? { registrationGate: opts.gate } : {}),
  }
  const service = makeGuestRsvpService({
    repo,
    mailer,
    smsSender: new FakeSmsSender(),
    abuseChecks: new FakeAbuseChecks(),
    cache: new InMemoryCacheClient(now),
    counters: new InMemoryCounterStore(now),
    requireGuestContact: () => Promise.resolve(),
    registrations,
    smsGuestEnabled: false,
    smsDailyCap: 50,
    manageLinkBase: "https://civfix.org",
    now,
    newCode: () => CODE,
    newToken: () => `manage-token-${randomUUID()}`,
    logger,
  })
  return {
    service,
    repo,
    mailer,
    logger,
    advance(ms: number) {
      clock += ms
    },
  }
}

function request(extra: Partial<GuestRsvpRequestRequest> = {}): GuestRsvpRequestRequest {
  return {
    id: EVENT_ID,
    name: "Ada Lovelace",
    channel: "email",
    email: "ada@example.org",
    turnstileToken: "ok",
    ...extra,
  } as GuestRsvpRequestRequest
}

function verify(extra: Partial<GuestRsvpVerifyRequest> = {}): GuestRsvpVerifyRequest {
  return {
    id: EVENT_ID,
    channel: "email",
    email: "ada@example.org",
    code: CODE,
    ...extra,
  } as GuestRsvpVerifyRequest
}

function codesSent(mailer: FakeMailer): number {
  return mailer.sent.filter((m) => m.template === "guest_otp").length
}

describe("guest verify refusals carry a machine subcode the clients can map to their own copy", () => {
  it.each([
    ["full", "CONFLICT", "sold_out"],
    ["waitlisted", "CONFLICT", "sold_out"],
    ["registration_closed", "CONFLICT", "registration_closed"],
    ["sales_closed", "CONFLICT", "sales_closed"],
    ["closed", "CONFLICT", "event_closed"],
    ["party_too_large", "VALIDATION", "party_too_large"],
    ["ticket_type_not_found", "VALIDATION", "ticket_type_unavailable"],
    ["access_code_required", "VALIDATION", "access_code_required"],
    ["access_code_invalid", "VALIDATION", "access_code_invalid"],
  ] as const)("a %s refusal answers %s with reason %s", async (outcome, code, reason) => {
    const h = build({ register: () => Promise.resolve(refusal(outcome)) })
    await h.service.requestCode(request(), ctx)

    await expect(h.service.verifyCode(verify(), ctx)).rejects.toMatchObject({
      code,
      fields: expect.objectContaining({ [GUEST_REGISTRATION_ERROR_FIELD]: reason }),
    })
  })

  it("keeps the per-question hints beside the subcode on an answers refusal", async () => {
    const h = build({
      register: () =>
        Promise.resolve(refusal("answers_invalid", { fields: { "answers.q1": "required" } })),
    })
    await h.service.requestCode(request(), ctx)

    await expect(h.service.verifyCode(verify(), ctx)).rejects.toMatchObject({
      code: "VALIDATION",
      fields: { "answers.q1": "required", [GUEST_REGISTRATION_ERROR_FIELD]: "answers_invalid" },
    })
  })

  it("gives a host ban no subcode, so it still reads exactly like an unknown event", async () => {
    const h = build({ register: () => Promise.resolve(refusal("banned")) })
    await h.service.requestCode(request(), ctx)

    const err = await h.service.verifyCode(verify(), ctx).catch((e: unknown) => e)

    expect(err).toMatchObject({ code: "NOT_FOUND" })
    expect(
      (err as { fields?: Record<string, string> }).fields?.[GUEST_REGISTRATION_ERROR_FIELD],
    ).toBe(undefined)
  })
})

describe("guest code request refuses a registration it already knows is doomed", () => {
  it("sends no code for an access-code ticket type when the guest supplied no access code", async () => {
    const h = build({ gate: () => Promise.resolve(openGate()) })

    await expect(
      h.service.requestCode(request({ ticketTypeId: CODE_TYPE }), ctx),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      fields: expect.objectContaining({
        accessCode: expect.any(String),
        [GUEST_REGISTRATION_ERROR_FIELD]: "access_code_required",
      }),
    })
    expect(codesSent(h.mailer)).toBe(0)
    expect(h.repo.otps).toHaveLength(0)
  })

  it("sends no code once the selected ticket type's sales have closed", async () => {
    const h = build({
      gate: () =>
        Promise.resolve(
          openGate({
            ticketTypes: [
              {
                id: PUBLIC_TYPE,
                visibility: "public",
                salesOpensAt: null,
                salesClosesAt: new Date(NOW - 1000),
              },
            ],
          }),
        ),
    })

    await expect(
      h.service.requestCode(request({ ticketTypeId: PUBLIC_TYPE }), ctx),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      fields: { [GUEST_REGISTRATION_ERROR_FIELD]: "sales_closed" },
    })
    expect(codesSent(h.mailer)).toBe(0)
  })

  it("applies the lone ticket type when the guest selected none, as registration does", async () => {
    const h = build({
      gate: () =>
        Promise.resolve(
          openGate({
            ticketTypes: [
              { id: CODE_TYPE, visibility: "access_code", salesOpensAt: null, salesClosesAt: null },
            ],
          }),
        ),
    })

    await expect(h.service.requestCode(request(), ctx)).rejects.toMatchObject({
      fields: expect.objectContaining({
        [GUEST_REGISTRATION_ERROR_FIELD]: "access_code_required",
      }),
    })
  })

  it("sends no code once the event's registration window has closed", async () => {
    const h = build({
      gate: () => Promise.resolve(openGate({ registrationClosesAt: new Date(NOW - 1000) })),
    })

    await expect(
      h.service.requestCode(request({ ticketTypeId: PUBLIC_TYPE }), ctx),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      fields: { [GUEST_REGISTRATION_ERROR_FIELD]: "registration_closed" },
    })
    expect(codesSent(h.mailer)).toBe(0)
  })

  it("still sends a code when the guest supplied an access code, leaving its check to verify", async () => {
    const h = build({ gate: () => Promise.resolve(openGate()) })

    await h.service.requestCode(request({ ticketTypeId: CODE_TYPE, accessCode: "SECRET" }), ctx)

    expect(codesSent(h.mailer)).toBe(1)
  })

  it("still sends a code when several types exist and none was selected, leaving it to verify", async () => {
    const h = build({ gate: () => Promise.resolve(openGate()) })

    await h.service.requestCode(request(), ctx)

    expect(codesSent(h.mailer)).toBe(1)
  })

  it("refuses a guest who already holds the RSVP the same way, so it never reveals who is listed", async () => {
    let gate = openGate()
    const h = build({ gate: () => Promise.resolve(gate) })
    await h.service.requestCode(request({ ticketTypeId: PUBLIC_TYPE }), ctx)
    await h.service.verifyCode(verify({ ticketTypeId: PUBLIC_TYPE }), ctx)

    gate = openGate({ registrationClosesAt: new Date(NOW) })
    h.advance(61_000)
    const returning = await h.service
      .requestCode(request({ ticketTypeId: PUBLIC_TYPE }), ctx)
      .catch((e: unknown) => e)
    const stranger = await h.service
      .requestCode(request({ ticketTypeId: PUBLIC_TYPE, email: "grace@example.org" }), ctx)
      .catch((e: unknown) => e)

    expect(returning).toMatchObject({ code: "CONFLICT" })
    const shape = (e: unknown) => {
      const { code, message, fields } = e as { code: string; message: string; fields?: unknown }
      return { code, message, fields }
    }
    expect(shape(returning)).toEqual(shape(stranger))
    expect(codesSent(h.mailer)).toBe(1)
  })

  it("sends the code anyway when the gate lookup fails, since verify stays the authority", async () => {
    const h = build({ gate: () => Promise.reject(new Error("db down")) })

    await h.service.requestCode(request({ ticketTypeId: CODE_TYPE }), ctx)

    expect(codesSent(h.mailer)).toBe(1)
    expect(h.logger.warn).toHaveBeenCalledTimes(1)
  })
})

describe("a failed rollback never hides the registration refusal", () => {
  it("answers the mapped refusal and logs the rollback failure when cancelGuest throws", async () => {
    const h = build({ register: () => Promise.resolve(refusal("full")) })
    h.repo.cancelGuest = () => Promise.reject(new Error("cancel failed"))
    await h.service.requestCode(request(), ctx)

    await expect(h.service.verifyCode(verify(), ctx)).rejects.toMatchObject({
      code: "CONFLICT",
      fields: { [GUEST_REGISTRATION_ERROR_FIELD]: "sold_out" },
    })
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ cleanupId: EVENT_ID }),
      expect.stringMatching(/roll/),
    )
  })

  it("rethrows the bridge's own validation error, not the rollback's, when both fail", async () => {
    const h = build({
      register: () => Promise.reject(AppError.validation({ partySize: "too large" })),
    })
    h.repo.cancelGuest = () => Promise.reject(new Error("cancel failed"))
    await h.service.requestCode(request(), ctx)

    await expect(h.service.verifyCode(verify(), ctx)).rejects.toMatchObject({
      code: "VALIDATION",
      fields: { partySize: "too large" },
    })
    expect(h.logger.error).toHaveBeenCalledOnce()
  })
})
