import { describe, it, expect } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import type { Sql } from "../../src/db/client.js"
import { makeDrizzleHomeRepository } from "../../src/services/admin/home-repository.drizzle.js"
import { makeDrizzleAnalyticsRepository } from "../../src/services/admin/analytics-repository.drizzle.js"

const EVENT_ID = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e51"
const CACHE_TTL_MS = 60_000

describe("home map event pins", () => {
  it("carry the event's real flag state", async () => {
    const ctl = makeFakeSql([
      {
        match: /FROM cleanups c/,
        rows: [
          {
            id: EVENT_ID,
            lat: 1,
            lng: 2,
            status: "upcoming",
            event_kind: "cleanup",
            title: "Park",
            place: null,
            attendees: "3",
            flagged: true,
          },
        ],
      },
    ])
    const repo = makeDrizzleHomeRepository(ctl.sql as unknown as Sql)
    const pins = await repo.recentPins(10)
    expect(pins.find((p) => p.refType === "event")?.flagged).toBe(true)
    const eventQuery = ctl.statements.find((s) => /FROM cleanups c/.test(s.sql))
    expect(eventQuery?.sql).toMatch(/cleanup_timeline/)
  })
})

describe("analytics top contributors", () => {
  it("rank only public reports and live, unbanned accounts before the cut", async () => {
    const ctl = makeFakeSql()
    const repo = makeDrizzleAnalyticsRepository(ctl.sql as unknown as Sql)
    await repo.topContributors(5)
    const text = ctl.statements[0]?.sql ?? ""
    const reportCounts = text.slice(
      text.indexOf("report_counts AS"),
      text.indexOf("cleanup_counts"),
    )
    expect(reportCounts).toMatch(/visibility = 'public'/)
    const top = text.slice(text.indexOf("top AS"), text.indexOf("user_city AS"))
    expect(top).toMatch(/deleted_at IS NULL/)
    expect(top).toMatch(/'banned'/)
  })
})

describe("analytics TTL cache", () => {
  it("is scoped to the database handle a repository was built over", async () => {
    const first = makeFakeSql([{ match: /FROM reports/, rows: [{ category: "litter", n: "7" }] }])
    const second = makeFakeSql([
      { match: /FROM reports/, rows: [{ category: "graffiti", n: "2" }] },
    ])
    const a = makeDrizzleAnalyticsRepository(first.sql as unknown as Sql, {
      cacheTtlMs: CACHE_TTL_MS,
    })
    const b = makeDrizzleAnalyticsRepository(second.sql as unknown as Sql, {
      cacheTtlMs: CACHE_TTL_MS,
    })
    const fromA = await a.byCategory()
    const fromB = await b.byCategory()
    expect(fromB).not.toEqual(fromA)
    expect(second.statements).toHaveLength(1)
  })
})
