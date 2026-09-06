import { describe, expect, it } from "vitest"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import {
  classifyPageViewSource,
  eventDayKey,
  isBotUserAgent,
  makeMetricsService,
  parseCounterKey,
} from "../../src/services/host/metrics-service.js"
import type {
  MetricUpsert,
  MetricsRepository,
} from "../../src/services/host/metrics-repository.drizzle.js"

const EVENT = "00000000-0000-0000-0000-0000000000ee"

function repoStub(): MetricsRepository & { greatest: MetricUpsert[]; exact: MetricUpsert[] } {
  const greatest: MetricUpsert[] = []
  const exact: MetricUpsert[] = []
  return {
    greatest,
    exact,
    resolveSlug: (slug) =>
      Promise.resolve(
        slug === "beach-cleanup"
          ? { cleanupId: EVENT, timezone: "America/Los_Angeles" }
          : null,
      ),
    eventTimezone: () => Promise.resolve("America/Los_Angeles"),
    listRollupEvents: () => Promise.resolve([EVENT]),
    recomputeFromSource: () =>
      Promise.resolve([
        { cleanupId: EVENT, day: "2026-02-01", metric: "registrations", bucket: "", value: 4 },
      ]),
    upsertExact: (rows) => {
      exact.push(...rows)
      return Promise.resolve()
    },
    upsertGreatest: (rows) => {
      greatest.push(...rows)
      return Promise.resolve()
    },
    read: () => Promise.resolve([]),
    readMany: () => Promise.resolve([]),
  }
}

function build(now: Date) {
  const repo = repoStub()
  const cache = new InMemoryCacheClient()
  const service = makeMetricsService({
    repo,
    cache,
    selfHosts: ["civfix.org"],
    lookbackDays: 3,
    now: () => now,
  })
  return { repo, cache, service }
}

describe("bot filter", () => {
  it("drops known crawlers and empty agents", () => {
    expect(isBotUserAgent(undefined)).toBe(true)
    expect(isBotUserAgent("")).toBe(true)
    expect(isBotUserAgent("Googlebot/2.1")).toBe(true)
    expect(isBotUserAgent("facebookexternalhit/1.1")).toBe(true)
    expect(isBotUserAgent("curl/8.1")).toBe(true)
  })

  it("keeps a real browser", () => {
    expect(
      isBotUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1",
      ),
    ).toBe(false)
  })
})

describe("source classification", () => {
  it("maps referrers into the closed bucket set", () => {
    expect(classifyPageViewSource({ referrer: "https://www.google.com/search?q=x" })).toBe("search")
    expect(classifyPageViewSource({ referrer: "https://nextdoor.com/x" })).toBe("social")
    expect(classifyPageViewSource({ referrer: "https://someblog.example/x" })).toBe("referral")
    expect(classifyPageViewSource({})).toBe("direct")
  })

  it("treats a same-host referrer as direct", () => {
    expect(
      classifyPageViewSource({ referrer: "https://civfix.org/e/x", selfHosts: ["civfix.org"] }),
    ).toBe("direct")
  })

  it("maps an unrecognized utm_source to other rather than passing it through", () => {
    expect(classifyPageViewSource({ utmSource: "some-agency-campaign" })).toBe("other")
    expect(classifyPageViewSource({ utmSource: "google" })).toBe("search")
    expect(classifyPageViewSource({ utmSource: "app" })).toBe("app")
  })
})

describe("event day keys", () => {
  it("uses the event timezone, not UTC", () => {
    const at = new Date("2026-02-02T04:30:00Z")
    expect(eventDayKey(at, "America/Los_Angeles")).toBe("2026-02-01")
    expect(eventDayKey(at, null)).toBe("2026-02-02")
  })

  it("falls back to UTC on a garbage timezone", () => {
    expect(eventDayKey(new Date("2026-02-02T04:30:00Z"), "Not/AZone")).toBe("2026-02-02")
  })
})

describe("page view counters", () => {
  it("counts a view and its source bucket", async () => {
    const { service, cache } = build(new Date("2026-02-02T04:30:00Z"))
    await service.recordPageView({ slug: "beach-cleanup", userAgent: "Mozilla/5.0 Safari" })
    const keys = await cache.smembers("evm:v1:dirty:2026-02-01")
    expect(keys).toHaveLength(2)
    expect(keys.some((k) => k.endsWith(":page_views:"))).toBe(true)
    expect(keys.some((k) => k.endsWith(":source:direct"))).toBe(true)
  })

  it("counts nothing for a bot", async () => {
    const { service, cache } = build(new Date("2026-02-02T04:30:00Z"))
    await service.recordPageView({ slug: "beach-cleanup", userAgent: "Googlebot/2.1" })
    expect(await cache.smembers("evm:v1:dirty:2026-02-01")).toHaveLength(0)
  })

  it("counts nothing for an unknown slug and does not throw", async () => {
    const { service, cache } = build(new Date("2026-02-02T04:30:00Z"))
    await expect(
      service.recordPageView({ slug: "nope", userAgent: "Mozilla/5.0 Safari" }),
    ).resolves.toEqual({ ok: true })
    expect(await cache.smembers("evm:v1:dirty:2026-02-01")).toHaveLength(0)
  })

  it("flushes counters with GREATEST semantics and never deletes them", async () => {
    const now = new Date("2026-02-02T04:30:00Z")
    const { service, repo, cache } = build(now)
    await service.recordPageView({ slug: "beach-cleanup", userAgent: "Mozilla/5.0 Safari" })
    await service.recordPageView({ slug: "beach-cleanup", userAgent: "Mozilla/5.0 Safari" })
    const first = await service.flushCounters()
    expect(first.flushed).toBe(2)
    expect(repo.greatest.find((r) => r.metric === "page_views")?.value).toBe(2)

    repo.greatest.length = 0
    const second = await service.flushCounters()
    expect(second.flushed).toBe(2)
    expect(repo.greatest.find((r) => r.metric === "page_views")?.value).toBe(2)
    expect(await cache.smembers("evm:v1:dirty:2026-02-01")).toHaveLength(2)
  })

  it("recomputes source-derived metrics exactly (a cancellation can lower a day)", async () => {
    const { service, repo } = build(new Date("2026-02-02T04:30:00Z"))
    const result = await service.rollup()
    expect(result.events).toBe(1)
    expect(repo.exact).toHaveLength(1)
    expect(repo.greatest).toHaveLength(0)
  })
})

describe("counter keys", () => {
  it("round-trips", () => {
    expect(parseCounterKey(`evm:v1:${EVENT}:2026-02-01:page_views:`)).toEqual({
      cleanupId: EVENT,
      day: "2026-02-01",
      metric: "page_views",
      bucket: "",
    })
  })

  it("rejects a foreign or malformed key", () => {
    expect(parseCounterKey("other:v1:x:2026-02-01:m:")).toBeNull()
    expect(parseCounterKey("evm:v1:x:bad:m:")).toBeNull()
    expect(parseCounterKey("evm:v1:x")).toBeNull()
  })
})
