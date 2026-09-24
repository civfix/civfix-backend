import { describe, expect, it } from "vitest"
import {
  ANALYTICS_SUPPRESSION_K,
  EVENT_ANALYTICS_CARD_SLOT_ROWS,
  EVENT_ANALYTICS_COMPARISON_MIN_EVENTS,
  GetEventAnalyticsResponseSchema,
} from "@civfix/shared"
import { InMemoryCacheClient } from "../../../src/auth/cache.js"
import { makeHostAnalyticsCache } from "../../../src/services/host/host-analytics-cache.js"
import {
  analyticsPhaseOf,
  arrivalBuckets,
  makeEventAnalyticsService,
} from "../../../src/services/host/event-analytics-service.js"
import type {
  AnalyticsRepository,
  EventClockRecord,
} from "../../../src/services/host/analytics-repository.drizzle.js"
import type { EventAnalyticsRepository } from "../../../src/services/host/event-analytics-repository.drizzle.js"
import type { MetricsRepository } from "../../../src/services/host/metrics-repository.drizzle.js"

const EVENT = "00000000-0000-0000-0000-0000000000ee"
const HOST = "00000000-0000-0000-0000-0000000000aa"
const NOW = new Date("2026-02-20T00:00:00Z")

const VIEWER = { userId: HOST, organizationId: null, viewerScope: "organizer:none" }

function clock(over: Partial<EventClockRecord> = {}): EventClockRecord {
  return { ...baseClock(), ...over }
}

function baseClock(): EventClockRecord {
  return {
    status: "done",
    createdAt: new Date("2026-02-01T00:00:00Z"),
    scheduledAt: new Date("2026-02-14T17:00:00Z"),
    endsAt: new Date("2026-02-14T21:00:00Z"),
    completedAt: new Date("2026-02-14T21:30:00Z"),
    registrationClosesAt: null,
    timezone: "UTC",
  }
}

function analyticsRepo(over: Partial<AnalyticsRepository> = {}): AnalyticsRepository {
  return {
    eventKpis: () =>
      Promise.resolve({
        registered: 20,
        checkedIn: 12,
        waitlisted: 3,
        cancelled: 2,
        noShow: 1,
        capacity: 40,
      }),
    registrationsByDay: () =>
      Promise.resolve([
        { day: "2026-02-10", count: 8 },
        { day: "2026-02-18", count: 12 },
      ]),
    cancellationsByDay: () => Promise.resolve([{ day: "2026-02-11", count: 2 }]),
    registrationsByTicketType: () => Promise.resolve([]),
    registrationsByAudience: () => Promise.resolve([]),
    checkinsByTicketType: () => Promise.resolve([]),
    checkinsBySlot: () => Promise.resolve([{ key: "Trash pickup", count: 9 }]),
    arrivalOffsets: () => Promise.resolve([0, 3, 14, 16, 31, 32, 33]),
    waitlistConversion: () => Promise.resolve({ promoted: 2, joined: 3 }),
    hostedEventIds: () => Promise.resolve([EVENT]),
    portfolioTotals: () =>
      Promise.resolve({
        events: 0,
        registrations: 0,
        checkIns: 0,
        uniqueAttendees: 0,
        repeatAttendees: 0,
      }),
    portfolioByEvent: () => Promise.resolve([]),
    portfolioDayTime: () => Promise.resolve([]),
    broadcastsSent: () => Promise.resolve(0),
    eventClock: () => Promise.resolve(clock()),
    seatTrend: () => Promise.resolve([]),
    registrationsBySource: () =>
      Promise.resolve([
        { source: "self" as const, seats: 16 },
        { source: "walkup" as const, seats: 9 },
      ]),
    broadcastsForEvent: () => Promise.resolve([]),
    eventHoursTotals: () =>
      Promise.resolve({ credited: 30, attendeesCredited: 10, attendeesCheckedIn: 12 }),
    topVolunteers: () => Promise.resolve([]),
    hoursTotals: () => Promise.resolve({ credited: 0, volunteersCredited: 0 }),
    returningAttendees: () => Promise.resolve({ seats: 0, ofRegistered: 0 }),
    activityTotals: () =>
      Promise.resolve({
        registrations: 0,
        cancellations: 0,
        hoursTotal: 0,
        hoursVolunteers: 0,
        reportsLinked: 0,
        reportsResolved: 0,
        postsCreated: 0,
      }),
    heldEventTotals: () => Promise.resolve({ events: 0, registered: 0, checkedIn: 0, noShow: 0 }),
    signupsByDayAcross: () => Promise.resolve({ daily: [], byEvent: [], hoursByEvent: [] }),
    ...over,
  }
}

function eventsRepo(over: Partial<EventAnalyticsRepository> = {}): EventAnalyticsRepository {
  return {
    previousCompletedEventIds: () => Promise.resolve([]),
    facts: () =>
      Promise.resolve({ walkUps: 4, reportsLinked: 3, reportsResolved: 1, postsCreated: 7 }),
    registrationsBySlot: () =>
      Promise.resolve([
        { key: "Trash pickup", count: 10 },
        { key: "Sorting", count: 7 },
        { key: "Greeting", count: 6 },
        { key: "Cleanup", count: 5 },
      ]),
    reportStatuses: () => Promise.resolve([{ key: "resolved", count: 1 }]),
    hoursBuckets: () => Promise.resolve([{ key: "2-4h", count: 10 }]),
    comparisonMedians: () =>
      Promise.resolve({
        sampleSize: 4,
        signups: 18,
        checkInRate: 0.55,
        hoursPerVolunteer: 2.5,
        fillRate: 0.4,
      }),
    ...over,
  }
}

function metricsRepo(rows: Array<{ day: string; metric: string; bucket: string; value: number }>) {
  return {
    read: () => Promise.resolve(rows),
    readMany: () => Promise.resolve([]),
    eventTimezone: () => Promise.resolve("UTC"),
  } as unknown as MetricsRepository
}

const METRIC_ROWS = [
  { day: "2026-02-10", metric: "page_views", bucket: "", value: 100 },
  { day: "2026-02-18", metric: "page_views", bucket: "", value: 60 },
  { day: "2026-02-18", metric: "donation_clicks", bucket: "", value: 9 },
]

function service(
  over: {
    analytics?: Partial<AnalyticsRepository>
    events?: Partial<EventAnalyticsRepository>
    metrics?: Array<{ day: string; metric: string; bucket: string; value: number }>
  } = {},
) {
  return makeEventAnalyticsService({
    analytics: analyticsRepo(over.analytics),
    events: eventsRepo(over.events),
    metrics: metricsRepo(over.metrics ?? METRIC_ROWS),
    cache: makeHostAnalyticsCache({
      cache: new InMemoryCacheClient(() => NOW.getTime()),
      ttlSeconds: 60,
    }),
    now: () => NOW,
  })
}

describe("analyticsPhaseOf", () => {
  it("reads an unfinished event as upcoming", () => {
    expect(
      analyticsPhaseOf(
        clock({
          status: "upcoming",
          completedAt: null,
          endsAt: new Date("2026-03-01T00:00:00Z"),
          scheduledAt: new Date("2026-03-01T00:00:00Z"),
        }),
        NOW,
      ),
    ).toBe("upcoming")
  })

  it("reads a recently finished event as completed and an old one as archived", () => {
    expect(analyticsPhaseOf(clock(), NOW)).toBe("completed")
    expect(analyticsPhaseOf(clock(), new Date("2026-05-01T00:00:00Z"))).toBe("archived")
  })
})

describe("arrivalBuckets", () => {
  it("buckets check-in offsets into 15-minute windows keyed by minute-of-offset", () => {
    expect(arrivalBuckets([0, 3, 14, 16, 31, 32, 33])).toEqual([
      { day: "0", value: 3, suppressed: false },
      { day: "15", value: 1, suppressed: false },
      { day: "30", value: 3, suppressed: false },
    ])
  })

  it("returns nothing for an event nobody checked into", () => {
    expect(arrivalBuckets([])).toEqual([])
  })
})

describe("getEventAnalytics", () => {
  it("returns a payload the shared response schema accepts", async () => {
    const payload = await service().analytics(EVENT, "full", VIEWER)
    expect(() => GetEventAnalyticsResponseSchema.parse(payload)).not.toThrow()
    expect(payload.k).toBe(ANALYTICS_SUPPRESSION_K)
    expect(payload.scope).toBe("full")
    expect(payload.phase).toBe("completed")
  })

  it("composes the KPIs from the existing aggregates plus event_metrics_daily", async () => {
    const payload = await service().analytics(EVENT, "full", VIEWER)
    expect(payload.kpis).toMatchObject({
      signups: 20,
      capacity: 40,
      checkedIn: 12,
      pageViews: 160,
      donationClicks: 9,
      hoursTotal: 30,
      hoursVolunteers: 10,
      reportsLinked: 3,
      reportsResolved: 1,
      postsCreated: 7,
    })
  })

  it("leaves the metrics that need tracking we do not have as null", async () => {
    const payload = await service().analytics(EVENT, "full", VIEWER)
    expect(payload.kpis.uniqueViewers).toBeNull()
    expect(payload.kpis.shares).toBeNull()
  })

  it(`publishes the host's own whole-event counts exactly, including under k=${ANALYTICS_SUPPRESSION_K}`, async () => {
    const payload = await service().analytics(EVENT, "full", VIEWER)
    expect(payload.kpis.walkUps).toBe(4)
    expect(payload.kpis.waitlisted).toBe(3)
    expect(payload.kpis.cancelled).toBe(2)
    expect(payload.kpis.noShow).toBe(1)
    expect(payload.kpis.checkedIn).toBe(12)
  })

  it("derives every rate against its own denominator", async () => {
    const payload = await service().analytics(EVENT, "full", VIEWER)
    expect(payload.rates.checkIn).toMatchObject({ numerator: 12, denominator: 20 })
    expect(payload.rates.fill).toMatchObject({ numerator: 20, denominator: 40 })
    expect(payload.rates.viewToSignup).toMatchObject({ numerator: 20, denominator: 160 })
  })

  it("suppresses rates whose denominator is under k and reports raw totals honestly", async () => {
    const small = service({
      analytics: {
        eventKpis: () =>
          Promise.resolve({
            registered: 3,
            checkedIn: 1,
            waitlisted: 0,
            cancelled: 0,
            noShow: 0,
            capacity: 4,
          }),
      },
    })

    const payload = await small.analytics(EVENT, "full", VIEWER)
    expect(payload.rates.checkIn.suppressed).toBe(true)
    expect(payload.rates.checkIn.value).toBeNull()
    expect(payload.rates.fill.suppressed).toBe(true)
    expect(payload.kpis.capacity).toBe(4)
    expect(payload.kpis.signups).toBe(3)
  })

  it("survives an event with no data at all and still parses", async () => {
    const empty = service({
      analytics: {
        eventKpis: () =>
          Promise.resolve({
            registered: 0,
            checkedIn: 0,
            waitlisted: 0,
            cancelled: 0,
            noShow: 0,
            capacity: null,
          }),
        registrationsByDay: () => Promise.resolve([]),
        cancellationsByDay: () => Promise.resolve([]),
        arrivalOffsets: () => Promise.resolve([]),
        checkinsBySlot: () => Promise.resolve([]),
        waitlistConversion: () => Promise.resolve({ promoted: 0, joined: 0 }),
        registrationsBySource: () => Promise.resolve([]),
        eventHoursTotals: () =>
          Promise.resolve({ credited: 0, attendeesCredited: 0, attendeesCheckedIn: 0 }),
      },
      events: {
        facts: () =>
          Promise.resolve({
            walkUps: 0,
            reportsLinked: 0,
            reportsResolved: 0,
            postsCreated: 0,
          }),
        registrationsBySlot: () => Promise.resolve([]),
        reportStatuses: () => Promise.resolve([]),
        hoursBuckets: () => Promise.resolve([]),
      },
      metrics: [],
    })

    const payload = await empty.analytics(EVENT, "full", VIEWER)
    expect(() => GetEventAnalyticsResponseSchema.parse(payload)).not.toThrow()
    expect(payload.eventDay.arrivals).toEqual([])
    expect(payload.rates.viewToSignup.suppressed).toBe(true)
    expect(payload.kpis.hoursTotal).toBe(0)
  })

  it("trims the card scope to the panels a dashboard carousel needs", async () => {
    const payload = await service().analytics(EVENT, "card", VIEWER)
    expect(payload.scope).toBe("card")
    expect(payload.signups.daily).toEqual([])
    expect(payload.signups.cancellations).toEqual([])
    expect(payload.signups.bySource).toBeUndefined()
    expect(payload.reach.funnel).toEqual([])
    expect(payload.eventDay.bySlot).toBeUndefined()
    expect(payload.impact).toEqual({})
    expect(payload.comparison).toBeNull()
    expect(payload.signups.bySlot?.rows.length).toBeLessThanOrEqual(EVENT_ANALYTICS_CARD_SLOT_ROWS)
  })

  it("keeps the full scope's funnel and breakdown panels", async () => {
    const payload = await service().analytics(EVENT, "full", VIEWER)
    expect(payload.reach.funnel.map((step) => step.step)).toEqual([
      "signups",
      "checked_in",
      "logged_hours",
    ])
    expect(payload.signups.bySource?.rows.map((row) => row.key)).toEqual(["self", "walkup"])
    expect(payload.impact.hoursBuckets?.rows).toHaveLength(1)
    expect(payload.eventDay.bySlot?.rows).toHaveLength(1)
  })

  it("draws the funnel from the same live counts the KPI tiles show", async () => {
    const payload = await service().analytics(EVENT, "full", VIEWER)
    expect(payload.reach.funnel.map((step) => step.value)).toEqual([20, 12, 10])
    expect(payload.reach.funnel.every((step) => step.suppressed === false)).toBe(true)
    expect(payload.kpis.signups).toBe(20)
    expect(payload.kpis.checkedIn).toBe(12)
    expect(payload.kpis.hoursVolunteers).toBe(10)
  })

  it("publishes the whole-event signup count when the daily buckets are mostly under k", async () => {
    const thinDays = service({
      analytics: {
        eventClock: () => Promise.resolve(clock({ createdAt: new Date("2026-02-07T00:00:00Z") })),
        eventKpis: () =>
          Promise.resolve({
            registered: 25,
            checkedIn: 12,
            waitlisted: 3,
            cancelled: 2,
            noShow: 1,
            capacity: 40,
          }),
        registrationsByDay: () =>
          Promise.resolve([
            { day: "2026-02-07", count: 8 },
            { day: "2026-02-08", count: 7 },
            { day: "2026-02-09", count: 7 },
            { day: "2026-02-19", count: 1 },
            { day: "2026-02-20", count: 2 },
          ]),
      },
    })

    const payload = await thinDays.analytics(EVENT, "full", VIEWER)
    expect(payload.kpis.signups).toBe(25)
    expect(payload.reach.funnel[0]?.value).toBe(25)
    expect(payload.signups.daily).toHaveLength(14)
    expect(payload.signups.daily.filter((point) => point.suppressed)).toHaveLength(11)
    expect(payload.signups.cumulative.every((point) => point.suppressed)).toBe(true)
    expect(payload.signups.bySlot?.panelSuppressed).toBe(true)
    expect(payload.rates.checkIn.suppressed).toBe(true)
  })

  it("keeps rollup counts exact when the rollup has rows and null when it has none", async () => {
    const sparse = service({
      metrics: [{ day: "2026-02-18", metric: "page_views", bucket: "", value: 3 }],
    })
    const payload = await sparse.analytics(EVENT, "full", VIEWER)
    expect(payload.kpis.pageViews).toBe(3)
    expect(payload.kpis.donationClicks).toBeNull()
  })

  it("does not let an empty page-view rollup zero a funnel with live signups", async () => {
    const payload = await service({ metrics: [] }).analytics(EVENT, "full", VIEWER)
    expect(payload.kpis.pageViews).toBeNull()
    expect(payload.reach.funnel.map((step) => step.value)).toEqual([20, 12, 10])
  })

  it(`suppresses the whole funnel when its head is under k=${ANALYTICS_SUPPRESSION_K}`, async () => {
    const thin = service({
      analytics: {
        eventKpis: () =>
          Promise.resolve({
            registered: 4,
            checkedIn: 2,
            waitlisted: 0,
            cancelled: 0,
            noShow: 0,
            capacity: 10,
          }),
      },
    })
    const payload = await thin.analytics(EVENT, "full", VIEWER)
    expect(payload.reach.funnel.map((step) => step.step)).toEqual([
      "signups",
      "checked_in",
      "logged_hours",
    ])
    expect(payload.reach.funnel.every((step) => step.value === null && step.suppressed)).toBe(true)
  })

  it("clamps a funnel step that exceeds the one above it", async () => {
    const clamped = service({
      analytics: {
        eventHoursTotals: () =>
          Promise.resolve({ credited: 90, attendeesCredited: 30, attendeesCheckedIn: 12 }),
      },
    })
    const payload = await clamped.analytics(EVENT, "full", VIEWER)
    expect(payload.reach.funnel.map((step) => step.value)).toEqual([20, 12, 12])
  })

  it("returns the host's own median comparison once there is enough history", async () => {
    const withHistory = service({
      events: {
        previousCompletedEventIds: () =>
          Promise.resolve(["a", "b", "c", "d"].map((c) => c.repeat(8))),
      },
    })
    const payload = await withHistory.analytics(EVENT, "full", VIEWER)
    expect(payload.comparison).toMatchObject({
      sampleSize: 4,
      medians: { signups: 18, checkInRate: 0.55 },
    })
  })

  it(`returns no comparison under ${EVENT_ANALYTICS_COMPARISON_MIN_EVENTS} previous events`, async () => {
    const thin = service({
      events: { previousCompletedEventIds: () => Promise.resolve(["aaaaaaaa", "bbbbbbbb"]) },
    })
    expect((await thin.analytics(EVENT, "full", VIEWER)).comparison).toBeNull()
  })

  it("404s an event that does not exist", async () => {
    const missing = service({ analytics: { eventClock: () => Promise.resolve(null) } })
    await expect(missing.analytics(EVENT, "full", VIEWER)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("serves the second identical request from the shared host-analytics cache", async () => {
    let calls = 0
    const counted = service({
      events: {
        facts: () => {
          calls += 1
          return Promise.resolve({
            walkUps: 0,
            reportsLinked: 0,
            reportsResolved: 0,
            postsCreated: 0,
          })
        },
      },
    })
    await counted.analytics(EVENT, "full", VIEWER)
    await counted.analytics(EVENT, "full", VIEWER)
    expect(calls).toBe(1)
  })
})
