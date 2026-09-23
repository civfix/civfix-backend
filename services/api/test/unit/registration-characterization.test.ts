import { beforeEach, describe, expect, it, vi } from "vitest"
import { avatarGradient, currentVersion } from "@civfix/shared"
import type { RegisterForEventRequest } from "@civfix/shared"
import { InMemoryCounterStore, type CounterStore } from "../../src/abuse/counter-store.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { sha256Hex } from "../../src/auth/crypto.js"
import type { DbHandle } from "../../src/db/client.js"
import { buildContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { insightsGenerationKey } from "../../src/services/host/host-analytics-cache.js"
import { InMemoryHostRegistrationRepository } from "../../src/services/host/registration-repository.memory.js"
import type { RegistrationSubject } from "../../src/services/host/registration-repository.types.js"
import {
  makeRegistrationService,
  type RegistrationService,
} from "../../src/services/host/registration-service.js"
import {
  OPEN_HOST_GUARDS,
  makeContainerRegistrationServices,
  makeHostGuards,
  type HostGuards,
} from "../../src/services/host/registration-wiring.js"
import { makeTicketTokenSigner } from "../../src/services/host/ticket-token.js"
import { makeSqlRecorder } from "../helpers/sql-recorder.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const GUEST = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const TEAM = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const NOW = new Date("2026-01-01T12:00:00.000Z")
const STARTS_AT = new Date("2026-01-08T12:00:00.000Z")
const ENDS_AT = new Date("2026-01-08T15:00:00.000Z")

const tokens = makeTicketTokenSigner("registration-characterization-secret-long-enough")

// The consent messages carry a U+2014 dash; spelled as an escape so this file stays ASCII.
const DASH = "\u2014"

const ME: RegistrationSubject = { kind: "user", userId: USER }

function counterIds(prefix: string): () => string {
  let n = 0
  return () => `${prefix}-${++n}`
}

interface Harness {
  repo: InMemoryHostRegistrationRepository
  service: RegistrationService
  notifications: { userId: string; input: unknown }[]
  signals: { ids: string[]; signal: unknown }[]
  bumped: string[]
  counterKeys: string[]
  warnings: { obj: unknown; msg: string | undefined }[]
}

function build(
  over: { notifierFails?: boolean; counters?: CounterStore; noTeam?: boolean } = {},
): Harness {
  const repo = new InMemoryHostRegistrationRepository(counterIds("rec"))
  repo.seedEvent({ cleanupId: EVENT, scheduledAt: STARTS_AT, endsAt: ENDS_AT })
  const notifications: Harness["notifications"] = []
  const signals: Harness["signals"] = []
  const bumped: string[] = []
  const counterKeys: string[] = []
  const warnings: Harness["warnings"] = []
  const store = new InMemoryCounterStore(() => NOW.getTime())
  const counters: CounterStore = over.counters ?? {
    incr: (key, ttl) => {
      counterKeys.push(`${key}@${ttl}`)
      return store.incr(key, ttl)
    },
    incrBy: (key, by, ttl) => store.incrBy(key, by, ttl),
  }
  const service = makeRegistrationService({
    repo,
    tokens,
    counters,
    now: () => NOW,
    newId: counterIds("seat"),
    logger: { warn: (obj, msg) => warnings.push({ obj, msg }) },
    ...(over.noTeam === true ? {} : { teamUserIds: () => Promise.resolve([TEAM]) }),
    userChannel: {
      publishToUser: () => Promise.resolve(),
      publishToUsers: (ids, signal) => {
        signals.push({ ids: [...ids], signal })
        return Promise.resolve()
      },
      subscribeUser: () => Promise.resolve(() => Promise.resolve()),
      close: () => Promise.resolve(),
    },
    notifier: {
      createNotification: (userId, input) => {
        if (over.notifierFails === true) return Promise.reject(new Error("notify down"))
        notifications.push({ userId, input })
        return Promise.resolve(null)
      },
    },
    insightsInvalidator: {
      bumpInsightsGeneration: (cleanupId) => {
        bumped.push(cleanupId)
        return Promise.resolve()
      },
    },
  })
  return { repo, service, notifications, signals, bumped, counterKeys, warnings }
}

function request(over: Partial<RegisterForEventRequest> = {}): RegisterForEventRequest {
  return {
    id: EVENT,
    idempotencyKey: "idem-key-0001",
    partySize: 1,
    joinWaitlistIfFull: false,
    ...over,
  }
}

let keySeq = 0
function freshKey(): string {
  keySeq += 1
  return `idem-key-fresh-${keySeq}`
}

const REFUSED = { registration: null, ticketTokens: [] }

function expectNoSideEffects(h: Harness): void {
  expect(h.notifications).toEqual([])
  expect(h.signals).toEqual([])
  expect(h.bumped).toEqual([])
}

describe("registration characterization: register outcomes", () => {
  let h: Harness

  beforeEach(() => {
    h = build()
  })

  it("registered: returns the full DTO, one active-seat token per seat, notifies and signals once", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 10, maxPartySize: 4 })
    const result = await h.service.register(
      request({ partySize: 2, attendeeNames: ["  Ada  ", "   "], slotId: "slot-1" }),
      ME,
    )

    expect(result).toEqual({
      outcome: "registered",
      registration: {
        id: "rec-2",
        cleanupId: EVENT,
        kind: "member",
        person: {
          id: USER,
          name: "Member",
          handle: null,
          bio: null,
          avatar: avatarGradient(USER),
          followers: 0,
          following: 0,
          isFollowing: false,
        },
        guestName: null,
        ticketTypeId: type.id,
        ticketTypeName: "General",
        partySize: 2,
        seatCount: 2,
        seats: [
          {
            id: "seat-1",
            seatIndex: 0,
            attendeeName: "Ada",
            status: "active",
            ticketToken: tokens.tokenFor("seat-1"),
            checkedInAt: null,
            checkinMethod: null,
            noShowAt: null,
          },
          {
            id: "seat-2",
            seatIndex: 1,
            attendeeName: null,
            status: "active",
            ticketToken: tokens.tokenFor("seat-2"),
            checkedInAt: null,
            checkinMethod: null,
            noShowAt: null,
          },
        ],
        status: "registered",
        source: "self",
        registeredAt: NOW.toISOString(),
        cancelledAt: null,
        checkedInAt: null,
      },
      ticketTokens: [tokens.tokenFor("seat-1"), tokens.tokenFor("seat-2")],
    })
    expect(h.notifications).toEqual([
      {
        userId: USER,
        input: {
          type: "system",
          title: "You're registered",
          body: "Your place at Test event is confirmed.",
          link: `/cleanups/${EVENT}`,
        },
      },
    ])
    expect(h.signals).toEqual([{ ids: [TEAM], signal: { topic: "host", id: EVENT } }])
    expect(h.bumped).toEqual([EVENT])
    expect(h.counterKeys).toEqual([`event:register:${USER}@3600`])
    expect(h.repo.ticketTypes.get(type.id)?.reservedSeats).toBe(2)
    expect(h.repo.registrations.get("rec-2")?.slotId).toBe("slot-1")
  })

  it("registered as a guest: no notification, still signals and bumps, counter keyed by guest id", async () => {
    const result = await h.service.register(request(), { kind: "guest", guestId: GUEST })
    expect(result.outcome).toBe("registered")
    expect(result.registration?.kind).toBe("guest")
    expect(result.registration?.person).toBeNull()
    expect(result.registration?.ticketTypeId).toBeNull()
    expect(h.notifications).toEqual([])
    expect(h.signals).toHaveLength(1)
    expect(h.bumped).toEqual([EVENT])
    expect(h.counterKeys).toEqual([`event:register:${GUEST}@3600`])
  })

  it("registered: a failing notifier is suppressed and logged", async () => {
    h = build({ notifierFails: true })
    const result = await h.service.register(request(), ME)
    expect(result.outcome).toBe("registered")
    expect(h.warnings.map((w) => w.msg)).toEqual([
      "registration: confirmation notification failed (suppressed)",
    ])
    expect(h.bumped).toEqual([EVENT])
  })

  it("registered: no team resolver means no host signal", async () => {
    h = build({ noTeam: true })
    await h.service.register(request(), ME)
    expect(h.signals).toEqual([])
    expect(h.bumped).toEqual([EVENT])
  })

  it("replayed: same key returns the original registration with no second notification or bump", async () => {
    const first = await h.service.register(request(), ME)
    const second = await h.service.register(request(), ME)
    expect(second).toEqual({ ...first, outcome: "replayed" })
    expect(h.notifications).toHaveLength(1)
    expect(h.bumped).toEqual([EVENT])
    expect(h.repo.registrations.size).toBe(1)
  })

  it("replayed with a dangling idempotency record maps to already_registered", async () => {
    h.repo.idempotency.set(`user:${USER}:idem-key-0001`, "missing-registration")
    const result = await h.service.register(request(), ME)
    expect(result).toEqual({ outcome: "already_registered", ...REFUSED })
    expectNoSideEffects(h)
  })

  it("already_registered: a second key for the same person is refused", async () => {
    await h.service.register(request(), ME)
    h.notifications.length = 0
    h.signals.length = 0
    h.bumped.length = 0
    const result = await h.service.register(request({ idempotencyKey: freshKey() }), ME)
    expect(result).toEqual({ outcome: "already_registered", ...REFUSED })
    expectNoSideEffects(h)
  })

  it("full: ticket type capacity exhausted reserves nothing", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 1 })
    await h.service.register(request(), ME)
    h.bumped.length = 0
    const result = await h.service.register(request({ idempotencyKey: freshKey() }), {
      kind: "user",
      userId: OTHER,
    })
    expect(result).toEqual({ outcome: "full", ...REFUSED })
    expect(h.bumped).toEqual([])
    expect(h.repo.ticketTypes.get(type.id)?.reservedSeats).toBe(1)
  })

  it("full: event capacity counts party sizes when the event has no ticket types", async () => {
    h.repo.seedEvent({ cleanupId: EVENT, scheduledAt: STARTS_AT, endsAt: ENDS_AT, capacity: 3 })
    const fits = await h.service.register(request({ partySize: 2 }), ME)
    expect(fits.outcome).toBe("registered")
    const over = await h.service.register(request({ idempotencyKey: freshKey(), partySize: 2 }), {
      kind: "user",
      userId: OTHER,
    })
    expect(over).toEqual({ outcome: "full", ...REFUSED })
    const exact = await h.service.register(request({ idempotencyKey: freshKey(), partySize: 1 }), {
      kind: "user",
      userId: OTHER,
    })
    expect(exact.outcome).toBe("registered")
  })

  it("waitlisted: full with joinWaitlistIfFull and an explicit ticket type joins the waitlist", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 1, waitlistEnabled: true })
    await h.service.register(request({ ticketTypeId: type.id }), ME)
    h.bumped.length = 0
    h.signals.length = 0
    const other: RegistrationSubject = { kind: "user", userId: OTHER }
    const joined = await h.service.register(
      request({ idempotencyKey: freshKey(), ticketTypeId: type.id, joinWaitlistIfFull: true }),
      other,
    )
    expect(joined).toEqual({
      outcome: "waitlisted",
      registration: null,
      ticketTokens: [],
      waitlistPosition: 1,
    })
    expect(h.bumped).toEqual([EVENT])
    expect(h.signals).toHaveLength(1)

    const again = await h.service.register(
      request({ idempotencyKey: freshKey(), ticketTypeId: type.id, joinWaitlistIfFull: true }),
      other,
    )
    expect(again).toEqual(joined)
    expect(h.bumped).toEqual([EVENT, EVENT])
    expect(h.repo.waitlist.size).toBe(1)
  })

  it("full (pinned): joinWaitlistIfFull without an explicit ticket type does not join, even when the only type was auto-picked", async () => {
    h.repo.seedTicketType({ cleanupId: EVENT, capacity: 1, waitlistEnabled: true })
    await h.service.register(request(), ME)
    const result = await h.service.register(
      request({ idempotencyKey: freshKey(), joinWaitlistIfFull: true }),
      { kind: "user", userId: OTHER },
    )
    expect(result).toEqual({ outcome: "full", ...REFUSED })
    expect(h.repo.waitlist.size).toBe(0)
  })

  it("full: joinWaitlistIfFull on a type with the waitlist disabled falls back to full", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 1 })
    await h.service.register(request({ ticketTypeId: type.id }), ME)
    h.bumped.length = 0
    const result = await h.service.register(
      request({ idempotencyKey: freshKey(), ticketTypeId: type.id, joinWaitlistIfFull: true }),
      { kind: "user", userId: OTHER },
    )
    expect(result).toEqual({ outcome: "full", ...REFUSED })
    expect(h.bumped).toEqual([])
  })

  it("closed: a cancelled event", async () => {
    h.repo.seedEvent({
      cleanupId: EVENT,
      scheduledAt: STARTS_AT,
      endsAt: ENDS_AT,
      status: "cancelled",
    })
    expect(await h.service.register(request(), ME)).toEqual({ outcome: "closed", ...REFUSED })
    expectNoSideEffects(h)
  })

  it("closed wins over banned and the registration window", async () => {
    h.repo.seedEvent({
      cleanupId: EVENT,
      scheduledAt: STARTS_AT,
      endsAt: ENDS_AT,
      status: "cancelled",
      registrationClosesAt: new Date(NOW.getTime() - 1000),
    })
    h.repo.bans.add(`${EVENT}:${USER}`)
    expect((await h.service.register(request(), ME)).outcome).toBe("closed")
  })

  it("registration_closed: before opensAt and at closesAt, and it wins over banned", async () => {
    h.repo.seedEvent({
      cleanupId: EVENT,
      scheduledAt: STARTS_AT,
      endsAt: ENDS_AT,
      registrationOpensAt: new Date(NOW.getTime() + 1),
    })
    h.repo.bans.add(`${EVENT}:${USER}`)
    expect(await h.service.register(request(), ME)).toEqual({
      outcome: "registration_closed",
      ...REFUSED,
    })
    h.repo.seedEvent({
      cleanupId: EVENT,
      scheduledAt: STARTS_AT,
      endsAt: ENDS_AT,
      registrationClosesAt: NOW,
    })
    expect((await h.service.register(request(), ME)).outcome).toBe("registration_closed")
    expectNoSideEffects(h)
  })

  it("banned: a banned member is refused before the idempotency replay", async () => {
    await h.service.register(request(), ME)
    h.repo.bans.add(`${EVENT}:${USER}`)
    expect(await h.service.register(request(), ME)).toEqual({ outcome: "banned", ...REFUSED })
  })

  it("banned applies to members only; a guest subject is never ban-checked", async () => {
    h.repo.bans.add(`${EVENT}:${GUEST}`)
    const result = await h.service.register(request(), { kind: "guest", guestId: GUEST })
    expect(result.outcome).toBe("registered")
  })

  it("ticket_type_not_found: unknown explicit id, another event's type, and ambiguity among several", async () => {
    const foreign = h.repo.seedTicketType({ cleanupId: OTHER })
    expect(await h.service.register(request({ ticketTypeId: "missing-type" }), ME)).toEqual({
      outcome: "ticket_type_not_found",
      ...REFUSED,
    })
    expect((await h.service.register(request({ ticketTypeId: foreign.id }), ME)).outcome).toBe(
      "ticket_type_not_found",
    )
    h.repo.seedTicketType({ cleanupId: EVENT, name: "Morning" })
    h.repo.seedTicketType({ cleanupId: EVENT, name: "Afternoon" })
    expect((await h.service.register(request(), ME)).outcome).toBe("ticket_type_not_found")
    expectNoSideEffects(h)
  })

  it("access_code_required / access_code_invalid, with the code trimmed before hashing", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, visibility: "access_code" })
    h.repo.setAccessCode(type.id, await sha256Hex("open-sesame"))

    expect(await h.service.register(request({ ticketTypeId: type.id }), ME)).toEqual({
      outcome: "access_code_required",
      ...REFUSED,
    })
    expect(
      await h.service.register(request({ ticketTypeId: type.id, accessCode: "wrong" }), ME),
    ).toEqual({ outcome: "access_code_invalid", ...REFUSED })
    expect(
      (
        await h.service.register(
          request({ ticketTypeId: type.id, accessCode: "  open-sesame  " }),
          ME,
        )
      ).outcome,
    ).toBe("registered")
  })

  it("access code is checked before party size", async () => {
    const type = h.repo.seedTicketType({
      cleanupId: EVENT,
      visibility: "access_code",
      maxPartySize: 1,
    })
    h.repo.setAccessCode(type.id, await sha256Hex("open-sesame"))
    expect(
      (await h.service.register(request({ ticketTypeId: type.id, partySize: 3 }), ME)).outcome,
    ).toBe("access_code_required")
  })

  it("party_too_large: above maxPartySize refused, exactly maxPartySize accepted", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, maxPartySize: 2 })
    expect(await h.service.register(request({ partySize: 3 }), ME)).toEqual({
      outcome: "party_too_large",
      ...REFUSED,
    })
    expect(h.repo.ticketTypes.get(type.id)?.reservedSeats).toBe(0)
    const ok = await h.service.register(request({ idempotencyKey: freshKey(), partySize: 2 }), ME)
    expect(ok.outcome).toBe("registered")
    expect(ok.ticketTokens).toHaveLength(2)
  })

  it("party size is checked before the sales window and the capacity", async () => {
    h.repo.seedTicketType({
      cleanupId: EVENT,
      maxPartySize: 1,
      capacity: 1,
      salesClosesAt: new Date(NOW.getTime() - 1000),
    })
    expect((await h.service.register(request({ partySize: 2 }), ME)).outcome).toBe(
      "party_too_large",
    )
  })

  it("sales_closed: before salesOpensAt and at salesClosesAt, and it wins over capacity", async () => {
    const type = h.repo.seedTicketType({
      cleanupId: EVENT,
      capacity: 0,
      salesOpensAt: new Date(NOW.getTime() + 1),
    })
    expect(await h.service.register(request({ ticketTypeId: type.id }), ME)).toEqual({
      outcome: "sales_closed",
      ...REFUSED,
    })
    const closing = h.repo.seedTicketType({ cleanupId: OTHER, salesClosesAt: NOW })
    h.repo.seedEvent({ cleanupId: OTHER, scheduledAt: STARTS_AT, endsAt: ENDS_AT })
    expect(
      (await h.service.register(request({ id: OTHER, ticketTypeId: closing.id }), ME)).outcome,
    ).toBe("sales_closed")
  })

  it("answers_invalid: returned before the repository runs, with per-field detail", async () => {
    h.repo.seedEvent({
      cleanupId: EVENT,
      scheduledAt: STARTS_AT,
      endsAt: ENDS_AT,
      status: "cancelled",
    })
    await h.repo.reconcileQuestions(
      EVENT,
      [
        {
          id: "q-1",
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
    const result = await h.service.register(
      request({
        consent: { termsVersion: "1900-01-01", disclosureVersion: "x", hostContactOptIn: false },
      }),
      ME,
    )
    expect(result).toEqual({
      outcome: "answers_invalid",
      registration: null,
      ticketTokens: [],
      fields: { "q-1": "required" },
    })
    expect(h.counterKeys).toHaveLength(1)
    expectNoSideEffects(h)
  })

  it("stale consent throws VALIDATION before the repository runs (terms first, then privacy)", async () => {
    h.repo.seedEvent({
      cleanupId: EVENT,
      scheduledAt: STARTS_AT,
      endsAt: ENDS_AT,
      status: "cancelled",
    })
    await expect(
      h.service.register(
        request({
          consent: {
            termsVersion: "1900-01-01",
            disclosureVersion: "1900-01-01",
            hostContactOptIn: true,
          },
        }),
        ME,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: "Validation failed",
      fields: { "consent.termsVersion": `out of date ${DASH} re-accept the terms` },
    })
    await expect(
      h.service.register(
        request({
          consent: {
            termsVersion: currentVersion("terms"),
            disclosureVersion: "1900-01-01",
            hostContactOptIn: true,
          },
        }),
        ME,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      fields: { "consent.disclosureVersion": `out of date ${DASH} re-accept the privacy notice` },
    })
  })

  it("not_found: an unknown event throws NOT_FOUND after the flip budget is spent", async () => {
    await expect(h.service.register(request({ id: OTHER }), ME)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Cleanup not found",
    })
    expect(h.counterKeys).toEqual([`event:register:${USER}@3600`])
  })

  it("an ended event throws the CONFLICT ended error before answers are validated", async () => {
    h.repo.seedEvent({
      cleanupId: EVENT,
      scheduledAt: new Date(NOW.getTime() - 3 * 3_600_000),
      endsAt: new Date(NOW.getTime() - 3_600_000),
    })
    await expect(h.service.register(request(), ME)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This event has already ended.",
      fields: { event: "ended" },
    })
  })

  it("flip budget: the 21st attempt in the window is RATE_LIMITED, even for refusals", async () => {
    h.repo.seedEvent({
      cleanupId: EVENT,
      scheduledAt: STARTS_AT,
      endsAt: ENDS_AT,
      status: "cancelled",
    })
    for (let i = 0; i < 20; i++) {
      expect((await h.service.register(request(), ME)).outcome).toBe("closed")
    }
    await expect(h.service.register(request(), ME)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: "Too many registration changes. Try again later.",
    })
  })

  it("flip budget: a broken counter fails closed with RATE_LIMITED and a warning", async () => {
    h = build({
      counters: {
        incr: () => Promise.reject(new Error("redis is down")),
        incrBy: () => Promise.reject(new Error("redis is down")),
      },
    })
    await expect(h.service.register(request(), ME)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: "Registration is temporarily unavailable. Try again shortly.",
    })
    expect(h.warnings.map((w) => w.msg)).toEqual([
      "registration: abuse counter unavailable; refusing the write (fail closed)",
    ])
    expect(h.repo.registrations.size).toBe(0)
  })
})

describe("registration characterization: makeContainerRegistrationServices wiring", () => {
  let container: Container

  beforeEach(() => {
    container = buildContainer(loadEnv({ NODE_ENV: "test" }))
  })

  function seededRepo(): InMemoryHostRegistrationRepository {
    const repo = new InMemoryHostRegistrationRepository(counterIds("rec"))
    repo.seedEvent({ cleanupId: EVENT, scheduledAt: STARTS_AT, endsAt: ENDS_AT })
    return repo
  }

  it("a repo override skips the database, cache and affiliation loader entirely", () => {
    const getDb = vi.spyOn(container, "getDb")
    const getCache = vi.spyOn(container, "getCache")
    const getAffiliations = vi.spyOn(container, "getAffiliationLoader")
    const repo = seededRepo()
    const services = makeContainerRegistrationServices(container, { repo, tokens })
    expect(services.repo).toBe(repo)
    expect(services.tokens).toBe(tokens)
    expect(Object.keys(services).sort()).toEqual([
      "checkin",
      "questions",
      "registrations",
      "repo",
      "tickets",
      "tokens",
      "waitlist",
    ])
    expect(getDb).not.toHaveBeenCalled()
    expect(getCache).not.toHaveBeenCalled()
    expect(getAffiliations).not.toHaveBeenCalled()
  })

  it("without a tokens override the container's ticket signer is used", () => {
    const services = makeContainerRegistrationServices(container, { repo: seededRepo() })
    expect(services.tokens).toBe(container.getTicketTokenSigner())
  })

  it("repo override without teamUserIds: no host signal; with it: the container user channel publishes", async () => {
    const publish = vi.spyOn(container.userChannel, "publishToUsers")
    const counters = new InMemoryCounterStore(() => NOW.getTime())
    const plain = makeContainerRegistrationServices(container, {
      repo: seededRepo(),
      tokens,
      counters,
      now: () => NOW,
    })
    await plain.registrations.register(request(), { kind: "guest", guestId: GUEST })
    expect(publish).not.toHaveBeenCalled()

    const teamed = makeContainerRegistrationServices(container, {
      repo: seededRepo(),
      tokens,
      counters,
      now: () => NOW,
      teamUserIds: () => Promise.resolve([TEAM]),
    })
    await teamed.registrations.register(request(), { kind: "guest", guestId: GUEST })
    expect(publish).toHaveBeenCalledWith([TEAM], { topic: "host", id: EVENT })
  })

  it("counters default to the container counter store; the override replaces it", async () => {
    const recorded: string[] = []
    const store = new InMemoryCounterStore(() => NOW.getTime())
    const getCounters = vi.spyOn(container, "getCounterStore").mockReturnValue({
      incr: (key, ttl) => {
        recorded.push(key)
        return store.incr(key, ttl)
      },
      incrBy: (key, by, ttl) => store.incrBy(key, by, ttl),
    })
    const services = makeContainerRegistrationServices(container, {
      repo: seededRepo(),
      tokens,
      now: () => NOW,
    })
    expect(getCounters).toHaveBeenCalledTimes(1)
    await services.registrations.register(request(), { kind: "guest", guestId: GUEST })
    expect(recorded).toEqual([`event:register:${GUEST}`])

    getCounters.mockClear()
    const overridden = makeContainerRegistrationServices(container, {
      repo: seededRepo(),
      tokens,
      now: () => NOW,
      counters: new InMemoryCounterStore(() => NOW.getTime()),
    })
    expect(getCounters).not.toHaveBeenCalled()
    await overridden.registrations.register(request(), { kind: "guest", guestId: GUEST })
    expect(recorded).toHaveLength(1)
  })

  it("the notifier resolves the container notification service lazily, passing the logger", async () => {
    const created: { userId: string; title: string }[] = []
    const getNotifications = vi.spyOn(container, "getNotificationService").mockReturnValue({
      createNotification: (userId: string, input: { title: string }) => {
        created.push({ userId, title: input.title })
        return Promise.resolve(null)
      },
    } as unknown as ReturnType<Container["getNotificationService"]>)
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
    const services = makeContainerRegistrationServices(
      container,
      { repo: seededRepo(), tokens, now: () => NOW, counters: new InMemoryCounterStore() },
      logger,
    )
    expect(getNotifications).not.toHaveBeenCalled()
    await services.registrations.register(request(), ME)
    expect(getNotifications).toHaveBeenCalledWith(logger)
    expect(created).toEqual([{ userId: USER, title: "You're registered" }])
  })

  it("insightsInvalidator, audit, now and newId overrides flow into the registration service", async () => {
    const bumped: string[] = []
    const audits: string[] = []
    const repo = seededRepo()
    const services = makeContainerRegistrationServices(container, {
      repo,
      tokens,
      counters: new InMemoryCounterStore(() => NOW.getTime()),
      now: () => NOW,
      newId: counterIds("wired-seat"),
      audit: (input) => {
        audits.push(input.action)
        return Promise.resolve()
      },
      insightsInvalidator: {
        bumpInsightsGeneration: (id) => {
          bumped.push(id)
          return Promise.resolve()
        },
      },
    })
    const result = await services.registrations.register(request(), {
      kind: "guest",
      guestId: GUEST,
    })
    expect(result.registration?.registeredAt).toBe(NOW.toISOString())
    expect(result.registration?.seats.map((s) => s.id)).toEqual(["wired-seat-1"])
    expect(bumped).toEqual([EVENT])

    await services.registrations.listRoster({ id: EVENT }, USER, {
      includeHostNote: false,
      includeAnswersPreview: false,
    })
    expect(audits).toEqual(["event.roster_viewed"])
  })

  it("without a repo override: resolves the db, cache and affiliation loader eagerly and runs team lookups in SQL", async () => {
    const recorder = makeSqlRecorder()
    recorder.on(/FROM cleanup_members/u, [{ user_id: TEAM }])
    const cache = new InMemoryCacheClient(() => NOW.getTime())
    const getDb = vi
      .spyOn(container, "getDb")
      .mockReturnValue({ sql: recorder.sql } as unknown as DbHandle)
    const getCache = vi.spyOn(container, "getCache").mockReturnValue(cache)
    const getAffiliations = vi
      .spyOn(container, "getAffiliationLoader")
      .mockReturnValue(() => Promise.resolve(new Map()))
    const publish = vi.spyOn(container.userChannel, "publishToUsers")

    const services = makeContainerRegistrationServices(container, {
      tokens,
      counters: new InMemoryCounterStore(() => NOW.getTime()),
      now: () => NOW,
    })
    expect(getDb).toHaveBeenCalledTimes(1)
    expect(getCache).toHaveBeenCalledTimes(1)
    expect(getAffiliations).toHaveBeenCalledTimes(1)
    expect(recorder.queries).toHaveLength(0)

    await services.registrations.eventChanged(EVENT)
    expect(await cache.get(insightsGenerationKey(EVENT))).toBe("1")
    expect(recorder.queries.map((q) => q.params)).toEqual([[EVENT, 50]])
    expect(publish).toHaveBeenCalledWith([TEAM], { topic: "host", id: EVENT })

    await expect(services.registrations.register(request(), ME)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Cleanup not found",
    })
  })
})

describe("registration characterization: makeHostGuards", () => {
  let container: Container

  beforeEach(() => {
    container = buildContainer(loadEnv({ NODE_ENV: "test" }))
  })

  it("a guards override is returned as is", () => {
    const guards: HostGuards = { ...OPEN_HOST_GUARDS }
    const getDb = vi.spyOn(container, "getDb")
    expect(
      makeHostGuards(container, { guards, repo: new InMemoryHostRegistrationRepository() }),
    ).toBe(guards)
    expect(getDb).not.toHaveBeenCalled()
  })

  it("a repo override alone yields the open guards, which grant organizer standing", async () => {
    const getDb = vi.spyOn(container, "getDb")
    const guards = makeHostGuards(container, { repo: new InMemoryHostRegistrationRepository() })
    expect(guards).toBe(OPEN_HOST_GUARDS)
    expect(await guards.requireCapability(EVENT, USER, "view_roster")).toEqual({
      eventRole: "organizer",
      orgRole: null,
    })
    expect(await guards.canManage(EVENT, null, "view_roster")).toBe(true)
    await expect(guards.requireVisible(EVENT, null)).resolves.toBeUndefined()
    expect(getDb).not.toHaveBeenCalled()
  })

  it("no override resolves the database once and returns SQL-backed guards", async () => {
    const recorder = makeSqlRecorder()
    const getDb = vi
      .spyOn(container, "getDb")
      .mockReturnValue({ sql: recorder.sql } as unknown as DbHandle)
    const guards = makeHostGuards(container)
    expect(getDb).toHaveBeenCalledTimes(1)
    expect(guards).not.toBe(OPEN_HOST_GUARDS)
    expect(await guards.canManage(EVENT, null, "view_roster")).toBe(false)
    expect(recorder.queries).toHaveLength(0)
  })
})
