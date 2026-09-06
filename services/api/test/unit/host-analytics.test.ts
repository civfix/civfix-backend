import { describe, expect, it } from "vitest"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import {
  hostAnalyticsCacheKey,
  makeHostAnalyticsCache,
} from "../../src/services/host/host-analytics-cache.js"
import { makeAnalyticsService } from "../../src/services/host/analytics-service.js"
import type { AnalyticsRepository } from "../../src/services/host/analytics-repository.drizzle.js"
import type { MetricsRepository } from "../../src/services/host/metrics-repository.drizzle.js"

const EVENT = "00000000-0000-0000-0000-0000000000ee"
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

  it("gates the portfolio totals on the same closure as its own series", async () => {
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
    expect(payload.series.filter((p) => p.value !== null).map((p) => p.value)).toEqual([6, 7])
    expect(payload.totals.registrations).toBeNull()
    expect(payload.averageCheckInRate.suppressed).toBe(true)
    expect(payload.byEvent.panelSuppressed).toBe(true)
    expect(payload.byEvent.rows).toEqual([])
    expect(payload.bestDayTime).toBeNull()
  })

  it("publishes the portfolio totals when its series published nothing to pin", async () => {
    const { service } = build()
    const payload = await service.portfolio(
      "00000000-0000-0000-0000-0000000000aa",
      null,
      "90d",
      "self",
    )
    expect(payload.series.every((p) => p.value === null)).toBe(true)
    expect(payload.totals.registrations).toBe(20)
    expect(payload.byEvent.rows.find((r) => r.key === "Beach Cleanup")?.value).toBe(20)
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
      expire: () => Promise.resolve(),
    }
    const cache = makeHostAnalyticsCache({ cache: broken, ttlSeconds: 60 })
    expect(await cache.getOrSet("k", () => Promise.resolve(42))).toBe(42)
  })
})
