import { describe, it, expect } from "vitest"
import { InMemoryHomeRepository } from "../../src/services/admin/home-repository.memory.js"
import { InMemoryAnalyticsRepository } from "../../src/services/admin/analytics-repository.memory.js"
import {
  makeHomeService,
  safeSection,
  toMapPin,
  type HomeService,
} from "../../src/services/admin/home-service.js"

/**
 * Offline unit tests for the admin home / dashboard service over the in-memory repos (no DB, no Docker).
 * Cover: the per-section summary assembly, the analytics-mini block (reusing the analytics repo so the
 * home digest matches the full analytics page), the per-card RESILIENCE (a failing sub-aggregate degrades
 * only that card, never the whole summary), and the live-map pin projection (report vs event, attendees
 * omitted for reports). The raw SQL aggregates are Docker-gated (test/integration/admin-home.test.ts).
 */

const NOW = new Date("2026-06-15T12:00:00.000Z")

function harness(): {
  repo: InMemoryHomeRepository
  analytics: InMemoryAnalyticsRepository
  svc: HomeService
} {
  const repo = new InMemoryHomeRepository()
  const analytics = new InMemoryAnalyticsRepository()
  const svc = makeHomeService({ repo, analytics, now: () => NOW })
  return { repo, analytics, svc }
}

describe("safeSection", () => {
  it("returns the producer result on success", async () => {
    expect(await safeSection(async () => 7, 0)).toBe(7)
  })

  it("returns the fallback and reports the error on failure", async () => {
    let reported: unknown
    const result = await safeSection(
      async () => {
        throw new Error("boom")
      },
      -1,
      (err) => {
        reported = err
      },
    )
    expect(result).toBe(-1)
    expect((reported as Error).message).toBe("boom")
  })
})

describe("home summary assembly", () => {
  it("assembles every section + the analytics-mini block", async () => {
    const { repo, analytics, svc } = harness()
    repo.discoveryValue = { queue: 4, reportsWaiting: 11, overSla: 2 }
    repo.reportsValue = { flagged: 3, inProgress: 5, completed: 20 }
    repo.eventsValue = { upcoming: 6, live: 1, attending: 42 }
    repo.mailValue = { unread: 7, needsAction: 2, bounceRate: 0.03 }
    repo.usersValue = { flagged: 1, highRisk: 2, suspended: 1 }
    repo.livePinsValue = 9
    analytics.kpisValue = {
      pins: { current: 120, previous: 100 },
      resolvedRatio: { current: 0.5, previous: 0.47 },
      cleanupsPlanned: { current: 8, previous: 7 },
      events: { current: 5, previous: 9 },
      newUsers: { current: 64, previous: 60 },
    }
    analytics.coverageValue = { mapped: 3, needsMapping: 1 }
    analytics.pinsByWeekValue = [{ weekStart: new Date("2026-06-15T00:00:00Z"), count: 11 }]

    const res = await svc.summary()
    expect(res.discovery).toEqual({ queue: 4, reportsWaiting: 11, overSla: 2 })
    expect(res.reports).toEqual({ flagged: 3, inProgress: 5, completed: 20 })
    expect(res.events).toEqual({ upcoming: 6, live: 1, attending: 42 })
    expect(res.mail).toEqual({ unread: 7, needsAction: 2, bounceRate: 0.03 })
    expect(res.users).toEqual({ flagged: 1, highRisk: 2, suspended: 1 })
    expect(res.livePins24h).toBe(9)
    // Analytics mini reuses the analytics repo aggregates.
    expect(res.analytics.pinsThisMonth).toBe(120)
    expect(res.analytics.resolvedPct).toBe(50)
    expect(res.analytics.coveragePct).toBe(75)
    expect(res.analytics.cleanups).toBe(8)
    expect(res.analytics.eventsThisMonth).toBe(5)
    expect(res.analytics.newUsers).toBe(64)
    expect(res.analytics.pinsByWeek).toHaveLength(8)
    expect(res.analytics.pinsByWeek[7]).toBe(11)
  })

  it("degrades ONE failing section to zeros without sinking the summary", async () => {
    const { repo, svc } = harness()
    repo.reportsValue = { flagged: 3, inProgress: 5, completed: 20 }
    // The mail sub-aggregate fails.
    repo.mailError = new Error("mail db down")

    const res = await svc.summary()
    // Mail degraded to the neutral zero block...
    expect(res.mail).toEqual({ unread: 0, needsAction: 0, bounceRate: 0 })
    // ...while the other sections are intact.
    expect(res.reports).toEqual({ flagged: 3, inProgress: 5, completed: 20 })
  })

  it("degrades the analytics-mini to zeros when the analytics repo fails", async () => {
    const { repo, analytics, svc } = harness()
    repo.discoveryValue = { queue: 2, reportsWaiting: 3, overSla: 0 }
    // Make every analytics getter throw.
    analytics.kpis = async () => {
      throw new Error("kpis down")
    }
    analytics.coverage = async () => {
      throw new Error("coverage down")
    }
    analytics.pinsByWeek = async () => {
      throw new Error("pins down")
    }

    const res = await svc.summary()
    expect(res.discovery).toEqual({ queue: 2, reportsWaiting: 3, overSla: 0 })
    expect(res.analytics.pinsThisMonth).toBe(0)
    expect(res.analytics.coveragePct).toBe(0)
    expect(res.analytics.pinsByWeek).toEqual(new Array(8).fill(0))
  })
})

describe("home map projection", () => {
  it("toMapPin keeps attendees for events and omits it for reports", () => {
    const reportPin = toMapPin({
      refType: "report",
      id: "r1",
      lat: 34,
      lng: -118,
      category: "trash",
      status: "submitted",
      flagged: true,
      title: "Trash pile",
      place: "Los Angeles",
      attendees: null,
      eventKind: null,
    })
    expect(reportPin).not.toHaveProperty("attendees")
    // A report pin never carries an eventKind.
    expect(reportPin).not.toHaveProperty("eventKind")
    expect(reportPin.category).toBe("trash")
    expect(reportPin.flagged).toBe(true)

    const eventPin = toMapPin({
      refType: "event",
      id: "e1",
      lat: 34,
      lng: -118,
      category: null,
      status: "upcoming",
      flagged: false,
      title: "Park cleanup",
      place: "Echo Park",
      attendees: 12,
      eventKind: "cleanup",
    })
    expect(eventPin.attendees).toBe(12)
    expect(eventPin.category).toBeNull()
    // An event pin diverges by kind so the live map can render distinct markers.
    expect(eventPin.eventKind).toBe("cleanup")
  })

  it("map() projects the repo's recent pins", async () => {
    const { repo, svc } = harness()
    repo.recentPinsValue = [
      {
        refType: "report",
        id: "r1",
        lat: 34,
        lng: -118,
        category: "hazard",
        status: "in_progress",
        flagged: false,
        title: "Pothole",
        place: "LA",
        attendees: null,
        eventKind: null,
      },
      {
        refType: "event",
        id: "e1",
        lat: 34.1,
        lng: -118.1,
        category: null,
        status: "completed",
        flagged: false,
        title: "Beach cleanup",
        place: "Venice",
        attendees: 30,
        eventKind: "other_volunteer",
      },
    ]
    const res = await svc.map()
    expect(res.pins).toHaveLength(2)
    expect(res.pins[0]?.refType).toBe("report")
    expect(res.pins[1]?.attendees).toBe(30)
    // The event pin's kind flows through so the live map can diverge markers.
    expect(res.pins[1]?.eventKind).toBe("other_volunteer")
  })
})
