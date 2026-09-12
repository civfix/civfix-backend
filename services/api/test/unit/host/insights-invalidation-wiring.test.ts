import { randomUUID } from "node:crypto"
import { beforeEach, describe, expect, it } from "vitest"
import { buildContainer } from "../../../src/di.js"
import { loadEnv } from "../../../src/env.js"
import { InMemoryCacheClient } from "../../../src/auth/cache.js"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { InMemoryHostRegistrationRepository } from "../../../src/services/host/registration-repository.memory.js"
import {
  makeContainerRegistrationServices,
  type HostRegistrationServices,
} from "../../../src/services/host/registration-wiring.js"
import {
  makeHostAnalyticsCache,
  makeInsightsGeneration,
} from "../../../src/services/host/host-analytics-cache.js"
import {
  makeInsightsService,
  type InsightsService,
} from "../../../src/services/host/insights-service.js"
import { makeMemoryDonationRepository } from "../../../src/services/payments/donation-repository.memory.js"
import { makeTicketTokenSigner } from "../../../src/services/host/ticket-token.js"
import type { InsightsServiceDeps } from "../../../src/services/host/insights-service.js"
import type { SeatDraft } from "../../../src/services/host/registration-repository.types.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const HOST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const GUEST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const STARTS_AT = new Date("2026-03-07T17:00:00.000Z")
const NOW = new Date("2026-03-07T18:00:00.000Z")

const tokens = makeTicketTokenSigner("insights-wiring-test-secret-long-enough")

const VIEWER = { userId: HOST, canViewDonations: false, viewerScope: "organizer:none" }

function analyticsStub(): InsightsServiceDeps["analytics"] {
  return {
    eventClock: () =>
      Promise.resolve({
        status: "upcoming" as const,
        scheduledAt: STARTS_AT,
        endsAt: null,
        completedAt: null,
        registrationClosesAt: null,
        timezone: "UTC",
      }),
    seatTrend: () => Promise.resolve([]),
    registrationsBySource: () => Promise.resolve([]),
    broadcastsForEvent: () => Promise.resolve([]),
    eventHoursTotals: () =>
      Promise.resolve({ credited: 0, attendeesCredited: 0, attendeesCheckedIn: 0 }),
    returningAttendees: () => Promise.resolve({ seats: 0, ofRegistered: 0 }),
    hostedEventIds: () => Promise.resolve([EVENT]),
  }
}

interface Harness {
  repo: InMemoryHostRegistrationRepository
  services: HostRegistrationServices
  insights: InsightsService
}

function build(): Harness {
  const env = loadEnv({ NODE_ENV: "test" })
  const container = buildContainer(env)
  const repo = new InMemoryHostRegistrationRepository()
  repo.tokenHashResolver = (seatId) => tokens.hashFor(seatId)
  repo.seedEvent({ cleanupId: EVENT, scheduledAt: STARTS_AT })
  const cache = new InMemoryCacheClient(() => NOW.getTime())

  const services = makeContainerRegistrationServices(container, {
    repo,
    tokens,
    counters: new InMemoryCounterStore(() => NOW.getTime()),
    insightsInvalidator: makeInsightsGeneration({ cache }),
    now: () => NOW,
  })

  const insights = makeInsightsService({
    analytics: analyticsStub(),
    registrations: repo,
    donations: makeMemoryDonationRepository({ donations: [] }),
    cache: makeHostAnalyticsCache({ cache, ttlSeconds: 300 }),
    now: () => NOW,
  })

  return { repo, services, insights }
}

function seats(partySize: number): SeatDraft[] {
  return Array.from({ length: partySize }, () => {
    const id = randomUUID()
    return { id, attendeeName: null, tokenHash: tokens.hashFor(id) }
  })
}

async function seedRegistration(
  repo: InMemoryHostRegistrationRepository,
  ticketTypeId: string,
  partySize: number,
): Promise<string> {
  const outcome = await repo.registerTx({
    cleanupId: EVENT,
    subject: { kind: "guest", guestId: randomUUID() },
    ticketTypeId,
    seats: seats(partySize),
    accessCodeHash: null,
    answers: [],
    consent: null,
    slotId: null,
    source: "self",
    idempotencyKey: `k-${randomUUID()}`,
    waitlistId: null,
    now: STARTS_AT,
  })
  if (outcome.kind !== "registered") throw new Error(`expected registered, got ${outcome.kind}`)
  return outcome.registration.id
}

describe("insights invalidation through the composed host services", () => {
  let h: Harness

  beforeEach(() => {
    h = build()
  })

  it("serves a fresh payload after the host removes an attendee", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 10, maxPartySize: 4 })
    const registrationId = await seedRegistration(h.repo, type.id, 2)
    expect((await h.insights.insights(EVENT, VIEWER)).seats.registered).toBe(2)

    await h.services.registrations.remove({ id: EVENT, registrationId, ban: false }, HOST)
    expect((await h.insights.insights(EVENT, VIEWER)).seats.registered).toBe(0)
  })

  it("serves a fresh payload after the host edits a ticket type capacity", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 10 })
    expect((await h.insights.insights(EVENT, VIEWER)).seats.capacity).toBe(10)

    await h.services.tickets.update(
      { id: EVENT, ticketTypeId: type.id, capacity: 25, visibility: "public" },
      HOST,
    )
    expect((await h.insights.insights(EVENT, VIEWER)).seats.capacity).toBe(25)
  })

  it("serves a fresh payload across a waitlist join, host promotion and claim", async () => {
    const type = h.repo.seedTicketType({
      cleanupId: EVENT,
      capacity: 2,
      maxPartySize: 4,
      waitlistEnabled: true,
    })
    const subject = { kind: "guest" as const, guestId: GUEST }

    const joined = await h.services.waitlist.join(
      { id: EVENT, ticketTypeId: type.id, partySize: 2 },
      subject,
    )
    expect((await h.insights.insights(EVENT, VIEWER)).seats.waitlisted).toBe(2)

    await h.services.waitlist.promote({ id: EVENT, waitlistId: joined.entry.id }, HOST)
    const claimed = await h.services.waitlist.claim(
      { id: EVENT, waitlistId: joined.entry.id },
      subject,
    )

    expect(claimed.outcome).toBe("claimed")
    const after = await h.insights.insights(EVENT, VIEWER)
    expect(after.seats.registered).toBe(2)
    expect(after.seats.waitlisted).toBe(0)
  })
})
