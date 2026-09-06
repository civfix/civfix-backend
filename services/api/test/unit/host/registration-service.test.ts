import { beforeEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { AppError, currentVersion } from "@civfix/shared"
import type { RegisterForEventRequest } from "@civfix/shared"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { sha256Hex } from "../../../src/auth/crypto.js"
import { InMemoryHostRegistrationRepository } from "../../../src/services/host/registration-repository.memory.js"
import {
  makeRegistrationService,
  walkupIdempotencyKey,
  type RegistrationService,
} from "../../../src/services/host/registration-service.js"
import { makeTicketTokenSigner } from "../../../src/services/host/ticket-token.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const NOW = new Date("2026-01-01T12:00:00.000Z")

const tokens = makeTicketTokenSigner("registration-service-test-secret-long-enough")

interface Harness {
  repo: InMemoryHostRegistrationRepository
  service: RegistrationService
  signals: string[]
  audits: string[]
  notifications: { userId: string; title: string }[]
}

function build(): Harness {
  const repo = new InMemoryHostRegistrationRepository()
  repo.seedEvent({ cleanupId: EVENT })
  const signals: string[] = []
  const audits: string[] = []
  const notifications: { userId: string; title: string }[] = []
  const service = makeRegistrationService({
    repo,
    tokens,
    counters: new InMemoryCounterStore(() => NOW.getTime()),
    now: () => NOW,
    teamUserIds: () => Promise.resolve([OTHER]),
    userChannel: {
      publishToUser: () => Promise.resolve(),
      publishToUsers: (ids, signal) => {
        signals.push(`${signal.topic}:${signal.id ?? ""}:${ids.length}`)
        return Promise.resolve()
      },
      subscribeUser: () => Promise.resolve(() => Promise.resolve()),
      close: () => Promise.resolve(),
    },
    notifier: {
      createNotification: (userId, input) => {
        notifications.push({ userId, title: input.title })
        return Promise.resolve(null)
      },
    },
    audit: (input) => {
      audits.push(input.action)
      return Promise.resolve()
    },
  })
  return { repo, service, signals, audits, notifications }
}

function request(over: Partial<RegisterForEventRequest> = {}): RegisterForEventRequest {
  return {
    id: EVENT,
    idempotencyKey: over.idempotencyKey ?? `key-${randomUUID()}`,
    partySize: 1,
    joinWaitlistIfFull: false,
    ...over,
  }
}

const FULL_PROJECTION = { includeHostNote: true, includeAnswersPreview: true }

describe("registration service", () => {
  let h: Harness

  beforeEach(() => {
    h = build()
  })

  it("registers, mints one ticket token per seat and signals the host team", async () => {
    h.repo.seedTicketType({ cleanupId: EVENT, capacity: 10, maxPartySize: 4 })
    const result = await h.service.register(request({ partySize: 2 }), {
      kind: "user",
      userId: USER,
    })

    expect(result.outcome).toBe("registered")
    expect(result.ticketTokens).toHaveLength(2)
    expect(new Set(result.ticketTokens).size).toBe(2)
    expect(result.registration?.seats).toHaveLength(2)
    expect(h.signals).toEqual(["host:" + EVENT + ":1"])
    expect(h.notifications).toHaveLength(1)
  })

  it("replays the same idempotency key instead of double booking", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 10 })
    const input = request({ idempotencyKey: "stable-key-1234" })
    const first = await h.service.register(input, { kind: "user", userId: USER })
    const second = await h.service.register(input, { kind: "user", userId: USER })

    expect(first.outcome).toBe("registered")
    expect(second.outcome).toBe("replayed")
    expect(second.registration?.id).toBe(first.registration?.id)
    expect(h.repo.ticketTypes.get(type.id)?.reservedSeats).toBe(1)
  })

  it("refuses a second active registration for the same person", async () => {
    h.repo.seedTicketType({ cleanupId: EVENT, capacity: 10 })
    await h.service.register(request(), { kind: "user", userId: USER })
    const again = await h.service.register(request(), { kind: "user", userId: USER })
    expect(again.outcome).toBe("already_registered")
  })

  it("returns full when the capacity is exhausted and reserves nothing", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 1 })
    await h.service.register(request(), { kind: "user", userId: USER })
    const result = await h.service.register(request(), { kind: "user", userId: OTHER })

    expect(result.outcome).toBe("full")
    expect(h.repo.ticketTypes.get(type.id)?.reservedSeats).toBe(1)
  })

  it("moves the caller onto the waitlist when full and asked to", async () => {
    h.repo.seedTicketType({ cleanupId: EVENT, capacity: 1, waitlistEnabled: true })
    const type = [...h.repo.ticketTypes.values()][0]
    await h.service.register(request({ ticketTypeId: type?.id }), { kind: "user", userId: USER })
    const result = await h.service.register(
      request({ ticketTypeId: type?.id, joinWaitlistIfFull: true }),
      { kind: "user", userId: OTHER },
    )

    expect(result.outcome).toBe("waitlisted")
    expect(result.waitlistPosition).toBe(1)
    expect(result.registration).toBeNull()
  })

  it("refuses a party larger than the ticket type allows", async () => {
    h.repo.seedTicketType({ cleanupId: EVENT, maxPartySize: 2 })
    const result = await h.service.register(request({ partySize: 4 }), {
      kind: "user",
      userId: USER,
    })
    expect(result.outcome).toBe("party_too_large")
  })

  it("refuses outside the ticket type sales window", async () => {
    h.repo.seedTicketType({
      cleanupId: EVENT,
      salesClosesAt: new Date(NOW.getTime() - 1000),
    })
    const result = await h.service.register(request(), { kind: "user", userId: USER })
    expect(result.outcome).toBe("sales_closed")
  })

  it("refuses outside the event registration window", async () => {
    h.repo.seedEvent({
      cleanupId: EVENT,
      registrationOpensAt: new Date(NOW.getTime() + 60_000),
    })
    h.repo.seedTicketType({ cleanupId: EVENT })
    const result = await h.service.register(request(), { kind: "user", userId: USER })
    expect(result.outcome).toBe("registration_closed")
  })

  it("refuses a terminal event and a banned attendee", async () => {
    h.repo.seedEvent({ cleanupId: EVENT, status: "cancelled" })
    h.repo.seedTicketType({ cleanupId: EVENT })
    expect((await h.service.register(request(), { kind: "user", userId: USER })).outcome).toBe(
      "closed",
    )

    h.repo.seedEvent({ cleanupId: EVENT, status: "upcoming" })
    h.repo.bans.add(`${EVENT}:${USER}`)
    expect((await h.service.register(request(), { kind: "user", userId: USER })).outcome).toBe(
      "banned",
    )
  })

  it("demands and checks an access code", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, visibility: "access_code" })
    h.repo.setAccessCode(type.id, await sha256Hex("open-sesame"))

    expect(
      (await h.service.register(request({ ticketTypeId: type.id }), { kind: "user", userId: USER }))
        .outcome,
    ).toBe("access_code_required")
    expect(
      (
        await h.service.register(
          request({ ticketTypeId: type.id, accessCode: "wrong-code" }),
          { kind: "user", userId: USER },
        )
      ).outcome,
    ).toBe("access_code_invalid")
    expect(
      (
        await h.service.register(
          request({ ticketTypeId: type.id, accessCode: "open-sesame" }),
          { kind: "user", userId: USER },
        )
      ).outcome,
    ).toBe("registered")
  })

  it("requires a ticket type when the event offers more than one", async () => {
    h.repo.seedTicketType({ cleanupId: EVENT, name: "Morning" })
    h.repo.seedTicketType({ cleanupId: EVENT, name: "Afternoon" })
    const result = await h.service.register(request(), { kind: "user", userId: USER })
    expect(result.outcome).toBe("ticket_type_not_found")
  })

  it("registers with no ticket type at all when the event has none", async () => {
    const result = await h.service.register(request(), { kind: "user", userId: USER })
    expect(result.outcome).toBe("registered")
    expect(result.registration?.ticketTypeId).toBeNull()
  })

  it("returns answers_invalid with per-field detail and writes nothing", async () => {
    h.repo.seedTicketType({ cleanupId: EVENT })
    const questionId = randomUUID()
    await h.repo.reconcileQuestions(
      EVENT,
      [
        {
          id: questionId,
          ticketTypeId: null,
          kind: "short_text",
          prompt: "Shirt size",
          helpText: null,
          required: true,
          options: [],
          maxSelections: null,
          consentText: null,
          showIf: null,
          sortOrder: 0,
        },
      ],
      NOW,
    )

    const result = await h.service.register(request(), { kind: "user", userId: USER })
    expect(result.outcome).toBe("answers_invalid")
    expect(result.fields?.[questionId]).toBe("required")
    expect(h.repo.registrations.size).toBe(0)
  })

  it("rejects a stale consent version rather than storing it", async () => {
    h.repo.seedTicketType({ cleanupId: EVENT })
    await expect(
      h.service.register(
        request({
          consent: {
            termsVersion: "1900-01-01",
            disclosureVersion: currentVersion("privacy"),
            hostContactOptIn: true,
          },
        }),
        { kind: "user", userId: USER },
      ),
    ).rejects.toBeInstanceOf(AppError)
  })

  it("cancels, releases the seats and audits a host-driven removal", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 5 })
    const registered = await h.service.register(request({ partySize: 2 }), {
      kind: "user",
      userId: USER,
    })
    const registrationId = registered.registration?.id as string

    await h.service.cancel({ id: EVENT, registrationId }, USER, true)
    expect(h.repo.ticketTypes.get(type.id)?.reservedSeats).toBe(0)
    expect(h.audits).toContain("event.attendee_removed")

    const again = await h.service.cancel({ id: EVENT, registrationId }, USER, true)
    expect(again.registration).toBeNull()
  })

  it("bans on removal when asked", async () => {
    h.repo.seedTicketType({ cleanupId: EVENT, capacity: 5 })
    const registered = await h.service.register(request(), { kind: "user", userId: USER })
    await h.service.remove(
      { id: EVENT, registrationId: registered.registration?.id as string, ban: true },
      OTHER,
    )
    expect(h.repo.bans.has(`${EVENT}:${USER}`)).toBe(true)
  })

  it("transfers to another ticket type and moves the reservation with it", async () => {
    const from = h.repo.seedTicketType({ cleanupId: EVENT, name: "Morning", capacity: 5 })
    const to = h.repo.seedTicketType({ cleanupId: EVENT, name: "Afternoon", capacity: 5 })
    const registered = await h.service.register(request({ ticketTypeId: from.id, partySize: 2 }), {
      kind: "user",
      userId: USER,
    })

    await h.service.transfer(
      {
        id: EVENT,
        registrationId: registered.registration?.id as string,
        ticketTypeId: to.id,
      },
      OTHER,
    )
    expect(h.repo.ticketTypes.get(from.id)?.reservedSeats).toBe(0)
    expect(h.repo.ticketTypes.get(to.id)?.reservedSeats).toBe(2)
  })

  it("refuses a transfer into a full ticket type", async () => {
    const from = h.repo.seedTicketType({ cleanupId: EVENT, name: "Morning", capacity: 5 })
    const to = h.repo.seedTicketType({ cleanupId: EVENT, name: "Afternoon", capacity: 1 })
    await h.service.register(request({ ticketTypeId: to.id }), { kind: "user", userId: OTHER })
    const registered = await h.service.register(request({ ticketTypeId: from.id }), {
      kind: "user",
      userId: USER,
    })

    await expect(
      h.service.transfer(
        { id: EVENT, registrationId: registered.registration?.id as string, ticketTypeId: to.id },
        OTHER,
      ),
    ).rejects.toBeInstanceOf(AppError)
  })

  it("keeps the host note off the attendee-facing projection and audits the write", async () => {
    h.repo.seedTicketType({ cleanupId: EVENT })
    const registered = await h.service.register(request(), { kind: "user", userId: USER })
    const registrationId = registered.registration?.id as string

    await h.service.setNote({ id: EVENT, registrationId, note: "  brings a truck  " }, OTHER)
    expect(h.repo.registrations.get(registrationId)?.hostNote).toBe("brings a truck")
    expect(h.audits).toContain("event.attendee_note_set")

    expect(registered.registration?.note).toBeUndefined()
  })

  it("audits every roster read and every answers read", async () => {
    h.repo.seedTicketType({ cleanupId: EVENT })
    const registered = await h.service.register(request(), { kind: "user", userId: USER })
    await h.service.listRoster({ id: EVENT }, OTHER, FULL_PROJECTION)
    await h.service.getAnswers(EVENT, registered.registration?.id as string, OTHER)
    expect(h.audits).toContain("event.roster_viewed")
    expect(h.audits).toContain("event.answers_viewed")
  })

  it("registers a walk-up under a server-derived idempotency key and checks it in", async () => {
    h.repo.seedTicketType({ cleanupId: EVENT, capacity: 10, maxPartySize: 4 })
    const result = await h.service.walkup(
      { id: EVENT, name: "Ada", partySize: 2, checkInNow: true },
      OTHER,
    )

    expect(result.outcome).toBe("registered")
    expect(result.registration?.kind).toBe("guest")
    expect(result.registration?.seats.every((seat) => seat.checkedInAt !== null)).toBe(true)
    expect(walkupIdempotencyKey(OTHER, "Ada", 2, NOW)).toBe(
      walkupIdempotencyKey(OTHER, "ada", 2, new Date(NOW.getTime() + 500)),
    )
  })

  it("leaves no guest row behind when a walk-up is refused", async () => {
    h.repo.seedTicketType({ cleanupId: EVENT, capacity: 0 })
    const refused = await h.service.walkup({ id: EVENT, name: "Ada", partySize: 1, checkInNow: false }, OTHER)

    expect(refused.outcome).toBe("full")
    expect(refused.registration).toBeNull()
    expect(h.repo.guests.size).toBe(0)
  })

  it("leaves no guest row behind when a walk-up replays the same minute", async () => {
    h.repo.seedTicketType({ cleanupId: EVENT, capacity: 10, maxPartySize: 4 })
    await h.service.walkup({ id: EVENT, name: "Ada", partySize: 1, checkInNow: false }, OTHER)
    const replay = await h.service.walkup({ id: EVENT, name: "Ada", partySize: 1, checkInNow: false }, OTHER)

    expect(replay.outcome).toBe("replayed")
    expect(h.repo.guests.size).toBe(1)
  })

  it("bans a removed attendee even when the registration was already cancelled", async () => {
    h.repo.seedTicketType({ cleanupId: EVENT, capacity: 10 })
    const registered = await h.service.register(request(), { kind: "user", userId: USER })
    const registrationId = registered.registration?.id as string
    await h.service.cancel({ id: EVENT, registrationId }, USER, false)

    await h.service.remove({ id: EVENT, registrationId, ban: true }, OTHER)

    expect(h.repo.bans.has(`${EVENT}:${USER}`)).toBe(true)
  })

  it("gates an event with no ticket types on the event capacity", async () => {
    h.repo.seedEvent({ cleanupId: EVENT, capacity: 2 })
    const first = await h.service.register(
      request({ partySize: 2 }),
      { kind: "user", userId: USER },
    )
    expect(first.outcome).toBe("registered")

    const second = await h.service.register(request(), { kind: "user", userId: OTHER })
    expect(second.outcome).toBe("full")
  })

  it("persists the consent surface alongside the versions", () => {
    const write = h.service.consentWriteOf({
      termsVersion: currentVersion("terms"),
      disclosureVersion: currentVersion("privacy"),
      hostContactOptIn: true,
      surface: "web_register",
    })
    expect(write?.surface).toBe("web_register")
  })

  it("caps registration flips per identity and fails closed on a broken counter", async () => {
    h.repo.seedTicketType({ cleanupId: EVENT, capacity: 500 })
    for (let i = 0; i < 20; i++) {
      await h.service.register(request(), { kind: "user", userId: USER })
    }
    await expect(h.service.register(request(), { kind: "user", userId: USER })).rejects.toThrow(
      /Too many registration changes/u,
    )

    const broken = makeRegistrationService({
      repo: h.repo,
      tokens,
      now: () => NOW,
      counters: {
        incr: () => Promise.reject(new Error("redis is down")),
        incrBy: () => Promise.reject(new Error("redis is down")),
      },
    })
    await expect(broken.register(request(), { kind: "user", userId: OTHER })).rejects.toThrow(
      /temporarily unavailable/u,
    )
  })
})

describe("registration questions: which questions a registration must answer", () => {
  const GLOBAL_Q = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
  const TIER_Q = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"

  function seedQuestions(h: Harness, ticketTypeId: string): void {
    h.repo.questions.set(GLOBAL_Q, {
      id: GLOBAL_Q,
      cleanupId: EVENT,
      ticketTypeId: null,
      kind: "short_text",
      prompt: "Any access needs?",
      helpText: null,
      required: true,
      options: [],
      maxSelections: null,
      consentText: null,
      showIf: null,
      sortOrder: 0,
      archivedAt: null,
    })
    h.repo.questions.set(TIER_Q, {
      id: TIER_Q,
      cleanupId: EVENT,
      ticketTypeId,
      kind: "short_text",
      prompt: "Which shift can you lead?",
      helpText: null,
      required: true,
      options: [],
      maxSelections: null,
      consentText: null,
      showIf: null,
      sortOrder: 1,
      archivedAt: null,
    })
  }

  it("asks a registration with NO ticket type only the global questions", async () => {
    const h = build()
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 10, maxPartySize: 4 })
    seedQuestions(h, type.id)

    const res = await h.service.register(
      request({ answers: [{ questionId: GLOBAL_Q, value: "step-free access" }] }),
      { kind: "user", userId: USER },
    )

    expect(res.outcome).not.toBe("answers_invalid")
    expect(res.fields).toBeUndefined()
  })

  it("still refuses a registration with no ticket type that skips a GLOBAL required question", async () => {
    const h = build()
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 10, maxPartySize: 4 })
    seedQuestions(h, type.id)

    const res = await h.service.register(request({ answers: [] }), {
      kind: "user",
      userId: USER,
    })

    expect(res.outcome).toBe("answers_invalid")
    expect(res.fields?.[GLOBAL_Q]).toBe("required")
    expect(res.fields?.[TIER_Q]).toBeUndefined()
  })

  it("asks a registration that DID pick a tier both the global and that tier's questions", async () => {
    const h = build()
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 10, maxPartySize: 4 })
    seedQuestions(h, type.id)

    const res = await h.service.register(
      request({
        ticketTypeId: type.id,
        answers: [{ questionId: GLOBAL_Q, value: "none" }],
      }),
      { kind: "user", userId: USER },
    )

    expect(res.outcome).toBe("answers_invalid")
    expect(res.fields?.[TIER_Q]).toBe("required")
  })

  it("refuses an answer to ANOTHER tier's question from a registration with no ticket type", async () => {
    const h = build()
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 10, maxPartySize: 4 })
    seedQuestions(h, type.id)

    const res = await h.service.register(
      request({
        answers: [
          { questionId: GLOBAL_Q, value: "none" },
          { questionId: TIER_Q, value: "morning" },
        ],
      }),
      { kind: "user", userId: USER },
    )

    expect(res.outcome).toBe("answers_invalid")
    expect(res.fields?.[TIER_Q]).toBe("unknown question")
  })
})
