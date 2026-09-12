import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import {
  makeHostAnalyticsCache,
  type HostAnalyticsCache,
} from "../../src/services/host/host-analytics-cache.js"
import { InMemoryHostRegistrationRepository } from "../../src/services/host/registration-repository.memory.js"
import { makeMemoryDonationRepository } from "../../src/services/payments/donation-repository.memory.js"
import type { DonationListRow } from "../../src/services/payments/donation-repository.drizzle.js"
import {
  INSIGHTS_CACHE_TTL_SEC,
  INSIGHTS_LIVE_CACHE_TTL_SEC,
  makeInsightsService,
  type InsightsService,
  type InsightsServiceDeps,
} from "../../src/services/host/insights-service.js"
import { makeTicketTokenSigner } from "../../src/services/host/ticket-token.js"
import type { SeatDraft } from "../../src/services/host/registration-repository.types.js"
import type {
  AnalyticsRepository,
  EventClockRecord,
} from "../../src/services/host/analytics-repository.drizzle.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OTHER_EVENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const HOST = "00000000-0000-0000-0000-0000000000aa"
const STAFF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const STARTS_AT = new Date("2026-03-07T17:00:00.000Z")
const LIVE_NOW = new Date("2026-03-07T18:00:00.000Z")
const ENDED_NOW = new Date(STARTS_AT.getTime() + 30 * 3_600_000)

const tokens = makeTicketTokenSigner("host-insights-test-secret-long-enough")

class RecordingCache extends InMemoryCacheClient {
  readonly ttls = new Map<string, number>()

  override set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.ttls.set(key, ttlSeconds)
    return super.set(key, value, ttlSeconds)
  }
}

type InsightsAnalytics = InsightsServiceDeps["analytics"]

function seatDrafts(partySize: number): SeatDraft[] {
  return Array.from({ length: partySize }, () => {
    const id = randomUUID()
    return { id, attendeeName: "Ada", tokenHash: tokens.hashFor(id) }
  })
}

function clockRecord(overrides: Partial<EventClockRecord> = {}): EventClockRecord {
  return {
    status: "upcoming",
    scheduledAt: STARTS_AT,
    endsAt: null,
    completedAt: null,
    registrationClosesAt: null,
    timezone: "UTC",
    ...overrides,
  }
}

function analyticsRepo(overrides: Partial<AnalyticsRepository> = {}): InsightsAnalytics {
  return {
    eventClock: () => Promise.resolve(clockRecord()),
    seatTrend: () =>
      Promise.resolve([
        { day: "2026-03-01", added: 6, removed: 0 },
        { day: "2026-03-02", added: 4, removed: 2 },
      ]),
    registrationsBySource: () =>
      Promise.resolve([
        { source: "self", seats: 6 },
        { source: "walkup", seats: 2 },
      ]),
    broadcastsForEvent: () =>
      Promise.resolve([
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          kind: "reminder",
          finishedAt: new Date("2026-03-06T17:00:00.000Z"),
          recipients: 9,
          sent: 8,
          failed: 1,
          suppressed: 0,
        },
      ]),
    eventHoursTotals: () =>
      Promise.resolve({ credited: 12.5, attendeesCredited: 3, attendeesCheckedIn: 5 }),
    returningAttendees: () => Promise.resolve({ seats: 3, ofRegistered: 8 }),
    hostedEventIds: () => Promise.resolve([EVENT, OTHER_EVENT]),
    ...overrides,
  }
}

const DONATION: DonationListRow = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  reference: "CF-1",
  donorKey: randomUUID(),
  organizationId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  eventId: EVENT,
  userId: null,
  donorEmail: null,
  donorName: null,
  shareIdentityWithOrg: false,
  amountMinor: 5000,
  currency: "USD",
  feeBps: 200,
  feePlatformMinor: 100,
  feeStripeMinor: 175,
  netMinor: 4725,
  status: "succeeded",
  failureReason: null,
  disputeState: "none",
  refundedTotalMinor: 0,
  feeRefundedMinor: 0,
  stripeAccountId: "acct_test",
  stripeCheckoutSessionId: null,
  stripePaymentIntentId: null,
  stripeChargeId: null,
  stripeApplicationFeeId: null,
  cardBrand: null,
  cardLast4: null,
  livemode: true,
  chargedAt: new Date("2026-03-06T12:00:00.000Z"),
  sessionExpiresAt: null,
  receiptSentAt: null,
  receiptKey: null,
  receiptDocumentVersion: null,
  consentTermsVersion: null,
  consentDisclosureVersion: null,
  createdAt: new Date("2026-03-06T12:00:00.000Z"),
  lastPolledAt: null,
  orgName: "Reach Out",
  orgSlug: "reach-out",
  eventTitle: "Beach Cleanup",
}

interface Harness {
  service: InsightsService
  registrations: InMemoryHostRegistrationRepository
  cache: RecordingCache
  analyticsCache: HostAnalyticsCache
}

function build(
  overrides: Partial<AnalyticsRepository> = {},
  now: Date = LIVE_NOW,
  donations: DonationListRow[] = [DONATION],
  shared?: RecordingCache,
): Harness {
  const registrations = new InMemoryHostRegistrationRepository()
  registrations.tokenHashResolver = (seatId) => tokens.hashFor(seatId)
  registrations.seedEvent({ cleanupId: EVENT, scheduledAt: STARTS_AT })
  const cache = shared ?? new RecordingCache(() => now.getTime())
  const analyticsCache = makeHostAnalyticsCache({ cache, ttlSeconds: 120 })
  const service = makeInsightsService({
    analytics: analyticsRepo(overrides),
    registrations,
    donations: makeMemoryDonationRepository({ donations }),
    cache: analyticsCache,
    now: () => now,
  })
  return { service, registrations, cache, analyticsCache }
}

async function register(
  registrations: InMemoryHostRegistrationRepository,
  partySize: number,
): Promise<string[]> {
  const outcome = await registrations.registerTx({
    cleanupId: EVENT,
    subject: { kind: "user", userId: randomUUID() },
    ticketTypeId: null,
    seats: seatDrafts(partySize),
    accessCodeHash: null,
    answers: [],
    consent: null,
    slotId: null,
    source: "self",
    idempotencyKey: `k-${randomUUID()}`,
    waitlistId: null,
    now: new Date("2026-03-01T12:00:00.000Z"),
  })
  if (outcome.kind !== "registered") throw new Error(`expected registered, got ${outcome.kind}`)
  return outcome.registration.seats.map((seat) => seat.id)
}

const VIEWER = { userId: HOST, canViewDonations: true, viewerScope: "organizer:none" }

describe("event insights", () => {
  it("counts seats, not registration rows", async () => {
    const h = build()
    await register(h.registrations, 4)
    await register(h.registrations, 2)
    const payload = await h.service.insights(EVENT, VIEWER)
    expect(payload.seats.registered).toBe(6)
  })

  it("derives the phase from the event clock at each boundary", async () => {
    const cases: [Date, string][] = [
      [new Date(STARTS_AT.getTime() - 3 * 3_600_000), "upcoming"],
      [new Date(STARTS_AT.getTime() - 2 * 3_600_000), "live"],
      [STARTS_AT, "live"],
      [new Date(STARTS_AT.getTime() + 4 * 3_600_000), "live"],
      [new Date(STARTS_AT.getTime() + 6 * 3_600_000), "ended"],
    ]
    for (const [at, phase] of cases) {
      const h = build({}, at)
      expect((await h.service.insights(EVENT, VIEWER)).phase).toBe(phase)
    }
  })

  it("calls a cancelled event cancelled and a completed event ended", async () => {
    const cancelled = build({ eventClock: () => Promise.resolve(clockRecord({ status: "cancelled" })) })
    expect((await cancelled.service.insights(EVENT, VIEWER)).phase).toBe("cancelled")

    const done = build({
      eventClock: () =>
        Promise.resolve(
          clockRecord({ status: "done", completedAt: new Date("2026-03-07T21:00:00.000Z") }),
        ),
    })
    expect((await done.service.insights(EVENT, VIEWER)).phase).toBe("ended")
  })

  it("clamps unmarked seats at zero and never goes negative", async () => {
    const h = build()
    const seatIds = await register(h.registrations, 3)
    await h.registrations.checkInSeat({
      cleanupId: EVENT,
      seatId: seatIds[0] as string,
      actorId: STAFF,
      method: "manual",
      now: LIVE_NOW,
    })
    const payload = await h.service.insights(EVENT, VIEWER)
    expect(payload.seats.checkedIn).toBe(1)
    expect(payload.seats.unmarked).toBe(2)
  })

  it("cumulates the registration trend and reports cancelled seats from its removals", async () => {
    const h = build()
    const payload = await h.service.insights(EVENT, VIEWER)
    expect(payload.registrationTrend).toEqual([
      { day: "2026-03-01", seats: 6 },
      { day: "2026-03-02", seats: 8 },
    ])
    expect(payload.seats.cancelled).toBe(2)
  })

  it("expresses arrivals as offsets from the start time", async () => {
    const h = build()
    const seatIds = await register(h.registrations, 2)
    await h.registrations.checkInSeat({
      cleanupId: EVENT,
      seatId: seatIds[0] as string,
      actorId: STAFF,
      method: "manual",
      now: new Date(STARTS_AT.getTime() + 20 * 60_000),
    })
    await h.registrations.checkInSeat({
      cleanupId: EVENT,
      seatId: seatIds[1] as string,
      actorId: STAFF,
      method: "manual",
      now: new Date(STARTS_AT.getTime() + 22 * 60_000),
    })
    const payload = await h.service.insights(EVENT, VIEWER)
    expect(payload.arrivals).toEqual([{ offsetMin: 15, seats: 2 }])
  })

  it("drops an arrival that falls outside the offset window instead of clamping it", async () => {
    const h = build()
    const seatIds = await register(h.registrations, 2)
    await h.registrations.checkInSeat({
      cleanupId: EVENT,
      seatId: seatIds[0] as string,
      actorId: STAFF,
      method: "manual",
      now: new Date(STARTS_AT.getTime() + 10 * 3_600_000),
    })
    await h.registrations.checkInSeat({
      cleanupId: EVENT,
      seatId: seatIds[1] as string,
      actorId: STAFF,
      method: "manual",
      now: new Date(STARTS_AT.getTime() + 20 * 60_000),
    })
    const payload = await h.service.insights(EVENT, VIEWER)
    expect(payload.arrivals).toEqual([{ offsetMin: 15, seats: 1 }])
  })

  it("drops an arrival recorded long before the doors open", async () => {
    const h = build()
    const seatIds = await register(h.registrations, 1)
    await h.registrations.checkInSeat({
      cleanupId: EVENT,
      seatId: seatIds[0] as string,
      actorId: STAFF,
      method: "manual",
      now: new Date(STARTS_AT.getTime() - 5 * 3_600_000),
    })
    const payload = await h.service.insights(EVENT, VIEWER)
    expect(payload.arrivals).toEqual([])
  })

  it("returns no arrivals once check-in times have been coarsened", async () => {
    const past = new Date(STARTS_AT.getTime() + 45 * 86_400_000)
    const h = build({ eventClock: () => Promise.resolve(clockRecord({ status: "done" })) }, past)
    const seatIds = await register(h.registrations, 1)
    await h.registrations.checkInSeat({
      cleanupId: EVENT,
      seatId: seatIds[0] as string,
      actorId: STAFF,
      method: "manual",
      now: new Date(STARTS_AT.getTime() + 20 * 60_000),
    })
    const payload = await h.service.insights(EVENT, VIEWER)
    expect(payload.arrivals).toEqual([])
  })

  it("hides money from a viewer without the donations capability", async () => {
    const h = build()
    const payload = await h.service.insights(EVENT, {
      userId: HOST,
      canViewDonations: false,
      viewerScope: "coordinator:none",
    })
    expect(payload.money).toBeNull()
  })

  it("totals this event's settled donations for a viewer who may see them", async () => {
    const h = build()
    const payload = await h.service.insights(EVENT, VIEWER)
    expect(payload.money).toEqual({
      currency: "USD",
      donationCount: 1,
      grossMinor: 5000,
      netMinor: 4725,
      refundedMinor: 0,
      lastChargedAt: "2026-03-06T12:00:00.000Z",
    })
  })

  it("nets below zero once a donation has been fully refunded", async () => {
    const h = build({}, LIVE_NOW, [
      { ...DONATION, status: "refunded", refundedTotalMinor: 5000, feeRefundedMinor: 100 },
    ])
    const payload = await h.service.insights(EVENT, VIEWER)
    expect(payload.money).toEqual({
      currency: "USD",
      donationCount: 1,
      grossMinor: 5000,
      netMinor: -275,
      refundedMinor: 5000,
      lastChargedAt: "2026-03-06T12:00:00.000Z",
    })
  })

  it("leaves donations off an event that has none", async () => {
    const h = build({}, LIVE_NOW, [{ ...DONATION, eventId: OTHER_EVENT }])
    const payload = await h.service.insights(EVENT, VIEWER)
    expect(payload.money).toMatchObject({ donationCount: 0, grossMinor: 0, lastChargedAt: null })
  })

  it("reports no returning volunteers until the host has a second event", async () => {
    const h = build({ hostedEventIds: () => Promise.resolve([EVENT]) }, ENDED_NOW)
    const payload = await h.service.insights(EVENT, VIEWER)
    expect(payload.returning).toBeNull()
  })

  it("reports returning volunteers once the host has more than one event", async () => {
    const h = build({}, ENDED_NOW)
    const payload = await h.service.insights(EVENT, VIEWER)
    expect(payload.returning).toEqual({ seats: 3, ofRegistered: 8 })
  })

  it("leaves the host portfolio unread until the event has ended", async () => {
    let portfolioReads = 0
    const hostedEventIds = (): Promise<string[]> => {
      portfolioReads += 1
      return Promise.resolve([EVENT, OTHER_EVENT])
    }
    const live = build({ hostedEventIds })
    expect((await live.service.insights(EVENT, VIEWER)).returning).toBeNull()
    expect(portfolioReads).toBe(0)

    const ended = build({ hostedEventIds }, ENDED_NOW)
    expect((await ended.service.insights(EVENT, VIEWER)).returning).not.toBeNull()
    expect(portfolioReads).toBe(1)
  })

  it("caches a live event for seconds and a settled one for minutes", async () => {
    const live = build()
    await live.service.insights(EVENT, VIEWER)
    expect(live.cache.ttls.get(`hostan:v1:insights:${EVENT}:event:organizer:none:${HOST}:g0`)).toBe(
      INSIGHTS_LIVE_CACHE_TTL_SEC,
    )

    const ended = build({}, new Date(STARTS_AT.getTime() + 30 * 3_600_000))
    await ended.service.insights(EVENT, VIEWER)
    expect(
      ended.cache.ttls.get(`hostan:v1:insights:${EVENT}:event:ended:organizer:none:${HOST}:g0`),
    ).toBe(INSIGHTS_CACHE_TTL_SEC)
  })

  it("keeps one viewer's payload out of another viewer's cache entry", async () => {
    const h = build()
    await register(h.registrations, 2)
    const host = await h.service.insights(EVENT, VIEWER)
    const other = await h.service.insights(EVENT, {
      userId: STAFF,
      canViewDonations: false,
      viewerScope: "organizer:none",
    })
    expect(host.money).not.toBeNull()
    expect(other.money).toBeNull()
  })

  it("computes nothing twice inside the cache window", async () => {
    let calls = 0
    const h = build({
      seatTrend: () => {
        calls += 1
        return Promise.resolve([])
      },
    })
    await h.service.insights(EVENT, VIEWER)
    await h.service.insights(EVENT, VIEWER)
    expect(calls).toBe(1)
  })

  it("refuses an event that does not exist", async () => {
    const h = build({ eventClock: () => Promise.resolve(null) })
    await expect(h.service.insights(EVENT, VIEWER)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("carries the broadcast outcome counts without any open or click field", async () => {
    const h = build()
    const payload = await h.service.insights(EVENT, VIEWER)
    expect(payload.broadcasts).toEqual([
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        kind: "reminder",
        finishedAt: "2026-03-06T17:00:00.000Z",
        recipients: 9,
        sent: 8,
        failed: 1,
        suppressed: 0,
      },
    ])
    expect(JSON.stringify(payload)).not.toMatch(/"opens"|"clicks"/)
  })

  it("passes the hours and source rollups through untouched", async () => {
    const h = build()
    const payload = await h.service.insights(EVENT, VIEWER)
    expect(payload.hours).toEqual({ credited: 12.5, attendeesCredited: 3, attendeesCheckedIn: 5 })
    expect(payload.bySource).toEqual([
      { source: "self", seats: 6 },
      { source: "walkup", seats: 2 },
    ])
  })
  it("serves the cached rollups but reports the phase and clock live", async () => {
    const shared = new RecordingCache(() => LIVE_NOW.getTime())
    const live = build({}, LIVE_NOW, [DONATION], shared)
    await register(live.registrations, 2)
    const first = await live.service.insights(EVENT, VIEWER)
    expect(first.phase).toBe("live")
    expect(first.seats.registered).toBe(2)

    const cancelled = build(
      { eventClock: () => Promise.resolve(clockRecord({ status: "cancelled" })) },
      LIVE_NOW,
      [DONATION],
      shared,
    )
    const second = await cancelled.service.insights(EVENT, VIEWER)
    expect(second.seats.registered).toBe(2)
    expect(second.phase).toBe("cancelled")
    expect(second.clock.status).toBe("cancelled")
  })

  it("recomputes once the event generation has been bumped", async () => {
    const shared = new RecordingCache(() => LIVE_NOW.getTime())
    const first = build({}, LIVE_NOW, [DONATION], shared)
    await register(first.registrations, 2)
    expect((await first.service.insights(EVENT, VIEWER)).seats.registered).toBe(2)

    const stale = build({}, LIVE_NOW, [DONATION], shared)
    expect((await stale.service.insights(EVENT, VIEWER)).seats.registered).toBe(2)

    await first.analyticsCache.bumpInsightsGeneration(EVENT)
    const fresh = build({}, LIVE_NOW, [DONATION], shared)
    expect((await fresh.service.insights(EVENT, VIEWER)).seats.registered).toBe(0)
  })

  it("keys the cached payload by the event generation", async () => {
    const h = build()
    await h.analyticsCache.bumpInsightsGeneration(EVENT)
    await h.service.insights(EVENT, VIEWER)
    expect([...h.cache.ttls.keys()]).toContain(
      `hostan:v1:insights:${EVENT}:event:organizer:none:${HOST}:g1`,
    )
  })

  it("leaves another event's generation alone when one event is bumped", async () => {
    const shared = new RecordingCache(() => LIVE_NOW.getTime())
    const first = build({}, LIVE_NOW, [DONATION], shared)
    await register(first.registrations, 2)
    await first.service.insights(EVENT, VIEWER)

    await first.analyticsCache.bumpInsightsGeneration(OTHER_EVENT)
    const after = build({}, LIVE_NOW, [DONATION], shared)
    expect((await after.service.insights(EVENT, VIEWER)).seats.registered).toBe(2)
  })
  it("never serves a pre-ended payload once the event has ended", async () => {
    const shared = new RecordingCache(() => ENDED_NOW.getTime())
    const live = build({}, LIVE_NOW, [DONATION], shared)
    await register(live.registrations, 2)
    expect((await live.service.insights(EVENT, VIEWER)).returning).toBeNull()

    const ended = build({}, ENDED_NOW, [DONATION], shared)
    expect((await ended.service.insights(EVENT, VIEWER)).returning).toEqual({
      seats: 3,
      ofRegistered: 8,
    })
  })
})
