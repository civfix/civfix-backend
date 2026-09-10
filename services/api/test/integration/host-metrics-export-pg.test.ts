import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleMetricsRepository } from "../../src/services/host/metrics-repository.drizzle.js"
import type { MetricsRepository } from "../../src/services/host/metrics-repository.drizzle.js"
import { makeDrizzleHostExportRepository } from "../../src/services/host/export-repository.drizzle.js"
import type { HostExportRepository } from "../../src/services/host/export-repository.drizzle.js"
import { makeHostExportService } from "../../src/services/host/export-service.js"
import {
  registerHostExportBuilder,
  resetHostExportBuildersForTests,
} from "../../src/services/host/export-builders.js"

const pg = await withPg()

describe.skipIf(!pg)("event metrics and host exports (integration)", () => {
  let h: PgHarness
  let metrics: MetricsRepository
  let exportsRepo: HostExportRepository
  let cleanupId: string
  let userId: string

  beforeAll(async () => {
    h = pg as PgHarness
    metrics = makeDrizzleMetricsRepository(h.sql)
    exportsRepo = makeDrizzleHostExportRepository(h.sql)
    const [user] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES ('Host') RETURNING id`
    userId = user!.id
    cleanupId = randomUUID()
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (${cleanupId}, ${userId}, 'site', 'Beach sweep',
              ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326),
              ${new Date(Date.now() + 7 * 86_400_000)}, 'upcoming')`
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("upserts counter metrics with GREATEST and never lowers a day", async () => {
    const row = { cleanupId, day: "2026-02-01", metric: "page_views", bucket: "", value: 5 }
    await metrics.upsertGreatest([row])
    await metrics.upsertGreatest([{ ...row, value: 3 }])
    const read = await metrics.read(cleanupId, ["page_views"], "2026-01-01", "2026-12-31")
    expect(read.find((r) => r.day === "2026-02-01")?.value).toBe(5)
    await metrics.upsertGreatest([{ ...row, value: 9 }])
    const raised = await metrics.read(cleanupId, ["page_views"], "2026-01-01", "2026-12-31")
    expect(raised.find((r) => r.day === "2026-02-01")?.value).toBe(9)
  })

  it("upserts recomputed metrics exactly, so a cancellation can lower a day", async () => {
    const row = { cleanupId, day: "2026-02-02", metric: "registrations", bucket: "", value: 8 }
    await metrics.upsertExact([row])
    await metrics.upsertExact([{ ...row, value: 6 }])
    const read = await metrics.read(cleanupId, ["registrations"], "2026-01-01", "2026-12-31")
    expect(read.find((r) => r.day === "2026-02-02")?.value).toBe(6)
  })

  it("keeps source buckets as separate rows", async () => {
    await metrics.upsertGreatest([
      { cleanupId, day: "2026-02-03", metric: "source", bucket: "search", value: 4 },
      { cleanupId, day: "2026-02-03", metric: "source", bucket: "social", value: 2 },
    ])
    const read = await metrics.read(cleanupId, ["source"], "2026-02-03", "2026-02-03")
    expect(read.map((r) => r.bucket).sort()).toEqual(["search", "social"])
  })

  it("runs an export from queued to ready and reaps the object before the row", async () => {
    resetHostExportBuildersForTests()
    registerHostExportBuilder("roster", {
      filename: () => "civfix-roster-test.csv",
      header: () => Promise.resolve(["id", "name"]),
      provenance: () => Promise.resolve(["member email is never included"]),
      rows: async function* () {
        yield ["1", "Alex"]
      },
    })
    const objects = new Map<string, Buffer>()
    let clock = new Date()
    const service = makeHostExportService({
      repo: exportsRepo,
      storage: {
        put: (key, body) => {
          objects.set(key, Buffer.from(body))
          return Promise.resolve()
        },
        presignGet: (key, ttl, opts) =>
          Promise.resolve(`https://signed.example/${key}?ttl=${ttl}&signed=${opts?.forceSigned}`),
        delete: (key) => {
          objects.delete(key)
          return Promise.resolve()
        },
      },
      config: { maxRows: 100, maxBytes: 1_000_000, ttlHours: 1 },
      now: () => clock,
    })

    const created = await service.request({
      cleanupId,
      organizationId: null,
      requestedBy: userId,
      kind: "roster",
      filters: undefined,
    })
    expect(await service.run(created.id)).toEqual({ status: "ready" })
    const ready = await service.get(created.id)
    expect(ready.status).toBe("ready")
    expect(ready.r2Key).toMatch(/^exports\/host\/\d{4}\/\d{2}\//)
    expect(objects.size).toBe(1)

    const link = await service.downloadUrl(ready)
    expect(link.url).toContain("ttl=300")
    expect(link.url).toContain("signed=true")

    expect(await service.reap(10)).toEqual({ reaped: 0 })

    clock = new Date(clock.getTime() + 2 * 3_600_000)
    expect(await service.reap(10)).toEqual({ reaped: 1 })
    expect(objects.size).toBe(0)
    const expired = await service.get(created.id)
    expect(expired.status).toBe("expired")
    expect(expired.r2Key).toBeNull()
  })
})
