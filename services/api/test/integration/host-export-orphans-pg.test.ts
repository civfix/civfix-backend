import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import {
  makeDrizzleHostExportRepository,
  type HostExportRepository,
} from "../../src/services/host/export-repository.drizzle.js"

const pg = await withPg()

describe.skipIf(!pg)("host export orphaned objects (integration)", () => {
  let h: PgHarness
  let repo: HostExportRepository
  let cleanupId: string
  let userId: string

  async function exportRow(fields: {
    status: string
    r2Key: string | null
    requestedAt: Date
    startedAt?: Date | null
  }): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO host_exports (cleanup_id, requested_by, kind, status, r2_key, requested_at, started_at)
      VALUES (${cleanupId}, ${userId}, 'roster', ${fields.status}, ${fields.r2Key},
              ${fields.requestedAt}, ${fields.startedAt ?? null})
      RETURNING id`
    return row!.id
  }

  beforeAll(async () => {
    h = pg as PgHarness
    repo = makeDrizzleHostExportRepository(h.sql)
    const [user] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES ('Host') RETURNING id`
    userId = user!.id
    cleanupId = await seedCleanup(h.sql, { organizerUserId: userId, title: "Exports" })
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("keeps an old row that still names an object and deletes one that does not", async () => {
    const old = new Date("2025-01-01T00:00:00Z")
    const holding = await exportRow({
      status: "failed",
      r2Key: "exports/host/a.csv",
      requestedAt: old,
    })
    const clean = await exportRow({ status: "expired", r2Key: null, requestedAt: old })
    await repo.deleteOlderThan(new Date("2025-06-01T00:00:00Z"), 100)
    expect(await repo.findById(holding)).not.toBeNull()
    expect(await repo.findById(clean)).toBeNull()
  })

  it("lists failed rows holding an object and stale runs, then releases them under a guard", async () => {
    const staleBefore = new Date("2026-02-05T11:00:00Z")
    const stale = await exportRow({
      status: "running",
      r2Key: "exports/host/b.csv",
      requestedAt: new Date("2026-02-05T09:00:00Z"),
      startedAt: new Date("2026-02-05T09:00:00Z"),
    })
    const fresh = await exportRow({
      status: "running",
      r2Key: null,
      requestedAt: new Date("2026-02-05T11:30:00Z"),
      startedAt: new Date("2026-02-05T11:30:00Z"),
    })
    const listed = await repo.listOrphaned({ staleBefore, limit: 50 })
    const ids = listed.map((row) => row.id)
    expect(ids).toContain(stale)
    expect(ids).not.toContain(fresh)

    const record = listed.find((row) => row.id === stale)!
    expect(await repo.releaseObject(record, "build_failed")).toBe(true)
    const released = await repo.findById(stale)
    expect(released?.status).toBe("failed")
    expect(released?.r2Key).toBeNull()
    expect(released?.errorCode).toBe("build_failed")
    expect(await repo.releaseObject(record, "build_failed")).toBe(false)
  })

  it("only lets the run holding the token fail the row or replace the key it was told about", async () => {
    const staleBefore = new Date("2026-02-05T11:00:00Z")
    const id = await exportRow({
      status: "running",
      r2Key: "exports/host/crashed.csv",
      requestedAt: new Date("2026-02-05T09:00:00Z"),
      startedAt: new Date("2026-02-05T09:00:00Z"),
    })
    const claimed = await repo.claimForRun(id, staleBefore)
    expect(claimed?.r2Key).toBe("exports/host/crashed.csv")
    const runToken = claimed!.runToken

    expect(
      await repo.recordObjectKey(id, { r2Key: "exports/host/new.csv", runToken, replaces: null }),
    ).toBe(false)
    expect(await repo.markFailed(id, "build_failed", "00000000-0000-0000-0000-000000000000")).toBe(
      false,
    )
    expect((await repo.findById(id))?.status).toBe("running")

    expect(
      await repo.recordObjectKey(id, {
        r2Key: "exports/host/new.csv",
        runToken,
        replaces: "exports/host/crashed.csv",
      }),
    ).toBe(true)
    expect(await repo.markFailed(id, "build_failed", runToken)).toBe(true)
    const failed = await repo.findById(id)
    expect(failed?.status).toBe("failed")
    expect(failed?.r2Key).toBe("exports/host/new.csv")
  })
})
