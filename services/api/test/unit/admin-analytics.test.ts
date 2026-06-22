import { describe, it, expect } from "vitest"
import { InMemoryAnalyticsRepository } from "../../src/services/admin/analytics-repository.memory.js"
import {
  buildByCategory,
  buildByMonth,
  buildCoverage,
  buildEvents,
  buildFunnel,
  buildKpis,
  buildPinsByWeek,
  buildResolutionByCategory,
  buildRetention,
  countDeltaLabel,
  deltaDir,
  makeAnalyticsService,
  pct,
  pointDeltaLabel,
  round1,
  startOfWeekUtc,
  subtractMonths,
  ANALYTICS_CATEGORIES,
  PINS_BY_WEEK_WEEKS,
  type AnalyticsService,
} from "../../src/services/admin/analytics-service.js"

/**
 * Offline unit tests for the admin analytics service. The DATABASE does the aggregation (medians, grouped
 * counts, period windows) so these tests target the service's PURE SHAPING - pct, category fill, KPI
 * deltas + arrows, funnel percentages, week/month/cohort alignment - against known aggregate inputs, plus
 * the service wiring over the in-memory repo. The real SQL aggregates are Docker-gated
 * (test/integration/admin-analytics.test.ts).
 */

const NOW = new Date("2026-06-15T12:00:00.000Z")

function harness(): { repo: InMemoryAnalyticsRepository; svc: AnalyticsService } {
  const repo = new InMemoryAnalyticsRepository()
  const svc = makeAnalyticsService({ repo, now: () => NOW })
  return { repo, svc }
}

describe("analytics pure math helpers", () => {
  it("round1 rounds to one decimal", () => {
    expect(round1(12.34)).toBe(12.3)
    expect(round1(12.35)).toBeCloseTo(12.4, 5)
  })

  it("pct is part/whole as a percentage, 0 when whole is 0", () => {
    expect(pct(1, 4)).toBe(25)
    expect(pct(1, 3)).toBe(33.3)
    expect(pct(5, 0)).toBe(0)
  })

  it("deltaDir reports up/down/flat", () => {
    expect(deltaDir(5, 3)).toBe("up")
    expect(deltaDir(3, 5)).toBe("down")
    expect(deltaDir(3, 3)).toBe("flat")
  })

  it("countDeltaLabel + pointDeltaLabel sign the delta", () => {
    expect(countDeltaLabel(5, 3)).toBe("+2")
    expect(countDeltaLabel(3, 5)).toBe("-2")
    expect(countDeltaLabel(3, 3)).toBe("0")
    expect(pointDeltaLabel(50, 47)).toBe("+3pt")
    expect(pointDeltaLabel(47, 50)).toBe("-3pt")
  })

  it("startOfWeekUtc anchors to Monday (UTC)", () => {
    // 2026-06-15 is a Monday; its week start is itself (midnight UTC).
    expect(startOfWeekUtc(new Date("2026-06-15T12:00:00Z")).toISOString()).toBe(
      "2026-06-15T00:00:00.000Z",
    )
    // 2026-06-21 is a Sunday; its week start is the prior Monday 2026-06-15.
    expect(startOfWeekUtc(new Date("2026-06-21T23:00:00Z")).toISOString()).toBe(
      "2026-06-15T00:00:00.000Z",
    )
  })

  it("subtractMonths wraps across the year boundary", () => {
    expect(subtractMonths(2026, 6, 0)).toEqual({ year: 2026, month: 6 })
    expect(subtractMonths(2026, 1, 1)).toEqual({ year: 2025, month: 12 })
    expect(subtractMonths(2026, 3, 5)).toEqual({ year: 2025, month: 10 })
  })
})

describe("buildKpis", () => {
  it("computes deltas + arrows and pins a Phase-3 avg route time", () => {
    const kpis = buildKpis({
      pins: { current: 120, previous: 100 },
      resolvedRatio: { current: 0.5, previous: 0.47 },
      cleanupsPlanned: { current: 8, previous: 8 },
      events: { current: 5, previous: 9 },
      newUsers: { current: 64, previous: 60 },
    })
    expect(kpis).toHaveLength(6)
    expect(kpis[0]).toEqual({ label: "Pins this month", num: 120, delta: "+20", dir: "up" })
    expect(kpis[1]).toEqual({ label: "Resolved", num: 50, delta: "+3pt", dir: "up" })
    expect(kpis[2]).toEqual({ label: "Cleanups planned", num: 8, delta: "0", dir: "flat" })
    // Avg route time is the Phase 3 placeholder.
    expect(kpis[3]).toEqual({ label: "Avg. route time", num: 0, delta: "Phase 3", dir: "flat" })
    expect(kpis[4]).toEqual({ label: "Events this month", num: 5, delta: "-4", dir: "down" })
    expect(kpis[5]).toEqual({ label: "New users", num: 64, delta: "+4", dir: "up" })
  })
})

describe("buildByCategory", () => {
  it("fills all 6 categories in canonical order with pct over the total", () => {
    const rows = buildByCategory([
      { category: "trash", count: 6 },
      { category: "hazard", count: 2 },
    ])
    expect(rows.map((r) => r.cat)).toEqual([...ANALYTICS_CATEGORIES])
    expect(rows.find((r) => r.cat === "trash")).toEqual({ cat: "trash", count: 6, pct: 75 })
    expect(rows.find((r) => r.cat === "hazard")).toEqual({ cat: "hazard", count: 2, pct: 25 })
    expect(rows.find((r) => r.cat === "water")).toEqual({ cat: "water", count: 0, pct: 0 })
  })

  it("is all-zero (pct 0) when there are no reports", () => {
    const rows = buildByCategory([])
    expect(rows).toHaveLength(7)
    expect(rows.every((r) => r.count === 0 && r.pct === 0)).toBe(true)
  })
})

describe("buildResolutionByCategory", () => {
  it("fills all 7 categories (missing -> 0 hours), rounded", () => {
    const res = buildResolutionByCategory([
      { category: "trash", medianHours: 12.34 },
      { category: "graffiti", medianHours: 48 },
    ])
    expect(res.rows).toHaveLength(7)
    expect(res.rows.find((r) => r.cat === "trash")?.hours).toBe(12.3)
    expect(res.rows.find((r) => r.cat === "graffiti")?.hours).toBe(48)
    expect(res.rows.find((r) => r.cat === "other")?.hours).toBe(0)
  })
})

describe("buildFunnel", () => {
  it("computes stage percentages relative to the dropped (top) count", () => {
    const res = buildFunnel({ dropped: 100, routed: 80, acknowledged: 50, resolved: 25 })
    expect(res.stages.map((s) => s.stage)).toEqual([
      "Pin dropped",
      "Routed to gov",
      "Acknowledged",
      "Resolved",
    ])
    expect(res.stages[0]).toEqual({ stage: "Pin dropped", count: 100, pct: 100 })
    expect(res.stages[1]).toEqual({ stage: "Routed to gov", count: 80, pct: 80 })
    expect(res.stages[3]).toEqual({ stage: "Resolved", count: 25, pct: 25 })
  })

  it("is all-zero pct when there is no volume (no divide-by-zero)", () => {
    const res = buildFunnel({ dropped: 0, routed: 0, acknowledged: 0, resolved: 0 })
    expect(res.stages.every((s) => s.pct === 0)).toBe(true)
  })
})

describe("buildCoverage", () => {
  it("computes pct of mapped over the total", () => {
    expect(buildCoverage({ mapped: 3, needsMapping: 1 })).toEqual({
      pct: 75,
      mapped: 3,
      needsMapping: 1,
    })
    expect(buildCoverage({ mapped: 0, needsMapping: 0 })).toEqual({
      pct: 0,
      mapped: 0,
      needsMapping: 0,
    })
  })
})

describe("buildPinsByWeek", () => {
  it("aligns sparse weekly buckets into a fixed window ending at the current week", () => {
    // NOW is Mon 2026-06-15. This week + the week 2 weeks ago have pins.
    const res = buildPinsByWeek(
      [
        { weekStart: new Date("2026-06-15T00:00:00Z"), count: 10 },
        { weekStart: new Date("2026-06-01T00:00:00Z"), count: 4 },
      ],
      PINS_BY_WEEK_WEEKS,
      NOW,
    )
    expect(res.weeks).toHaveLength(8)
    // Current week is the last cell.
    expect(res.weeks[7]).toBe(10)
    // Two weeks ago is cell index 5.
    expect(res.weeks[5]).toBe(4)
    // The rest are 0.
    expect(res.weeks[6]).toBe(0)
    expect(res.labels[7]).toBe("now")
    expect(res.labels[6]).toBe("last")
    expect(res.labels[0]).toBe("")
  })

  it("ignores buckets outside the trailing window", () => {
    const res = buildPinsByWeek(
      [{ weekStart: new Date("2026-01-01T00:00:00Z"), count: 99 }],
      PINS_BY_WEEK_WEEKS,
      NOW,
    )
    expect(res.weeks.every((v) => v === 0)).toBe(true)
  })
})

describe("buildByMonth", () => {
  it("aligns monthly buckets into a trailing window with month labels", () => {
    const { byMonth, monthLabels } = buildByMonth(
      [
        { year: 2026, month: 6, count: 7 },
        { year: 2026, month: 4, count: 3 },
      ],
      8,
      NOW,
    )
    expect(byMonth).toHaveLength(8)
    // June is the last cell (current month).
    expect(byMonth[7]).toBe(7)
    expect(monthLabels[7]).toBe("Jun")
    // April is two months before June -> cell index 5.
    expect(byMonth[5]).toBe(3)
    expect(monthLabels[5]).toBe("Apr")
  })
})

describe("buildEvents", () => {
  it("carries the headline stats and builds the byMonth trend", () => {
    const res = buildEvents(
      { thisMonth: 5, volunteers: 40, bags: 120, byMonth: [{ year: 2026, month: 6, count: 5 }] },
      8,
      NOW,
    )
    expect(res.thisMonth).toBe(5)
    expect(res.volunteers).toBe(40)
    expect(res.bags).toBe(120)
    expect(res.byMonth).toHaveLength(8)
    expect(res.byMonth[7]).toBe(5)
    expect(res.monthLabels).toHaveLength(8)
  })
})

describe("buildRetention", () => {
  it("converts per-period active counts to retention ratios per cohort", () => {
    const res = buildRetention(
      [
        { year: 2026, month: 5, size: 100, activeByPeriod: [100, 40, 25] },
        { year: 2026, month: 6, size: 50, activeByPeriod: [50] },
      ],
      6,
    )
    expect(res.periodLabels).toEqual(["M0", "M1", "M2", "M3", "M4", "M5"])
    expect(res.cohorts).toHaveLength(2)
    const may = res.cohorts.find((c) => c.cohort === "May 2026")!
    expect(may.size).toBe(100)
    // 100/100, 40/100, 25/100, then zeros.
    expect(may.values).toEqual([1, 0.4, 0.25, 0, 0, 0])
    const jun = res.cohorts.find((c) => c.cohort === "Jun 2026")!
    expect(jun.values[0]).toBe(1)
    expect(jun.values[1]).toBe(0)
  })
})

describe("analytics service wiring", () => {
  it("kpis() shapes the repo aggregate into KPI cells", async () => {
    const { repo, svc } = harness()
    repo.kpisValue = {
      pins: { current: 10, previous: 5 },
      resolvedRatio: { current: 0.5, previous: 0.5 },
      cleanupsPlanned: { current: 2, previous: 1 },
      events: { current: 3, previous: 3 },
      newUsers: { current: 9, previous: 8 },
    }
    const res = await svc.kpis()
    expect(res.kpis[0]).toMatchObject({ label: "Pins this month", num: 10, dir: "up" })
  })

  it("topJurisdictions() computes resolved % from resolved/pins", async () => {
    const { repo, svc } = harness()
    repo.topJurisdictionsValue = [{ org: "Los Angeles", pins: 20, resolved: 15 }]
    const res = await svc.topJurisdictions()
    expect(res.rows[0]).toEqual({ org: "Los Angeles", pins: 20, resolved: 75 })
  })

  it("heatmap() maps cells straight through", async () => {
    const { repo, svc } = harness()
    repo.heatmapValue = [
      { geoid: "0644000", name: "Los Angeles", density: 12, lat: 34.05, lng: -118.24 },
    ]
    const res = await svc.heatmap()
    expect(res.cells[0]).toEqual({
      geoid: "0644000",
      name: "Los Angeles",
      density: 12,
      lat: 34.05,
      lng: -118.24,
    })
  })

  it("pinsByWeek() returns the fixed 8-week window", async () => {
    const { repo, svc } = harness()
    repo.pinsByWeekValue = [{ weekStart: new Date("2026-06-15T00:00:00Z"), count: 11 }]
    const res = await svc.pinsByWeek()
    expect(res.weeks).toHaveLength(8)
    expect(res.weeks[7]).toBe(11)
  })

  it("byCategory() / resolutionByCategory() always return all 7 categories", async () => {
    const { repo, svc } = harness()
    repo.byCategoryValue = [{ category: "trash", count: 3 }]
    repo.resolutionByCategoryValue = [{ category: "trash", medianHours: 5 }]
    expect((await svc.byCategory()).rows).toHaveLength(7)
    expect((await svc.resolutionByCategory()).rows).toHaveLength(7)
  })
})
