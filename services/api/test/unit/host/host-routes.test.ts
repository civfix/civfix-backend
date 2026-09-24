import { afterEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { endpoints, versionedPath } from "@civfix/shared/client"
import { makeServer } from "../../../src/server.js"
import { makeContainer } from "../../../src/di.js"
import { loadEnv } from "../../../src/env.js"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { InMemoryCacheClient } from "../../../src/auth/cache.js"
import { makeInMemoryStores } from "../../../src/auth/stores.js"
import { makeAuthServices } from "../../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../../helpers/auth.js"
import { InMemoryHostRegistrationRepository } from "../../helpers/host/registration-repository.memory.js"
import {
  OPEN_HOST_GUARDS,
  ORGANIZER_STANDING,
  type HostGuards,
} from "../../../src/services/host/registration-wiring.js"
import type { HostStanding } from "@civfix/shared/host"
import { makeTicketTokenSigner } from "../../../src/services/host/ticket-token.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const QUESTION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const tokens = makeTicketTokenSigner("host-routes-test-secret-long-enough-value")

interface Harness {
  app: FastifyInstance
  repo: InMemoryHostRegistrationRepository
  token: string
  userId: string
  denied: HostGuards
}

let current: Harness | undefined

async function makeHarness(guards: HostGuards = OPEN_HOST_GUARDS): Promise<Harness> {
  const env = loadEnv({ NODE_ENV: "test" })
  const stores = makeInMemoryStores()
  const cache = new InMemoryCacheClient(() => Date.now())
  const mailer = new FakeMailer()
  const authServices = makeAuthServices({
    stores,
    cache,
    mailer,
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })

  const repo = new InMemoryHostRegistrationRepository()
  repo.tokenHashResolver = (seatId) => tokens.hashFor(seatId)
  repo.seedEvent({ cleanupId: EVENT })

  const container = makeContainer(env)
  const counters = new InMemoryCounterStore(() => Date.now())
  const app = await makeServer({
    env,
    container,
    authServices,
    hostRegistrationOverrides: { repo, tokens, guards, counters },
    hostPageOverrides: {
      repo,
      guards,
      counters,
      standingOf: () => Promise.resolve(ORGANIZER_STANDING),
    },
  })

  const email = "host@example.com"
  await app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
  const code = mailer.lastOtpFor(email) as string
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { "x-client": "mobile" },
    payload: { email, code },
  })
  const body = verify.json()

  const h: Harness = {
    app,
    repo,
    token: body.token,
    userId: body.user.id,
    denied: guards,
  }
  current = h
  return h
}

function seedQuestion(repo: InMemoryHostRegistrationRepository): void {
  repo.questions.set(QUESTION, {
    id: QUESTION,
    cleanupId: EVENT,
    ticketTypeId: null,
    kind: "short_text",
    prompt: "Any access needs?",
    helpText: null,
    required: false,
    options: [],
    maxSelections: null,
    consentText: null,
    showIf: null,
    sortOrder: 0,
    archivedAt: null,
  })
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

afterEach(async () => {
  if (current) {
    await current.app.close()
    current = undefined
  }
})

describe("host registration routes", () => {
  it("mounts every endpoint at exactly the method and path the frozen registry declares", async () => {
    const { app } = await makeHarness()
    const names = [
      "listEventTicketTypes",
      "createEventTicketType",
      "reorderEventTicketTypes",
      "updateEventTicketType",
      "deleteEventTicketType",
      "listEventQuestions",
      "saveEventQuestions",
      "registerForEvent",
      "listEventRegistrations",
      "createWalkupRegistration",
      "getEventRegistration",
      "removeEventRegistration",
      "cancelEventRegistration",
      "transferEventRegistration",
      "setEventRegistrationNote",
      "getEventRegistrationAnswers",
      "joinEventWaitlist",
      "leaveEventWaitlist",
      "listEventWaitlist",
      "claimWaitlistOffer",
      "promoteFromWaitlist",
      "getPublicEventPage",
      "getEventPage",
      "saveEventPage",
      "publishEventPage",
      "checkEventPageSlug",
      "getMyEventTicket",
      "getGuestEventTicket",
      "scanEventTicket",
      "checkInEventSeat",
      "markEventNoShows",
      "undoEventCheckIn",
      "getEventCheckinCounters",
    ] as const

    for (const name of names) {
      const ep = endpoints[name]
      expect(
        app.hasRoute({ method: ep.method as "GET", url: versionedPath(ep) }),
        `${name} is not registered at ${ep.method} ${versionedPath(ep)}`,
      ).toBe(true)
    }
  })

  it("merges the path id into the body before validation", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${EVENT}/ticket-types`,
      headers: auth(token),
      payload: { name: "General", capacity: 10, maxPartySize: 2 },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().cleanupId).toBe(EVENT)
  })

  it("rejects an unknown body key rather than silently dropping it", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${EVENT}/ticket-types`,
      headers: auth(token),
      payload: { name: "General", price: 500 },
    })
    expect(res.statusCode).toBe(422)
  })

  it("requires authentication on every host-only surface", async () => {
    const { app } = await makeHarness()
    for (const url of [
      `/v1/cleanups/${EVENT}/registrations`,
      `/v1/cleanups/${EVENT}/waitlist`,
      `/v1/cleanups/${EVENT}/page`,
      `/v1/cleanups/${EVENT}/checkins/counters`,
      `/v1/cleanups/${EVENT}/ticket`,
    ]) {
      const res = await app.inject({ method: "GET", url })
      expect(res.statusCode, url).toBe(401)
    }
  })

  it("hands a staff standing a roster with no host note and no answers digest", async () => {
    const staffStanding: HostStanding = { eventRole: "staff", orgRole: null }
    const staffGuards: HostGuards = {
      requireCapability: () => Promise.resolve(staffStanding),
      canManage: () => Promise.resolve(false),
      requireVisible: () => Promise.resolve(),
    }
    const { app, token, repo, userId } = await makeHarness(staffGuards)
    repo.seedTicketType({ cleanupId: EVENT, capacity: 10 })
    seedQuestion(repo)

    const registered = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${EVENT}/registrations`,
      headers: auth(token),
      payload: {
        idempotencyKey: `key-${randomUUID()}`,
        partySize: 1,
        answers: [{ questionId: QUESTION, value: "wheelchair user" }],
      },
    })
    expect(registered.statusCode).toBe(200)
    const registrationId = registered.json().registration.id as string
    await repo.setHostNote(EVENT, registrationId, "vip, arrives late")

    const roster = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${EVENT}/registrations`,
      headers: auth(token),
    })
    expect(roster.statusCode).toBe(200)
    const row = roster.json().items[0]
    expect(row.note).toBeUndefined()
    expect(row.answersPreview).toBeUndefined()

    const detail = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${EVENT}/registrations/${registrationId}`,
      headers: auth(token),
    })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().note).toBeUndefined()
    expect(detail.json().answersPreview).toBeUndefined()
    expect(userId.length).toBeGreaterThan(0)
  })

  it("hands an organizer standing the host note and the answers digest", async () => {
    const { app, token, repo } = await makeHarness()
    repo.seedTicketType({ cleanupId: EVENT, capacity: 10 })
    seedQuestion(repo)

    const registered = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${EVENT}/registrations`,
      headers: auth(token),
      payload: {
        idempotencyKey: `key-${randomUUID()}`,
        partySize: 1,
        answers: [{ questionId: QUESTION, value: "wheelchair user" }],
      },
    })
    const registrationId = registered.json().registration.id as string
    await repo.setHostNote(EVENT, registrationId, "vip, arrives late")

    const roster = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${EVENT}/registrations`,
      headers: auth(token),
    })
    const row = roster.json().items[0]
    expect(row.note).toBe("vip, arrives late")
    expect(row.answersPreview).toContain("wheelchair user")
  })

  it("propagates a capability refusal as a 403", async () => {
    const denied: HostGuards = {
      requireCapability: () => Promise.reject(new Error("nope")),
      canManage: () => Promise.resolve(false),
      requireVisible: () => Promise.resolve(),
    }
    const forbidding: HostGuards = {
      ...denied,
      requireCapability: async () => {
        const { AppError } = await import("@civfix/shared")
        throw AppError.forbidden("Only the event team can view the roster.")
      },
    }
    const { app, token } = await makeHarness(forbidding)
    const res = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${EVENT}/registrations`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(403)
  })

  it("answers 200 with the outcome for a domain refusal rather than an error envelope", async () => {
    const { app, token, repo } = await makeHarness()
    repo.seedTicketType({ cleanupId: EVENT, capacity: 0 })
    const res = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${EVENT}/registrations`,
      headers: auth(token),
      payload: { idempotencyKey: `key-${randomUUID()}`, partySize: 1 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().outcome).toBe("full")
  })

  it("404s a register call against an event that does not exist", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${randomUUID()}/registrations`,
      headers: auth(token),
      payload: { idempotencyKey: `key-${randomUUID()}`, partySize: 1 },
    })
    expect(res.statusCode).toBe(404)
  })

  it("serves the guest ticket read as a public POST with the token in the body", async () => {
    const { app } = await makeHarness()
    const ep = endpoints.getGuestEventTicket
    expect(ep.method).toBe("POST")
    expect(ep.auth).toBe("public")
    expect(ep.csrf).toBe(false)

    const res = await app.inject({
      method: "POST",
      url: versionedPath(ep),
      payload: { token: "x".repeat(32) },
    })
    expect(res.statusCode).toBe(404)
  })

  it("keeps every new host mutation behind csrf except the one public ticket read", () => {
    const mine = [
      "createEventTicketType",
      "reorderEventTicketTypes",
      "updateEventTicketType",
      "deleteEventTicketType",
      "saveEventQuestions",
      "registerForEvent",
      "createWalkupRegistration",
      "removeEventRegistration",
      "cancelEventRegistration",
      "transferEventRegistration",
      "setEventRegistrationNote",
      "joinEventWaitlist",
      "leaveEventWaitlist",
      "claimWaitlistOffer",
      "promoteFromWaitlist",
      "saveEventPage",
      "publishEventPage",
      "scanEventTicket",
      "checkInEventSeat",
      "markEventNoShows",
      "undoEventCheckIn",
    ] as const
    for (const name of mine) {
      expect(endpoints[name].csrf, `${name} must carry csrf`).toBe(true)
    }
    expect(endpoints.getGuestEventTicket.csrf).toBe(false)
    expect(endpoints.getGuestEventTicket.auth).toBe("public")
  })

  it("configures the scanner at 300 requests a minute and the roster at 60", async () => {
    const { app } = await makeHarness()
    expect(app.hasRoute({ method: "POST", url: versionedPath(endpoints.scanEventTicket) })).toBe(
      true,
    )
    const { SCAN_RATE_LIMIT, ROSTER_READ_RATE_LIMIT } =
      await import("../../../src/routes/host/_host-routes.js")
    expect(SCAN_RATE_LIMIT.max).toBe(300)
    expect(ROSTER_READ_RATE_LIMIT.max).toBe(60)
  })
})
