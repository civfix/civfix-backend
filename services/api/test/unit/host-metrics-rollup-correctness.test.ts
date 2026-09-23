import { describe, expect, it } from "vitest"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeMetricsService } from "../../src/services/host/metrics-service.js"
import { makeDrizzleMetricsRepository } from "../../src/services/host/metrics-repository.drizzle.js"
import type { MetricUpsert, MetricsRepository } from "../../src/services/host/metrics-repository.js"
import type { AnalyticsRepository } from "../../src/services/host/analytics-repository.js"
import { makeInsightsService } from "../../src/services/host/insights-service.js"
import { makeHostAnalyticsCache } from "../../src/services/host/host-analytics-cache.js"
import { InMemoryHostRegistrationRepository } from "../../src/services/host/registration-repository.memory.js"
import { DEFAULT_EVENT_TIME_ZONE } from "../../src/services/host/event-fields.js"
import type { Sql } from "../../src/db/client.js"
import { makeFakeSql } from "../helpers/fake-sql.js"

const EVENT = "00000000-0000-0000-0000-0000000000ee"

function eventId(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`
}

function repoStub(overrides: Partial<MetricsRepository> = {}): MetricsRepository & {
  recomputed: Array<{ cleanupId: string; timezone: string }>
  greatest: MetricUpsert[]
} {
  const recomputed: Array<{ cleanupId: string; timezone: string }> = []
  const greatest: MetricUpsert[] = []
  return {
    recomputed,
    greatest,
    resolveSlug: () => Promise.resolve({ cleanupId: EVENT, timezone: null }),
    eventTimezone: () => Promise.resolve(null),
    listRollupEvents: () => Promise.resolve([EVENT]),
    recomputeFromSource: (cleanupId, timezone) => {
      recomputed.push({ cleanupId, timezone })
      return Promise.resolve([])
    },
    upsertExact: () => Promise.resolve(),
    upsertGreatest: (rows) => {
      greatest.push(...rows)
      return Promise.resolve()
    },
    read: () => Promise.resolve([]),
    readMany: () => Promise.resolve([]),
    ...overrides,
  }
}

describe("metrics rollup covers every active event", () => {
  it("pages past the first batch instead of recomputing the same lowest ids every run", async () => {
    const ids = Array.from({ length: 1201 }, (_, i) => eventId(i + 1))
    const repo = repoStub({
      listRollupEvents: (_since, after, limit) =>
        Promise.resolve(ids.filter((id) => after === null || id > after).slice(0, limit)),
      eventTimezone: () => Promise.resolve("UTC"),
    })
    const service = makeMetricsService({
      repo,
      cache: new InMemoryCacheClient(),
      selfHosts: [],
      lookbackDays: 3,
      now: () => new Date("2026-02-05T12:00:00Z"),
    })
    const result = await service.rollup()
    expect(result.events).toBe(1201)
    expect(new Set(repo.recomputed.map((r) => r.cleanupId)).size).toBe(1201)
  })

  it("keysets the SQL page by id so the next page starts after the last one", async () => {
    const fake = makeFakeSql()
    const repo = makeDrizzleMetricsRepository(fake.sql as unknown as Sql)
    await repo.listRollupEvents(new Date("2026-02-01T00:00:00Z"), EVENT, 500)
    const statement = fake.statements[0]!
    expect(statement.sql).toMatch(/c\.id > \$?\??/)
    expect(statement.values).toContain(EVENT)
  })

  it("recomputes from the start of the event-local day, not from a mid-day instant", async () => {
    const fake = makeFakeSql()
    const repo = makeDrizzleMetricsRepository(fake.sql as unknown as Sql)
    await repo.recomputeFromSource(EVENT, "America/Los_Angeles", new Date("2026-02-02T20:00:00Z"))
    const statement = fake.statements[0]!
    expect(statement.sql).toMatch(/date_trunc\('day'/)
    expect(statement.sql).toMatch(/registered_at >= \(SELECT since FROM bound\)/)
  })
})

describe("events without a timezone use the platform default everywhere", () => {
  it("buckets a live page view by the default zone's day", async () => {
    const cache = new InMemoryCacheClient()
    const service = makeMetricsService({
      repo: repoStub(),
      cache,
      selfHosts: [],
      lookbackDays: 3,
      now: () => new Date("2026-02-02T04:30:00Z"),
    })
    await service.recordPageView({ slug: "beach", userAgent: "Mozilla/5.0 Safari" })
    expect(await cache.smembers("evm:v1:dirty:2026-02-01")).toHaveLength(2)
    expect(await cache.smembers("evm:v1:dirty:2026-02-02")).toHaveLength(0)
  })

  it("rolls up in the default zone", async () => {
    const repo = repoStub()
    const service = makeMetricsService({
      repo,
      cache: new InMemoryCacheClient(),
      selfHosts: [],
      lookbackDays: 3,
    })
    await service.rollup()
    expect(repo.recomputed).toEqual([{ cleanupId: EVENT, timezone: DEFAULT_EVENT_TIME_ZONE }])
  })

  it("reports and trends insights in the default zone", async () => {
    const trendZones: string[] = []
    const analytics = {
      eventClock: () =>
        Promise.resolve({
          status: "upcoming",
          createdAt: new Date("2026-03-01T00:00:00Z"),
          scheduledAt: new Date("2026-03-07T17:00:00Z"),
          endsAt: null,
          completedAt: null,
          registrationClosesAt: null,
          timezone: null,
        }),
      seatTrend: (_id: string, timezone: string) => {
        trendZones.push(timezone)
        return Promise.resolve([])
      },
      registrationsBySource: () => Promise.resolve([]),
      broadcastsForEvent: () => Promise.resolve([]),
      eventHoursTotals: () =>
        Promise.resolve({ credited: 0, attendeesCredited: 0, attendeesCheckedIn: 0 }),
      returningAttendees: () => Promise.resolve({ seats: 0, ofRegistered: 0 }),
      hostedEventIds: () => Promise.resolve([]),
      topVolunteers: () => Promise.resolve([]),
    } as unknown as AnalyticsRepository
    const registrations = new InMemoryHostRegistrationRepository()
    registrations.seedEvent({ cleanupId: EVENT, scheduledAt: new Date("2026-03-07T17:00:00Z") })
    const service = makeInsightsService({
      analytics,
      registrations,
      cache: makeHostAnalyticsCache({ cache: new InMemoryCacheClient(), ttlSeconds: 60 }),
      now: () => new Date("2026-03-05T12:00:00Z"),
    })
    const payload = await service.insights(EVENT, { userId: EVENT, viewerScope: "organizer:none" })
    expect(payload.clock.timezone).toBe(DEFAULT_EVENT_TIME_ZONE)
    expect(trendZones).toEqual([DEFAULT_EVENT_TIME_ZONE])
  })
})

describe("counter flush reads every local day a bump can write", () => {
  it("flushes a view counted on an event-local day ahead of UTC", async () => {
    const at = new Date("2026-02-02T20:00:00Z")
    const repo = repoStub({
      resolveSlug: () => Promise.resolve({ cleanupId: EVENT, timezone: "Asia/Tokyo" }),
    })
    const service = makeMetricsService({
      repo,
      cache: new InMemoryCacheClient(),
      selfHosts: [],
      lookbackDays: 3,
      now: () => at,
    })
    await service.recordPageView({ slug: "beach", userAgent: "Mozilla/5.0 Safari" })
    await service.flushCounters()
    expect(repo.greatest.map((row) => row.day)).toContain("2026-02-03")
  })
})
