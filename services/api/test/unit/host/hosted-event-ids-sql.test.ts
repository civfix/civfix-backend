import { describe, expect, it } from "vitest"
import type { Sql } from "../../../src/db/client.js"
import { makeDrizzleAnalyticsRepository } from "../../../src/services/host/analytics-repository.drizzle.js"
import { makeSqlRecorder } from "../../helpers/sql-recorder.js"

const USER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const ORG = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"

async function hostedEventIdsQuery(organizationId: string | null) {
  const rec = makeSqlRecorder()
  rec.enqueue([{ id: "b" }, { id: "a" }])
  const ids = await makeDrizzleAnalyticsRepository(rec.sql as unknown as Sql).hostedEventIds(
    USER,
    organizationId,
    7,
  )
  expect(rec.queries).toHaveLength(1)
  return { ids, query: rec.queries[0]! }
}

describe("hostedEventIds SQL", () => {
  it("resolves the three hosting relations as a UNION of per-user lookups, not correlated EXISTS", async () => {
    const { ids, query } = await hostedEventIdsQuery(null)

    expect(ids).toEqual(["b", "a"])
    expect(query.text).not.toContain("EXISTS")
    expect(query.text).toContain("WHERE c.id IN ( SELECT oc.id FROM cleanups oc")
    expect(query.text).toContain("WHERE oc.organizer_user_id = $1 UNION")
    expect(query.text).toContain(
      "SELECT m.cleanup_id FROM cleanup_members m WHERE m.user_id = $2 AND m.role IN ('organizer','cohost','coordinator') UNION",
    )
    expect(query.text).toContain(
      "JOIN cleanups hc ON hc.organization_id = om.organization_id WHERE om.user_id = $3 AND om.role IN ('owner','admin'))",
    )
    expect(query.text).toMatch(/\) ORDER BY c\.scheduled_at DESC LIMIT \$4$/)
    expect(query.params).toEqual([USER, USER, USER, 7])
  })

  it("applies the organization filter to the outer event row", async () => {
    const { query } = await hostedEventIdsQuery(ORG)

    expect(query.text).toMatch(
      /\) AND c\.organization_id = \$4 ORDER BY c\.scheduled_at DESC LIMIT \$5$/,
    )
    expect(query.params).toEqual([USER, USER, USER, ORG, 7])
  })
})
