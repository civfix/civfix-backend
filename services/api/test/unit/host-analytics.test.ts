import { describe, expect, it } from "vitest"
import {
  avatarGradient,
  HostAnalyticsSummaryResponseSchema,
  HostedEventsAnalyticsResponseSchema,
  MAX_PORTFOLIO_TOP_VOLUNTEERS,
} from "@civfix/shared"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import {
  hostAnalyticsCacheKey,
  makeHostAnalyticsCache,
} from "../../src/services/host/host-analytics-cache.js"
import { makeAnalyticsService } from "../../src/services/host/analytics-service.js"
import type { AnalyticsRepository } from "../../src/services/host/analytics-repository.drizzle.js"
import type { MetricsRepository } from "../../src/services/host/metrics-repository.drizzle.js"

const EVENT = "00000000-0000-0000-0000-0000000000ee"
const EVENT_A = "11111111-1111-4111-8111-111111111111"
const EVENT_B = "22222222-2222-4222-8222-222222222222"
const NOW = new Date("2026-02-10T00:00:00Z")

function analyticsRepo(overrides: Partial<AnalyticsRepository> = {}): AnalyticsRepository {
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
    registrationsByDay: () => Promise.resolve([{ day: "2026-02-09", count: 20 }]),
    cancellationsByDay: () => Promise.resolve([]),
    registrationsByTicketType: () =>
      Promise.resolve([
        { key: "General", count: 18 },
        { key: "VIP", count: 2 },
      ]),
    registrationsByAudience: () => Promise.resolve([{ key: "member", count: 20 }]),
    checkinsByTicketType: () => Promise.resolve([{ key: "General", count: 12 }]),
    checkinsBySlot: () => Promise.resolve([]),
    arrivalOffsets: () => Promise.resolve([0, 5, 10, 15, 20, 25, 30]),
    waitlistConversion: () => Promise.resolve({ promoted: 2, joined: 3 }),
    hostedEventIds: () => Promise.resolve([EVENT]),
    portfolioTotals: () =>
      Promise.resolve({
        events: 1,
        registrations: 20,
        checkIns: 12,
        uniqueAttendees: 18,
        repeatAttendees: 6,
      }),
    portfolioByEvent: () => Promise.resolve([{ key: "Beach Cleanup", count: 20 }]),
    portfolioDayTime: () => Promise.resolve([{ weekday: 6, hour: 9, count: 20 }]),
    broadcastsSent: () => Promise.resolve(4),
    eventClock: () =>
      Promise.resolve({
        status: "active" as const,
        createdAt: new Date("2026-02-01T17:00:00Z"),
        scheduledAt: new Date("2026-02-14T17:00:00Z"),
        endsAt: null,
        completedAt: null,
        registrationClosesAt: null,
        timezone: "UTC",
      }),
    seatTrend: () => Promise.resolve([{ day: "2026-02-09", added: 20, removed: 0 }]),
    registrationsBySource: () => Promise.resolve([{ source: "self" as const, seats: 20 }]),
    broadcastsForEvent: () => Promise.resolve([]),
    eventHoursTotals: () =>
      Promise.resolve({ credited: 0, attendeesCredited: 0, attendeesCheckedIn: 0 }),
    returningAttendees: () => Promise.resolve({ seats: 0, ofRegistered: 0 }),
    topVolunteers: () => Promise.resolve([]),
    hoursTotals: () => Promise.resolve({ credited: 0, volunteersCredited: 0 }),
    activityTotals: () =>
      Promise.resolve({
        registrations: 20,
        cancellations: 2,
        hoursTotal: 48.755,
        hoursVolunteers: 11,
        reportsLinked: 3,
        reportsResolved: 1,
        postsCreated: 7,
      }),
    heldEventTotals: () =>
      Promise.resolve({ events: 2, registered: 20, checkedIn: 12, noShow: 1 }),
    signupsByDayAcross: () =>
      Promise.resolve({
        daily: [
          { day: "2026-02-08", count: 6 },
          { day: "2026-02-09", count: 2 },
          { day: "2026-02-10", count: 7 },
        ],
        byEvent: [
          { key: EVENT_A, label: "Beach Cleanup", count: 12 },
          { key: EVENT_B, label: "Park Cleanup", count: 3 },
        ],
        hoursByEvent: [{ key: EVENT_A, label: "Beach Cleanup", count: 31 }],
      }),
    ...overrides,
  }
}

function metricsRepo(rows: Parameters<MetricsRepository["upsertExact"]>[0] = []): MetricsRepository {
  return {
    resolveSlug: () => Promise.resolve(null),
    eventTimezone: () => Promise.resolve("UTC"),
    listRollupEvents: () => Promise.resolve([]),
    recomputeFromSource: () => Promise.resolve([]),
    upsertExact: () => Promise.resolve(),
    upsertGreatest: () => Promise.resolve(),
    read: () =>
      Promise.resolve(rows.map((r) => ({ day: r.day, metric: r.metric, bucket: r.bucket, value: r.value }))),
    readMany: () =>
      Promise.resolve(rows.map((r) => ({ day: r.day, metric: r.metric, bucket: r.bucket, value: r.value }))),
  }
}

function build(overrides: Partial<AnalyticsRepository> = {}, metricRows: Parameters<MetricsRepository["upsertExact"]>[0] = []) {
  const cache = new InMemoryCacheClient()
  const service = makeAnalyticsService({
    analytics: analyticsRepo(overrides),
    metrics: metricsRepo(metricRows),
    cache: makeHostAnalyticsCache({ cache, ttlSeconds: 120 }),
    now: () => NOW,
  })
  return { service, cache }
}

const PAGE_VIEW_ROWS = [
  { cleanupId: EVENT, day: "2026-02-09", metric: "page_views", bucket: "all", value: 100 },
]

describe("host analytics envelopes", () => {
  it("echoes k=5 and the range on every event envelope", async () => {
    const { service } = build()
    for (const payload of [
      await service.overview(EVENT, "30d", "organizer:none"),
      await service.registrations(EVENT, "30d", "organizer:none"),
      await service.checkins(EVENT, "30d", "organizer:none"),
      await service.broadcasts(EVENT, "30d", "organizer:none"),
      await service.sources(EVENT, "30d", "organizer:none"),
    ]) {
      expect(payload.k).toBe(5)
      expect(payload.range).toBe("30d")
      expect(payload.generatedAt).toBe(NOW.toISOString())
    }
  })

  it("carries no opens or clicks field anywhere", async () => {
    const { service } = build()
    const payload = JSON.stringify(await service.broadcasts(EVENT, "30d", "organizer:none"))
    expect(payload).not.toMatch(/"opens"/)
    expect(payload).not.toMatch(/"clicks"/)
  })

  it("suppresses a count below k rather than showing it", async () => {
    const { service } = build({
      eventKpis: () =>
        Promise.resolve({
          registered: 4,
          checkedIn: 2,
          waitlisted: 0,
          cancelled: 0,
          noShow: 0,
          capacity: 10,
        }),
    })
    const payload = await service.overview(EVENT, "30d", "organizer:none")
    expect(payload.kpis.registered).toBeNull()
    expect(payload.kpis.checkedIn).toBeNull()
  })

  it("shows a count at exactly k", async () => {
    const { service } = build({
      eventKpis: () =>
        Promise.resolve({
          registered: 5,
          checkedIn: 5,
          waitlisted: 0,
          cancelled: 0,
          noShow: 0,
          capacity: 10,
        }),
    })
    const payload = await service.overview(EVENT, "30d", "organizer:none")
    expect(payload.kpis.registered).toBe(5)
  })

  it("returns null (never 0) for a rate whose denominator is below k", async () => {
    const { service } = build({
      eventKpis: () =>
        Promise.resolve({
          registered: 3,
          checkedIn: 0,
          waitlisted: 0,
          cancelled: 0,
          noShow: 0,
          capacity: 10,
        }),
    })
    const payload = await service.overview(EVENT, "30d", "organizer:none")
    expect(payload.checkInRate.value).toBeNull()
    expect(payload.checkInRate.suppressed).toBe(true)
    expect(payload.checkInRate.numerator).toBeNull()
    expect(payload.checkInRate.denominator).toBeNull()
  })

  it("keeps the registered KPI and yields the whole panel a shown row would pin", async () => {
    const overrides = {
      eventKpis: () =>
        Promise.resolve({
          registered: 23,
          checkedIn: 12,
          waitlisted: 3,
          cancelled: 0,
          noShow: 1,
          capacity: 40,
        }),
      registrationsByDay: () => Promise.resolve([{ day: "2026-02-09", count: 23 }]),
      registrationsByTicketType: () =>
        Promise.resolve([
          { key: "General", count: 20 },
          { key: "VIP", count: 3 },
        ]),
    }
    const { service } = build(overrides, PAGE_VIEW_ROWS)
    const overview = await service.overview(EVENT, "30d", "organizer:none")
    expect(overview.kpis.registered).toBe(23)

    const registrations = await service.registrations(EVENT, "30d", "organizer:none")
    expect(registrations.byTicketType.panelSuppressed).toBe(true)
    expect(registrations.byTicketType.rows).toEqual([])
  })

  it("cascades past both small rows rather than let the KPI pin either of them", async () => {
    const { service } = build(
      {
        eventKpis: () =>
          Promise.resolve({
            registered: 27,
            checkedIn: 12,
            waitlisted: 0,
            cancelled: 0,
            noShow: 1,
            capacity: 40,
          }),
        registrationsByDay: () => Promise.resolve([{ day: "2026-02-09", count: 27 }]),
        registrationsByTicketType: () =>
          Promise.resolve([
            { key: "General", count: 20 },
            { key: "VIP", count: 3 },
            { key: "Press", count: 4 },
          ]),
      },
      PAGE_VIEW_ROWS,
    )
    const overview = await service.overview(EVENT, "30d", "organizer:none")
    expect(overview.kpis.registered).toBe(27)

    const registrations = await service.registrations(EVENT, "30d", "organizer:none")
    expect(registrations.byTicketType.panelSuppressed).toBe(true)
    expect(registrations.byTicketType.rows).toEqual([])
  })

  it("keeps a breakdown whose hidden rows already sit inside the band", async () => {
    const { service } = build({
      eventKpis: () =>
        Promise.resolve({
          registered: 24,
          checkedIn: 12,
          waitlisted: 0,
          cancelled: 0,
          noShow: 1,
          capacity: 40,
        }),
      registrationsByDay: () => Promise.resolve([{ day: "2026-02-09", count: 24 }]),
      registrationsByTicketType: () =>
        Promise.resolve([
          { key: "General", count: 20 },
          { key: "VIP", count: 2 },
          { key: "Press", count: 2 },
        ]),
    })
    const payload = await service.registrations(EVENT, "30d", "organizer:none")
    const rows = payload.byTicketType.rows
    expect(payload.byTicketType.panelSuppressed).toBe(false)
    expect(rows.find((r) => r.key === "General")?.value).toBe(20)
    expect(rows.find((r) => r.key === "VIP")?.value).toBeNull()
    expect(rows.find((r) => r.key === "VIP")?.suppressed).toBe(true)
  })

  it("suppresses the breakdowns of a registered count the series already withheld", async () => {
    const { service } = build({
      registrationsByDay: () =>
        Promise.resolve([
          { day: "2026-02-08", count: 6 },
          { day: "2026-02-09", count: 2 },
          { day: "2026-02-10", count: 7 },
        ]),
      registrationsByTicketType: () =>
        Promise.resolve([
          { key: "General", count: 10 },
          { key: "VIP", count: 5 },
        ]),
      registrationsByAudience: () => Promise.resolve([{ key: "member", count: 15 }]),
    })
    const payload = await service.registrations(EVENT, "30d", "organizer:none")
    expect(payload.byTicketType.panelSuppressed).toBe(true)
    expect(payload.byTicketType.rows).toEqual([])
    expect(payload.byAudience.panelSuppressed).toBe(true)
    expect(payload.byAudience.rows).toEqual([])
  })

  it("hides a broadcast channel column the daily send series would pin", async () => {
    const { service } = build({}, [
      { cleanupId: EVENT, day: "2026-02-09", metric: "broadcast_sent", bucket: "email", value: 20 },
      { cleanupId: EVENT, day: "2026-02-09", metric: "broadcast_sent", bucket: "push", value: 3 },
    ])
    const payload = await service.broadcasts(EVENT, "30d", "organizer:none")
    const byChannel = new Map(payload.byChannel.map((row) => [row.channel, row.sent]))
    expect(byChannel.get("email")).toBeNull()
    expect(byChannel.get("push")).toBeNull()
  })

  it("publishes every portfolio day exactly, sub-k days included", async () => {
    const { service } = build({}, [
      { cleanupId: EVENT, day: "2026-02-08", metric: "registrations", bucket: "", value: 6 },
      { cleanupId: EVENT, day: "2026-02-09", metric: "registrations", bucket: "", value: 2 },
      { cleanupId: EVENT, day: "2026-02-10", metric: "registrations", bucket: "", value: 7 },
    ])
    const payload = await service.portfolio(
      "00000000-0000-0000-0000-0000000000aa",
      null,
      "90d",
      "self",
    )
    expect(payload.series.filter((p) => p.value !== 0).map((p) => p.value)).toEqual([6, 2, 7])
    expect(payload.series.every((p) => p.suppressed === false)).toBe(true)
    expect(payload.totals.registrations).toBe(20)
    expect(payload.averageCheckInRate.suppressed).toBe(false)
    expect(payload.averageCheckInRate.numerator).toBe(12)
    expect(payload.byEvent.panelSuppressed).toBe(false)
    expect(payload.byEvent.rows.find((r) => r.key === "Beach Cleanup")?.value).toBe(20)
    expect(payload.bestDayTime).toMatchObject({ weekday: 6, hour: 9, suppressed: false })
  })

  it("publishes a sub-k portfolio breakdown row rather than hiding it", async () => {
    const { service } = build({
      portfolioTotals: () =>
        Promise.resolve({
          events: 2,
          registrations: 5,
          checkIns: 3,
          uniqueAttendees: 4,
          repeatAttendees: 1,
        }),
      portfolioByEvent: () =>
        Promise.resolve([
          { key: "Beach Cleanup", count: 4 },
          { key: "Park Cleanup", count: 1 },
        ]),
    })
    const payload = await service.portfolio(
      "00000000-0000-0000-0000-0000000000aa",
      null,
      "90d",
      "self",
    )
    expect(payload.totals.registrations).toBe(5)
    expect(payload.totals.uniqueAttendees).toBe(4)
    expect(payload.byEvent.rows.map((row) => row.value)).toEqual([4, 1])
    expect(payload.byEvent.rows.every((row) => row.suppressed === false)).toBe(true)
    expect(payload.repeatAttendance.value).toBeCloseTo(1 / 4, 4)
    expect(payload.repeatAttendance.suppressed).toBe(false)
  })

  it("still echoes k on the portfolio envelope for older clients", async () => {
    const { service } = build()
    const payload = await service.portfolio(
      "00000000-0000-0000-0000-0000000000aa",
      null,
      "90d",
      "self",
    )
    expect(payload.k).toBe(5)
  })

  it("keeps a rate null when its denominator is zero", async () => {
    const { service } = build({
      portfolioTotals: () =>
        Promise.resolve({
          events: 0,
          registrations: 0,
          checkIns: 0,
          uniqueAttendees: 0,
          repeatAttendees: 0,
        }),
    })
    const payload = await service.portfolio(
      "00000000-0000-0000-0000-0000000000aa",
      null,
      "90d",
      "self",
    )
    expect(payload.averageCheckInRate.value).toBeNull()
    expect(payload.repeatAttendance.value).toBeNull()
  })

  it("suppresses a whole panel when its total is below k", async () => {
    const { service } = build({
      registrationsByTicketType: () => Promise.resolve([{ key: "General", count: 2 }]),
    })
    const payload = await service.registrations(EVENT, "30d", "organizer:none")
    expect(payload.byTicketType.panelSuppressed).toBe(true)
  })

  it("suppresses the sub-k day in the DAILY series, not only in the cumulative one", async () => {
    const { service } = build({
      registrationsByDay: () =>
        Promise.resolve([
          { day: "2026-02-08", count: 6 },
          { day: "2026-02-09", count: 2 },
          { day: "2026-02-10", count: 7 },
        ]),
    })
    const payload = await service.registrations(EVENT, "30d", "organizer:none")
    const daily = new Map(payload.series.map((p) => [p.day, p]))
    expect(daily.get("2026-02-08")?.value).toBe(6)
    expect(daily.get("2026-02-09")?.value).toBeNull()
    expect(daily.get("2026-02-09")?.suppressed).toBe(true)
    expect(daily.get("2026-02-10")?.value).toBe(7)
  })

  it("does not let the sub-k day be differenced out of the cumulative panel either", async () => {
    const { service } = build({
      registrationsByDay: () =>
        Promise.resolve([
          { day: "2026-02-08", count: 6 },
          { day: "2026-02-09", count: 2 },
          { day: "2026-02-10", count: 7 },
        ]),
    })
    const payload = await service.registrations(EVENT, "30d", "organizer:none")
    const cumulative = new Map(payload.cumulative.map((p) => [p.day, p]))
    expect(cumulative.get("2026-02-08")?.value).toBeNull()
    expect(cumulative.get("2026-02-09")?.value).toBeNull()
    expect(cumulative.get("2026-02-10")?.value).toBeNull()

    const published = [...payload.series, ...payload.cumulative]
      .map((p) => p.value)
      .filter((v): v is number => v !== null)
    const derivable = new Set<number>(published)
    for (const a of published) {
      for (const b of published) derivable.add(a - b)
    }
    expect(derivable.has(2)).toBe(false)
  })

  it("withholds the registered KPI that would close the same chain the series left open", async () => {
    const registrationsByDay = () =>
      Promise.resolve([
        { day: "2026-02-08", count: 6 },
        { day: "2026-02-09", count: 2 },
        { day: "2026-02-10", count: 7 },
      ])
    const { service } = build(
      {
        registrationsByDay,
        eventKpis: () =>
          Promise.resolve({
            registered: 15,
            checkedIn: 12,
            waitlisted: 0,
            cancelled: 0,
            noShow: 1,
            capacity: 40,
          }),
      },
      PAGE_VIEW_ROWS,
    )
    const overview = await service.overview(EVENT, "30d", "organizer:none")
    expect(overview.kpis.registered).toBeNull()
    expect(overview.checkInRate.suppressed).toBe(true)
    expect(overview.checkInRate.denominator).toBeNull()
    expect(overview.noShowRate.denominator).toBeNull()
    expect(overview.capacityUtilization.numerator).toBeNull()
    const registeredStep = overview.funnel.find((step) => step.step === "registered")
    expect(registeredStep?.value).toBeNull()
    expect(registeredStep?.suppressed).toBe(true)
    expect(overview.kpis.checkedIn).toBe(12)

    const registrations = await service.registrations(EVENT, "30d", "organizer:none")
    const shown = registrations.series.filter((p) => p.value !== null).map((p) => p.value)
    expect(shown).toEqual([6, 7])
    expect(registrations.cumulative.every((p) => p.value === null)).toBe(true)

    const checkins = await service.checkins(EVENT, "30d", "organizer:none")
    expect(checkins.checkInRate.denominator).toBeNull()
    expect(checkins.noShowRate.denominator).toBeNull()
  })

  it("keeps the registered KPI when the hidden days cannot be pinned by it", async () => {
    const { service } = build({}, PAGE_VIEW_ROWS)
    const overview = await service.overview(EVENT, "30d", "organizer:none")
    expect(overview.kpis.registered).toBe(20)
    expect(overview.checkInRate.denominator).toBe(20)
    expect(overview.funnel.find((step) => step.step === "registered")?.value).toBe(20)
  })

  it("suppresses the arrivals curve rather than publish buckets the check-in count could pin", async () => {
    const { service } = build({
      arrivalOffsets: () => Promise.resolve([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 60, 61]),
    })
    const payload = await service.checkins(EVENT, "30d", "organizer:none")
    expect(payload.arrivals.every((row) => row.value === null && row.suppressed)).toBe(true)
  })

  it("counts broadcasts, not the days they landed on", async () => {
    const { service } = build({ broadcastsSent: () => Promise.resolve(9) })
    const payload = await service.broadcasts(EVENT, "30d", "organizer:none")
    expect(payload.broadcastsSent).toBe(9)
  })

  it("reports repeat attendance as a rate, never a list", async () => {
    const { service } = build()
    const payload = await service.portfolio(
      "00000000-0000-0000-0000-0000000000aa",
      null,
      "90d",
      "self",
    )
    expect(payload.repeatAttendance.value).toBeCloseTo(6 / 18, 4)
    expect(JSON.stringify(payload)).not.toMatch(/attendeeIds|userIds/)
  })
})

describe("host analytics cache", () => {
  it("scopes the key by endpoint, scope, range and viewer", () => {
    expect(
      hostAnalyticsCacheKey({
        endpoint: "overview",
        scope: EVENT,
        range: "30d",
        viewerScope: "organizer:none",
      }),
    ).toBe(`hostan:v1:overview:${EVENT}:30d:organizer:none`)
  })

  it("serves a second call from the cache", async () => {
    let calls = 0
    const { service, cache } = build({
      eventKpis: () => {
        calls += 1
        return Promise.resolve({
          registered: 20,
          checkedIn: 12,
          waitlisted: 0,
          cancelled: 0,
          noShow: 0,
          capacity: 40,
        })
      },
    })
    await service.overview(EVENT, "30d", "organizer:none")
    await service.overview(EVENT, "30d", "organizer:none")
    expect(calls).toBe(1)
    expect(cache.size()).toBe(1)
  })

  it("does not share an entry between two viewer scopes", async () => {
    let calls = 0
    const { service } = build({
      eventKpis: () => {
        calls += 1
        return Promise.resolve({
          registered: 20,
          checkedIn: 12,
          waitlisted: 0,
          cancelled: 0,
          noShow: 0,
          capacity: 40,
        })
      },
    })
    await service.overview(EVENT, "30d", "organizer:none")
    await service.overview(EVENT, "30d", "none:admin")
    expect(calls).toBe(2)
  })

  it("fails OPEN when the cache is unavailable", async () => {
    const broken = {
      get: () => Promise.reject(new Error("redis down")),
      set: () => Promise.reject(new Error("redis down")),
      del: () => Promise.resolve(),
      incr: () => Promise.resolve(1),
      sadd: () => Promise.resolve(0),
      srem: () => Promise.resolve(0),
      smembers: () => Promise.resolve([]),
      smismember: () => Promise.resolve([]),
      scard: () => Promise.resolve(0),
      expire: () => Promise.resolve(),
      expireNx: () => Promise.resolve(),
    }
    const cache = makeHostAnalyticsCache({ cache: broken, ttlSeconds: 60 })
    expect(await cache.getOrSet("k", () => Promise.resolve(42))).toBe(42)
  })
})

describe("#110: portfolio hours and top volunteers", () => {
  const OWNER = "00000000-0000-0000-0000-0000000000aa"
  const ADA = "11111111-1111-4111-8111-111111111111"
  const GRACE = "22222222-2222-4222-8222-222222222222"

  it("publishes the lifetime hours, the people credited and the ranked top volunteers", async () => {
    const { service } = build({
      hoursTotals: () => Promise.resolve({ credited: 486.755, volunteersCredited: 96 }),
      topVolunteers: () =>
        Promise.resolve([
          { userId: ADA, name: "Ada", handle: "ada", avatarUrl: null, hours: 41 },
          { userId: GRACE, name: "Grace", handle: null, avatarUrl: null, hours: 22.5 },
        ]),
    })
    const payload = await service.portfolio(OWNER, null, "all", "self")

    expect(payload.totalHours).toBe(486.76)
    expect(payload.volunteersCredited).toBe(96)
    expect(payload.topVolunteers.map((entry) => [entry.rank, entry.userId, entry.hours])).toEqual([
      [1, ADA, 41],
      [2, GRACE, 22.5],
    ])
    expect(payload.topVolunteers[0]?.avatar).toEqual(avatarGradient(ADA))
  })

  it("bounds the top-volunteer query by MAX_PORTFOLIO_TOP_VOLUNTEERS over the hosted events", async () => {
    const asked: { cleanupIds: readonly string[]; limit: number }[] = []
    const { service } = build({
      topVolunteers: (cleanupIds, limit) => {
        asked.push({ cleanupIds, limit })
        return Promise.resolve([])
      },
    })
    await service.portfolio(OWNER, null, "all", "self")
    expect(asked).toEqual([{ cleanupIds: [EVENT], limit: MAX_PORTFOLIO_TOP_VOLUNTEERS }])
  })

  it("reports zero hours and no volunteers for a host with no events", async () => {
    const asked: string[][] = []
    const { service } = build({
      hostedEventIds: () => Promise.resolve([]),
      hoursTotals: (cleanupIds) => {
        asked.push([...cleanupIds])
        return Promise.resolve({ credited: 0, volunteersCredited: 0 })
      },
      topVolunteers: (cleanupIds) => {
        asked.push([...cleanupIds])
        return Promise.resolve([])
      },
    })
    const payload = await service.portfolio(OWNER, null, "all", "self")

    expect(payload.totalHours).toBe(0)
    expect(payload.volunteersCredited).toBe(0)
    expect(payload.topVolunteers).toEqual([])
    expect(asked).toEqual([[], []])
  })

  it("parses a 0.44-shaped payload that predates the hours fields", () => {
    const legacy = HostedEventsAnalyticsResponseSchema.parse({
      generatedAt: NOW.toISOString(),
      range: "all",
      k: 5,
      totals: { events: 1, registrations: 20, checkIns: 12, uniqueAttendees: 18 },
      series: [],
      byEvent: { panelSuppressed: false, rows: [] },
      repeatAttendance: { value: null, suppressed: true, numerator: 0, denominator: 0 },
      averageCheckInRate: { value: null, suppressed: true, numerator: 0, denominator: 0 },
      bestDayTime: null,
    })
    expect(legacy.topVolunteers).toEqual([])
    expect(legacy.totalHours).toBeUndefined()
    expect(legacy.volunteersCredited).toBeUndefined()
  })
})

describe("hosted-events analytics summary", () => {
  const OWNER = "00000000-0000-0000-0000-0000000000aa"
  const ORG = "33333333-3333-4333-8333-333333333333"

  it("returns a payload the shared summary schema accepts", async () => {
    const { service } = build()
    const payload = await service.summary(OWNER, null, "30d", "self")
    expect(() => HostAnalyticsSummaryResponseSchema.parse(payload)).not.toThrow()
    expect(payload.k).toBe(5)
    expect(payload.range).toBe("30d")
    expect(payload.generatedAt).toBe(NOW.toISOString())
  })

  it("spans the 30-day window inclusive of both end days", async () => {
    const { service } = build()
    const payload = await service.summary(OWNER, null, "30d", "self")
    expect(payload.window).toEqual({ from: "2026-01-12", to: "2026-02-10" })
    expect(payload.signupsDaily).toHaveLength(30)
    expect(payload.signupsDaily[0]?.day).toBe("2026-01-12")
    expect(payload.signupsDaily.at(-1)?.day).toBe("2026-02-10")
  })

  it("hands the repositories the window's half-open instant bounds", async () => {
    const asked: { from: Date; to: Date }[] = []
    const { service } = build({
      activityTotals: (_ids, from, to) => {
        asked.push({ from, to })
        return Promise.resolve({
          registrations: 0,
          cancellations: 0,
          hoursTotal: 0,
          hoursVolunteers: 0,
          reportsLinked: 0,
          reportsResolved: 0,
          postsCreated: 0,
        })
      },
      heldEventTotals: (_ids, from, to) => {
        asked.push({ from, to })
        return Promise.resolve({ events: 0, registered: 0, checkedIn: 0, noShow: 0 })
      },
    })
    await service.summary(OWNER, null, "30d", "self")
    expect(asked).toHaveLength(2)
    for (const call of asked) {
      expect(call.from.toISOString()).toBe("2026-01-12T00:00:00.000Z")
      expect(call.to.toISOString()).toBe("2026-02-11T00:00:00.000Z")
    }
  })

  it("carries the live activity counts straight through, sub-k included", async () => {
    const { service } = build({}, [
      { cleanupId: EVENT, day: "2026-02-09", metric: "donation_clicks", bucket: "", value: 4 },
    ])
    const payload = await service.summary(OWNER, null, "30d", "self")
    expect(payload.activity).toEqual({
      signups: 20,
      cancellations: 2,
      hoursTotal: 48.76,
      hoursVolunteers: 11,
      reportsLinked: 3,
      reportsResolved: 1,
      postsCreated: 7,
      donationClicks: 4,
    })
  })

  it("publishes every signup day exactly, sub-k days included", async () => {
    const { service } = build()
    const payload = await service.summary(OWNER, null, "30d", "self")
    const byDay = new Map(payload.signupsDaily.map((point) => [point.day, point]))
    expect(byDay.get("2026-02-08")?.value).toBe(6)
    expect(byDay.get("2026-02-09")?.value).toBe(2)
    expect(byDay.get("2026-02-10")?.value).toBe(7)
    expect(payload.signupsDaily.every((point) => point.suppressed === false)).toBe(true)
  })

  it("publishes the per-event panels exactly, the way the portfolio does", async () => {
    const { service } = build()
    const payload = await service.summary(OWNER, null, "30d", "self")
    expect(payload.byEvent.panelSuppressed).toBe(false)
    expect(payload.byEvent.rows.map((row) => [row.key, row.label, row.value])).toEqual([
      [EVENT_A, "Beach Cleanup", 12],
      [EVENT_B, "Park Cleanup", 3],
    ])
    expect(payload.hoursByEvent.rows.map((row) => [row.key, row.label, row.value])).toEqual([
      [EVENT_A, "Beach Cleanup", 31],
    ])
    expect(payload.byEvent.rows.every((row) => row.suppressed === false)).toBe(true)
  })

  it("keeps per-event rows distinct when two events share a title", async () => {
    const { service } = build({
      signupsByDayAcross: () =>
        Promise.resolve({
          daily: [],
          byEvent: [
            { key: EVENT_A, label: "Test1", count: 5 },
            { key: EVENT_B, label: "Test1", count: 2 },
          ],
          hoursByEvent: [
            { key: EVENT_A, label: "Test1", count: 9 },
            { key: EVENT_B, label: "Test1", count: 4 },
          ],
        }),
    })
    const payload = await service.summary(OWNER, null, "30d", "self")
    expect(payload.byEvent.rows.map((row) => row.key)).toEqual([EVENT_A, EVENT_B])
    expect(new Set(payload.byEvent.rows.map((row) => row.key)).size).toBe(2)
    expect(payload.byEvent.rows.map((row) => row.label)).toEqual(["Test1", "Test1"])
    expect(payload.hoursByEvent.rows.map((row) => row.key)).toEqual([EVENT_A, EVENT_B])
    expect(new Set(payload.hoursByEvent.rows.map((row) => row.key)).size).toBe(2)
    expect(payload.hoursByEvent.rows.map((row) => row.value)).toEqual([9, 4])
  })

  it("derives the held-event check-in rate exactly, never suppressed above zero", async () => {
    const { service } = build()
    const payload = await service.summary(OWNER, null, "30d", "self")
    expect(payload.eventsHeld).toMatchObject({
      count: 2,
      registered: 20,
      checkIns: 12,
      noShows: 1,
    })
    expect(payload.eventsHeld.checkInRate.value).toBeCloseTo(12 / 20, 4)
    expect(payload.eventsHeld.checkInRate.numerator).toBe(12)
    expect(payload.eventsHeld.checkInRate.denominator).toBe(20)
    expect(payload.eventsHeld.checkInRate.suppressed).toBe(false)
  })

  it("keeps a sub-k held-event rate exact rather than hiding it", async () => {
    const { service } = build({
      heldEventTotals: () =>
        Promise.resolve({ events: 1, registered: 3, checkedIn: 2, noShow: 1 }),
    })
    const payload = await service.summary(OWNER, null, "30d", "self")
    expect(payload.eventsHeld.checkInRate.value).toBeCloseTo(2 / 3, 4)
    expect(payload.eventsHeld.checkInRate.suppressed).toBe(false)
  })

  it("leaves the rate null when nobody registered", async () => {
    const { service } = build({
      heldEventTotals: () =>
        Promise.resolve({ events: 1, registered: 0, checkedIn: 0, noShow: 0 }),
    })
    const payload = await service.summary(OWNER, null, "30d", "self")
    expect(payload.eventsHeld.checkInRate.value).toBeNull()
    expect(payload.eventsHeld.checkInRate.suppressed).toBe(true)
  })

  it("short-circuits a host with no events without touching the window reads", async () => {
    const touched: string[] = []
    const { service } = build({
      hostedEventIds: () => Promise.resolve([]),
      activityTotals: () => {
        touched.push("activityTotals")
        return Promise.resolve({
          registrations: 1,
          cancellations: 1,
          hoursTotal: 1,
          hoursVolunteers: 1,
          reportsLinked: 1,
          reportsResolved: 1,
          postsCreated: 1,
        })
      },
      heldEventTotals: () => {
        touched.push("heldEventTotals")
        return Promise.resolve({ events: 1, registered: 1, checkedIn: 1, noShow: 1 })
      },
      signupsByDayAcross: () => {
        touched.push("signupsByDayAcross")
        return Promise.resolve({ daily: [], byEvent: [], hoursByEvent: [] })
      },
    })
    const payload = await service.summary(OWNER, null, "30d", "self")

    expect(touched).toEqual([])
    expect(() => HostAnalyticsSummaryResponseSchema.parse(payload)).not.toThrow()
    expect(payload.totals.events).toBe(0)
    expect(payload.eventsHeld).toMatchObject({ count: 0, registered: 0, checkIns: 0, noShows: 0 })
    expect(Object.values(payload.activity).every((value) => value === 0)).toBe(true)
    expect(payload.byEvent.rows).toEqual([])
    expect(payload.hoursByEvent.rows).toEqual([])
    expect(payload.signupsDaily.every((point) => point.value === 0)).toBe(true)
  })

  it("scopes the hosted-event lookup to the organization when one is asked for", async () => {
    const asked: Array<string | null> = []
    const { service } = build({
      hostedEventIds: (_userId, organizationId) => {
        asked.push(organizationId)
        return Promise.resolve([EVENT])
      },
    })
    await service.summary(OWNER, ORG, "30d", "org:admin")
    await service.summary(OWNER, null, "30d", "self")
    expect(asked).toEqual([ORG, null])
  })

  it("does not serve an org summary from the personal one's cache entry", async () => {
    let calls = 0
    const { service } = build({
      hostedEventIds: () => {
        calls += 1
        return Promise.resolve([EVENT])
      },
    })
    await service.summary(OWNER, null, "30d", "self")
    await service.summary(OWNER, null, "30d", "self")
    expect(calls).toBe(1)
    await service.summary(OWNER, ORG, "30d", "org:admin")
    expect(calls).toBe(2)
  })

  it("widens the window with the range", async () => {
    const { service } = build()
    expect((await service.summary(OWNER, null, "7d", "self")).window).toEqual({
      from: "2026-02-04",
      to: "2026-02-10",
    })
    expect((await service.summary(OWNER, null, "90d", "self")).window.from).toBe("2025-11-13")
    expect((await service.summary(OWNER, null, "all", "self")).signupsDaily).toHaveLength(365)
  })
})
