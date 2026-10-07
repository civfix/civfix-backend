import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleJurisdictionContactsRepository } from "../../src/services/admin/jurisdiction-contacts-repository.drizzle.js"
import type { JurisdictionContactsRepository } from "../../src/services/admin/jurisdiction-contacts-repository.js"
import type {
  DirectorySort,
  JurisdictionDirectoryRecord,
} from "../../src/services/admin/jurisdiction-contacts-repository.js"
import { LA_CITY, LA_COUNTY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()
const GEOID = LA_CITY.geoid

async function insertReport(
  h: PgHarness,
  opts: { status?: string; geoid?: string | null; createdAt?: Date } = {},
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
      ${opts.createdAt ?? h.sql`now()`}
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
    await h.sql`DELETE FROM users WHERE handle = 'MixedMember'`
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

  it("rejects a @handle a member already holds in another letter case (409) and leaves it unset", async () => {
    await h.sql`INSERT INTO users (display_name, handle) VALUES ('Mixed', 'MixedMember')`

    await expect(
      repo.patch(GEOID, { handle: "mixedmember" }, { actorId: null }),
    ).rejects.toMatchObject({ httpStatus: 409 })

    const after = await h.sql<{ handle: string | null }[]>`
      SELECT handle FROM jurisdictions WHERE geoid = ${GEOID}
    `
    expect(after[0]?.handle).toBeNull()
  })

  describe("paging keeps the directory order and decorates every page", () => {
    const REFERENCE_ORDER: Record<DirectorySort, string> = {
      reports: "COALESCE(w.total, 0) DESC, j.geoid ASC",
      name: "j.name ASC, j.geoid ASC",
      oldest: "w.oldest_waiting_at ASC NULLS LAST, j.geoid ASC",
      population: "COALESCE(j.population, 0) DESC, j.geoid ASC",
    }

    async function referenceOrder(sort: DirectorySort): Promise<string[]> {
      const rows = await h.sql.unsafe<{ geoid: string }[]>(`
        SELECT j.geoid
          FROM jurisdictions j
          LEFT JOIN (
            SELECT r.jurisdiction_geoid AS geoid, COUNT(*) AS total, MIN(r.created_at) AS oldest_waiting_at
              FROM reports r
             WHERE r.jurisdiction_geoid IS NOT NULL
               AND r.deleted_at IS NULL
               AND r.status NOT IN ('rejected', 'resolved', 'acknowledged', 'in_progress')
             GROUP BY r.jurisdiction_geoid
          ) w ON w.geoid = j.geoid
         ORDER BY ${REFERENCE_ORDER[sort]}
      `)
      return rows.map((r) => r.geoid)
    }

    async function walk(sort: DirectorySort): Promise<JurisdictionDirectoryRecord[]> {
      const out: JurisdictionDirectoryRecord[] = []
      let cursor: string | null = null
      do {
        const page = await repo.listDirectory({ ...ARGS, sort, cursor, limit: 1 })
        out.push(...page.records)
        cursor = page.nextCursor
      } while (cursor !== null)
      return out
    }

    beforeEach(async () => {
      await insertReport(h, { geoid: LA_COUNTY.geoid, createdAt: new Date("2026-03-01T00:00:00Z") })
      await insertReport(h, { geoid: LA_COUNTY.geoid, createdAt: new Date("2026-03-02T00:00:00Z") })
      await insertReport(h, { createdAt: new Date("2026-02-01T00:00:00Z") })
      const routed = await insertReport(h, { status: "acknowledged" })
      await h.sql`INSERT INTO report_timeline (report_id, status) VALUES (${routed}, 'acknowledged')`
      await h.sql`
        INSERT INTO jurisdiction_contacts (geoid, category, email, bounced_at)
        VALUES (${GEOID}, NULL, 'default@example.lacity.gov', NULL),
               (${GEOID}, 'trash', 'trash@example.lacity.gov', now())
      `
    })

    it.each(["reports", "name", "oldest", "population"] as const)(
      "%s: one-row pages walk the same rows, in the reference order, as one full page",
      async (sort) => {
        const full = await repo.listDirectory({ ...ARGS, sort, limit: 100 })
        const walked = await walk(sort)

        expect(full.nextCursor).toBeNull()
        expect(walked).toEqual(full.records)
        expect(walked.map((r) => r.geoid)).toEqual(await referenceOrder(sort))

        const city = walked.find((r) => r.geoid === GEOID)!
        expect(city.hasDefaultContact).toBe(true)
        expect(city.categoryContacts).toEqual([
          { category: "trash", email: "trash@example.lacity.gov" },
        ])
        expect(city.lastRoutedAt).toBeInstanceOf(Date)
        expect(city.bounced).toBe(true)
        expect(city.reportsWaiting).toBe(1)
      },
    )

    it("decorates a row that lands on a later page", async () => {
      const walked = await walk("reports")
      const at = walked.findIndex((r) => r.geoid === GEOID)
      expect(at).toBeGreaterThan(0)
      expect(walked[at]!.hasDefaultContact).toBe(true)
      expect(walked[at]!.bounced).toBe(true)
      expect(walked[at]!.lastRoutedAt).toBeInstanceOf(Date)
    })
  })

  describe("contact save writes clears and sets as two set-based statements", () => {
    it("deletes the cleared categories, upserts the rest and clears a re-saved bounce", async () => {
      await h.sql`
        INSERT INTO jurisdiction_contacts (geoid, category, email, bounced_at)
        VALUES (${GEOID}, 'trash', 'old-trash@example.lacity.gov', now()),
               (${GEOID}, 'graffiti', 'graffiti@example.lacity.gov', NULL),
               (${GEOID}, 'hazard', 'hazard@example.lacity.gov', NULL)
      `

      await repo.patch(
        GEOID,
        {
          contacts: {
            trash: " trash@example.lacity.gov ",
            graffiti: null,
            hazard: "  ",
            water: "water@example.lacity.gov",
          },
        },
        { actorId: null },
      )

      const rows = await h.sql<{ category: string; email: string; bounced: boolean }[]>`
        SELECT category, email, bounced_at IS NOT NULL AS bounced
          FROM jurisdiction_contacts
         WHERE geoid = ${GEOID} AND category IS NOT NULL
         ORDER BY category
      `
      expect(rows).toEqual([
        { category: "trash", email: "trash@example.lacity.gov", bounced: false },
        { category: "water", email: "water@example.lacity.gov", bounced: false },
      ])
    })
  })
})
