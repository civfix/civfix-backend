import { describe, expect, it } from "vitest"
import { makeFakeSql } from "../../helpers/fake-sql.js"
import {
  INSIGHTS_SOURCE_LIMIT,
  INSIGHTS_TREND_LIMIT,
  makeDrizzleAnalyticsRepository,
} from "../../../src/services/host/analytics-repository.drizzle.js"
import { makeDrizzleEventAnalyticsRepository } from "../../../src/services/host/event-analytics-repository.drizzle.js"
import { MAX_INSIGHTS_TOP_VOLUNTEERS } from "@civfix/shared"
import type { Sql } from "../../../src/db/client.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const EARLIER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const LATER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

async function emitted(run: (sql: Sql) => Promise<unknown>): Promise<{
  sql: string
  values: unknown[]
}> {
  const fake = makeFakeSql()
  await run(fake.sql as unknown as Sql)
  const stmt = fake.statements[0]
  expect(stmt).toBeDefined()
  return stmt!
}

function squash(sql: string): string {
  return sql.replace(/\s+/g, " ").trim()
}

describe("insights analytics SQL", () => {
  it("keeps the most recent trend days rather than the oldest", async () => {
    const stmt = await emitted((sql) => makeDrizzleAnalyticsRepository(sql).seatTrend(EVENT, "UTC"))
    const text = squash(stmt.sql)

    expect(text).toContain("GROUP BY at ORDER BY at DESC LIMIT ?")
    expect(text).toContain("FROM days ORDER BY at ASC")
    expect(stmt.values).toContain(INSIGHTS_TREND_LIMIT)
  })

  it("orders registration sources by the seat total, not by its text rendering", async () => {
    const stmt = await emitted((sql) =>
      makeDrizzleAnalyticsRepository(sql).registrationsBySource(EVENT),
    )
    const text = squash(stmt.sql)

    expect(text).toContain("ORDER BY COALESCE(sum(party_size), 0) DESC, source ASC")
    expect(text).not.toMatch(/ORDER BY 2 DESC/)
    expect(stmt.values).toContain(INSIGHTS_SOURCE_LIMIT)
  })

  it("counts a volunteer as returning only from events held before this one", async () => {
    const stmt = await emitted((sql) =>
      makeDrizzleAnalyticsRepository(sql).returningAttendees(EVENT, [EARLIER, LATER]),
    )
    const text = squash(stmt.sql)

    expect(text).toContain(
      "c.scheduled_at < (SELECT s.scheduled_at FROM cleanups s WHERE s.id = ?)",
    )
    expect(text).toContain("p.cleanup_id IN (SELECT id FROM prior)")
    expect(text).toContain(") AS is_returning")
    expect(text).toContain("FILTER (WHERE is_returning)")
    expect(stmt.values).toContain(EVENT)
  })

  it("asks nothing of the database when the host has no other events", async () => {
    const fake = makeFakeSql()
    const result = await makeDrizzleAnalyticsRepository(
      fake.sql as unknown as Sql,
    ).returningAttendees(EVENT, [])

    expect(result).toEqual({ seats: 0, ofRegistered: 0 })
    expect(fake.statements).toEqual([])
  })
})

describe("#110 host hours SQL", () => {
  it("names every credited volunteer, ignoring the PUBLIC hours opt-out", async () => {
    const stmt = await emitted((sql) =>
      makeDrizzleAnalyticsRepository(sql).topVolunteers(
        [EARLIER, LATER],
        MAX_INSIGHTS_TOP_VOLUNTEERS,
      ),
    )
    const text = squash(stmt.sql)

    expect(text).not.toContain("show_volunteer_hours")
    expect(text).toContain("vh.source = 'event'")
    expect(text).toContain("vh.voided_at IS NULL")
    expect(text).toContain("u.deleted_at IS NULL")
    expect(text).toContain("ORDER BY sum(vh.hours) DESC, vh.user_id")
    expect(stmt.values).toContain(MAX_INSIGHTS_TOP_VOLUNTEERS)
  })

  it("totals the same ledger the named rows come from", async () => {
    const stmt = await emitted((sql) =>
      makeDrizzleAnalyticsRepository(sql).hoursTotals([EARLIER, LATER]),
    )
    const text = squash(stmt.sql)

    expect(text).not.toContain("show_volunteer_hours")
    expect(text).toContain("COALESCE(sum(vh.hours), 0)::float8 AS credited")
    expect(text).toContain("count(DISTINCT vh.user_id)::int AS volunteers_credited")
    expect(text).toContain("vh.source = 'event'")
    expect(text).toContain("vh.voided_at IS NULL")
  })

  it("asks nothing of the database when the scope holds no events", async () => {
    const fake = makeFakeSql()
    const repo = makeDrizzleAnalyticsRepository(fake.sql as unknown as Sql)

    expect(await repo.topVolunteers([], MAX_INSIGHTS_TOP_VOLUNTEERS)).toEqual([])
    expect(await repo.hoursTotals([])).toEqual({ credited: 0, volunteersCredited: 0 })
    expect(fake.statements).toEqual([])
  })
})

describe("event analytics comparison cohort SQL", () => {
  const USER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
  const ORG = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"

  it("drives each membership branch from an indexed column instead of a correlated EXISTS", async () => {
    const stmt = await emitted((sql) =>
      makeDrizzleEventAnalyticsRepository(sql).previousCompletedEventIds({
        userId: USER,
        organizationId: null,
        excludeCleanupId: EVENT,
        limit: 12,
      }),
    )
    const text = squash(stmt.sql)

    expect(text).not.toContain("EXISTS")
    expect(text).toContain("FROM cleanups c WHERE c.organizer_user_id = ?")
    expect(text).toContain("FROM cleanup_members m JOIN cleanups c ON c.id = m.cleanup_id")
    expect(text).toContain(
      "FROM organization_members om JOIN cleanups c ON c.organization_id = om.organization_id",
    )
    expect(text.match(/UNION/g)).toHaveLength(2)
    expect(text).toContain("SELECT id FROM hosted ORDER BY completed_at DESC LIMIT ?")
    expect(stmt.values).toContain(12)
  })

  it("applies the organization filter to every branch", async () => {
    const stmt = await emitted((sql) =>
      makeDrizzleEventAnalyticsRepository(sql).previousCompletedEventIds({
        userId: USER,
        organizationId: ORG,
        excludeCleanupId: EVENT,
        limit: 12,
      }),
    )
    const text = squash(stmt.sql)

    expect(text.match(/AND c\.organization_id = \?/g)).toHaveLength(3)
    expect(text.match(/AND c\.completed_at IS NOT NULL/g)).toHaveLength(3)
    expect(text.match(/AND c\.id <> \?/g)).toHaveLength(3)
    expect(stmt.values.filter((v) => v === ORG)).toHaveLength(3)
  })
})
