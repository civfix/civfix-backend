import { TEST_TICKET_SIGNER } from "../../helpers/ticket-signer.js"
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
  type InsightsGeneration,
} from "../../../src/services/host/host-analytics-cache.js"
import { makeCleanupService, type CleanupService } from "../../../src/services/cleanup-service.js"
import { InMemoryCleanupRepository } from "../../helpers/cleanups.js"
import {
  makeInsightsService,
  type InsightsService,
} from "../../../src/services/host/insights-service.js"
import { makeTicketTokenSigner } from "../../../src/services/host/ticket-token.js"
import type { InsightsServiceDeps } from "../../../src/services/host/insights-service.js"
import type { SeatDraft } from "../../../src/services/host/registration-repository.types.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const HOST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const GUEST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const STARTS_AT = new Date("2026-03-07T17:00:00.000Z")
const NOW = new Date("2026-03-07T18:00:00.000Z")

const tokens = makeTicketTokenSigner("insights-wiring-test-secret-long-enough")

const VIEWER = { userId: HOST, viewerScope: "organizer:none" }

function analyticsStub(): InsightsServiceDeps["analytics"] {
  return {
    eventClock: () =>
      Promise.resolve({
        status: "upcoming" as const,
        createdAt: STARTS_AT,
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
    topVolunteers: () => Promise.resolve([]),
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

const SLOT_EVENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const ORGANIZER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const VOLUNTEER = "ffffffff-ffff-4fff-8fff-ffffffffffff"
const OTHER_VOLUNTEER = "11111111-1111-4111-8111-111111111111"
const FUTURE = new Date(Date.now() + 7 * 86_400_000)
const PAST = new Date(Date.now() - 30 * 86_400_000)

interface CleanupHarness {
  repo: InMemoryCleanupRepository
  service: CleanupService
  generation: InsightsGeneration
}

function buildCleanupHarness(
  over: { status?: "upcoming" | "done" | "cancelled"; scheduledAt?: Date } = {},
): CleanupHarness {
  const repo = new InMemoryCleanupRepository()
  const generation = makeInsightsGeneration({ cache: new InMemoryCacheClient(() => NOW.getTime()) })
  repo.seedUser({ id: ORGANIZER, displayName: "Olive Organizer", handle: "olive-insights" })
  repo.seedUser({ id: VOLUNTEER, displayName: "Vic Volunteer", handle: "vic-insights" })
  repo.seedUser({ id: OTHER_VOLUNTEER, displayName: "Van Volunteer", handle: "van-insights" })
  repo.seedCleanup({
    id: SLOT_EVENT,
    organizerUserId: ORGANIZER,
    scheduledAt: over.scheduledAt ?? FUTURE,
    ...(over.status !== undefined ? { status: over.status } : {}),
  })
  const service = makeCleanupService({
    tickets: TEST_TICKET_SIGNER,
    repo,
    counters: new InMemoryCounterStore(() => NOW.getTime()),
    insightsInvalidator: generation,
  })
  return { repo, service, generation }
}

describe("insights invalidation through the cleanup service", () => {
  it("bumps on a slot claim, a slot move and a release", async () => {
    const h = buildCleanupHarness()
    const grill = h.repo.seedSlot({ cleanupId: SLOT_EVENT, title: "Grill" })
    const gate = h.repo.seedSlot({ cleanupId: SLOT_EVENT, title: "Gate" })
    expect(await h.generation.generationOf(SLOT_EVENT)).toBe("0")

    await h.service.claimEventSlot(SLOT_EVENT, VOLUNTEER, grill.id)
    expect(await h.generation.generationOf(SLOT_EVENT)).toBe("1")

    await h.service.claimEventSlot(SLOT_EVENT, VOLUNTEER, gate.id)
    expect(await h.generation.generationOf(SLOT_EVENT)).toBe("2")

    await h.service.claimEventSlot(SLOT_EVENT, VOLUNTEER, null)
    expect(await h.generation.generationOf(SLOT_EVENT)).toBe("3")
  })

  it("bumps when a volunteer joins and leaves the event", async () => {
    const h = buildCleanupHarness()

    await h.service.joinCleanup(SLOT_EVENT, VOLUNTEER)
    expect(await h.generation.generationOf(SLOT_EVENT)).toBe("1")

    await h.service.leaveCleanup(SLOT_EVENT, VOLUNTEER)
    expect(await h.generation.generationOf(SLOT_EVENT)).toBe("2")
  })

  it("bumps when a host removes an attendee", async () => {
    const h = buildCleanupHarness()
    h.repo.seedMember(SLOT_EVENT, VOLUNTEER, "member")

    await h.service.removeMember(SLOT_EVENT, ORGANIZER, VOLUNTEER)
    expect(await h.generation.generationOf(SLOT_EVENT)).toBe("1")
  })

  it("does not bump when the slot is already full", async () => {
    const h = buildCleanupHarness()
    const grill = h.repo.seedSlot({ cleanupId: SLOT_EVENT, title: "Grill", capacity: 1 })
    await h.service.claimEventSlot(SLOT_EVENT, VOLUNTEER, grill.id)
    expect(await h.generation.generationOf(SLOT_EVENT)).toBe("1")

    await expect(
      h.service.claimEventSlot(SLOT_EVENT, OTHER_VOLUNTEER, grill.id),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect(await h.generation.generationOf(SLOT_EVENT)).toBe("1")
  })

  it("does not bump when the event has already ended", async () => {
    const h = buildCleanupHarness({ scheduledAt: PAST })
    const grill = h.repo.seedSlot({ cleanupId: SLOT_EVENT, title: "Grill" })

    await expect(h.service.claimEventSlot(SLOT_EVENT, VOLUNTEER, grill.id)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    await expect(h.service.joinCleanup(SLOT_EVENT, VOLUNTEER)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    expect(await h.generation.generationOf(SLOT_EVENT)).toBe("0")
  })

  it("does not bump when the event is closed", async () => {
    const h = buildCleanupHarness({ status: "cancelled" })
    const grill = h.repo.seedSlot({ cleanupId: SLOT_EVENT, title: "Grill" })

    await expect(h.service.claimEventSlot(SLOT_EVENT, VOLUNTEER, grill.id)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    await expect(h.service.claimEventSlot(SLOT_EVENT, VOLUNTEER, null)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    await expect(h.service.joinCleanup(SLOT_EVENT, VOLUNTEER)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    await expect(h.service.leaveCleanup(SLOT_EVENT, VOLUNTEER)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    expect(await h.generation.generationOf(SLOT_EVENT)).toBe("0")
  })

  it("does not bump when a removed attendee tries the slot door", async () => {
    const h = buildCleanupHarness()
    const grill = h.repo.seedSlot({ cleanupId: SLOT_EVENT, title: "Grill" })
    h.repo.seedMember(SLOT_EVENT, VOLUNTEER, "member")
    await h.service.removeMember(SLOT_EVENT, ORGANIZER, VOLUNTEER)
    const afterRemoval = await h.generation.generationOf(SLOT_EVENT)

    await expect(h.service.claimEventSlot(SLOT_EVENT, VOLUNTEER, grill.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(h.service.joinCleanup(SLOT_EVENT, VOLUNTEER)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    expect(await h.generation.generationOf(SLOT_EVENT)).toBe(afterRemoval)
  })
})
