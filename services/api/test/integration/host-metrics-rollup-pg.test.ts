import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { makeDrizzleMetricsRepository } from "../../src/services/host/metrics-repository.drizzle.js"
import type { MetricsRepository } from "../../src/services/host/metrics-repository.js"

const pg = await withPg()

const ZONE = "America/Los_Angeles"

describe.skipIf(!pg)("event metrics rollup windows (integration)", () => {
  let h: PgHarness
  let metrics: MetricsRepository
  let cleanupId: string

  async function user(name: string): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id`
    return row!.id
  }

  beforeAll(async () => {
    h = pg as PgHarness
    metrics = makeDrizzleMetricsRepository(h.sql)
    const host = await user("Host")
    cleanupId = await seedCleanup(h.sql, {
      organizerUserId: host,
      title: "Rollup window",
      scheduledAt: new Date("2026-02-10T17:00:00Z"),
    })
    for (const [name, at] of [
      ["Early", "2026-02-01T09:00:00Z"],
      ["Late", "2026-02-02T07:00:00Z"],
    ] as const) {
      const attendee = await user(name)
      await h.sql`
        INSERT INTO cleanup_registrations (cleanup_id, user_id, status, registered_at)
        VALUES (${cleanupId}, ${attendee}, 'registered', ${new Date(at)})`
    }
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("counts the whole local day that contains the window start", async () => {
    const since = new Date("2026-02-01T20:00:00Z")
    const rows = await metrics.recomputeFromSource(cleanupId, ZONE, since)
    const feb1 = rows.find((row) => row.metric === "registrations" && row.day === "2026-02-01")
    expect(feb1?.value).toBe(2)
  })

  it("pages the active events after a keyset id", async () => {
    const since = new Date("2026-01-01T00:00:00Z")
    const first = await metrics.listRollupEvents(since, null, 1000)
    expect(first).toContain(cleanupId)
    const after = await metrics.listRollupEvents(since, cleanupId, 1000)
    expect(after).not.toContain(cleanupId)
    expect(after.every((id) => id > cleanupId)).toBe(true)
  })
})
