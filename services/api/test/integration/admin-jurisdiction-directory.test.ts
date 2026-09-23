import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleJurisdictionContactsRepository } from "../../src/services/admin/jurisdiction-contacts-repository.drizzle.js"
import type { JurisdictionContactsRepository } from "../../src/services/admin/jurisdiction-contacts-types.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()
const GEOID = LA_CITY.geoid

async function insertReport(
  h: PgHarness,
  opts: { status?: string; geoid?: string | null } = {},
): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO reports (
      idempotency_key, geom, geom_source, category, status, visibility, h3_cell, jurisdiction_geoid, created_at
    )
    VALUES (
      gen_random_uuid(),
      ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326),
      'manual', 'trash',
      ${opts.status ?? "submitted"},
      'public', 'h0',
      ${opts.geoid === undefined ? GEOID : opts.geoid},
      now()
    )
    RETURNING id
  `
  return rows[0]!.id
}

const ARGS = {
  q: null,
  filter: "all" as const,
  layer: null,
  sort: "reports" as const,
  cursor: null,
  limit: 25,
}

describe.skipIf(!pg)("admin jurisdiction directory (integration: real schema)", () => {
  let h: PgHarness
  let repo: JurisdictionContactsRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleJurisdictionContactsRepository(h.sql)
  })

  beforeEach(async () => {
    await h.sql`TRUNCATE report_timeline, jurisdiction_contacts RESTART IDENTITY CASCADE`
    await h.sql`DELETE FROM reports`
    await h.sql`UPDATE jurisdictions SET contact_emails = NULL, handle = NULL WHERE geoid = ${GEOID}`
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("F011: lastRoutedAt comes from the per-geoid acknowledged timeline; reportsWaiting excludes routed reports", async () => {
    await insertReport(h, { status: "submitted" })
    const routed = await insertReport(h, { status: "acknowledged" })
    await h.sql`INSERT INTO report_timeline (report_id, status) VALUES (${routed}, 'acknowledged')`

    const result = await repo.listDirectory(ARGS)
    const la = result.records.find((r) => r.geoid === GEOID)
    expect(la).toBeDefined()
    expect(la!.reportsWaiting).toBe(1)
    expect(la!.lastRoutedAt).toBeInstanceOf(Date)
  })

  it("F011: a jurisdiction with no acknowledged timeline has a null lastRoutedAt", async () => {
    await insertReport(h, { status: "submitted" })
    const result = await repo.listDirectory(ARGS)
    const la = result.records.find((r) => r.geoid === GEOID)
    expect(la).toBeDefined()
    expect(la!.lastRoutedAt).toBeNull()
    expect(la!.reportsWaiting).toBe(1)
  })

  it("F123: a unique violation raised by the UPDATE itself (lost race) surfaces as 409, not 500", async () => {
    const others = await h.sql<{ geoid: string }[]>`
      SELECT geoid FROM jurisdictions WHERE geoid <> ${GEOID} LIMIT 1
    `
    const other = others[0]
    expect(other).toBeDefined()
    await h.sql`UPDATE jurisdictions SET handle = NULL WHERE geoid IN (${GEOID}, ${other!.geoid})`

    let claimed!: () => void
    const claimedAt = new Promise<void>((resolve) => (claimed = resolve))
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    const holder = h.sql.begin(async (tx) => {
      await tx`UPDATE jurisdictions SET handle = 'race' WHERE geoid = ${other!.geoid}`
      claimed()
      await released
    })
    await claimedAt

    const patched = repo.patch(GEOID, { handle: "race" }, { actorId: null })
    let blocked = false
    for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
      const rows = await h.sql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'
      `
      blocked = (rows[0]?.n ?? 0) > 0
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(blocked).toBe(true)

    release()
    await holder
    await expect(patched).rejects.toMatchObject({ httpStatus: 409 })

    const after = await h.sql<{ handle: string | null }[]>`
      SELECT handle FROM jurisdictions WHERE geoid = ${GEOID}
    `
    expect(after[0]?.handle).toBeNull()
  })

  it("F123: patching a second jurisdiction to an in-use @handle returns a 409 conflict", async () => {
    await repo.patch(GEOID, { handle: "sf" }, { actorId: null })
    const others = await h.sql<{ geoid: string }[]>`
      SELECT geoid FROM jurisdictions WHERE geoid <> ${GEOID} LIMIT 1
    `
    const other = others[0]
    if (other === undefined) return
    await expect(
      repo.patch(other.geoid, { handle: "SF" }, { actorId: null }),
    ).rejects.toMatchObject({ httpStatus: 409 })
  })
})
