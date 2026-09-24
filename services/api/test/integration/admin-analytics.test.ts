import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { makeDrizzleAnalyticsRepository } from "../../src/services/admin/analytics-repository.drizzle.js"
import type { AnalyticsRepository } from "../../src/services/admin/analytics-repository.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"
import type { CleanupStatus } from "@civfix/shared"

const pg = await withPg()
const GEOID = LA_CITY.geoid

async function insertUser(h: PgHarness, name: string): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO users (display_name) VALUES (${name}) RETURNING id
  `
  return rows[0]!.id
}

async function insertReport(
  h: PgHarness,
  opts: {
    category?: string
    status?: string
    reporterId?: string | null
    visibility?: string
    createdAt?: Date
    publishedAt?: Date | null
    geoid?: string | null
  },
): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO reports (
      reporter_user_id, idempotency_key, geom, geom_source, category, status, visibility, h3_cell,
      jurisdiction_geoid, created_at, published_at
    )
    VALUES (
      ${opts.reporterId ?? null},
      gen_random_uuid(),
      ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326),
      'manual',
      ${opts.category ?? "trash"},
      ${opts.status ?? "submitted"},
      ${opts.visibility ?? "public"},
      'h0',
      ${opts.geoid === undefined ? GEOID : opts.geoid},
      ${opts.createdAt ?? new Date()},
      ${opts.publishedAt ?? null}
    )
    RETURNING id
  `
  return rows[0]!.id
}

async function insertCleanup(
  h: PgHarness,
  opts: {
    organizerId: string
    status?: CleanupStatus
    scheduledAt?: Date
    createdAt?: Date
    bags?: number
    title?: string
  },
): Promise<string> {
  return await seedCleanup(h.sql, {
    organizerUserId: opts.organizerId,
    title: opts.title ?? "Cleanup",
    scheduledAt: opts.scheduledAt ?? new Date(),
    status: opts.status,
    bags: opts.bags ?? 0,
    createdAt: opts.createdAt ?? new Date(),
  })
}

async function addMember(h: PgHarness, cleanupId: string, userId: string): Promise<void> {
  await h.sql`
    INSERT INTO cleanup_members (cleanup_id, user_id, role)
    VALUES (${cleanupId}, ${userId}, 'attendee')
    ON CONFLICT DO NOTHING
  `
}

describe.skipIf(!pg)("admin analytics repository (integration: real schema)", () => {
  let h: PgHarness
  let repo: AnalyticsRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleAnalyticsRepository(h.sql)
  })

  beforeEach(async () => {
    await h.sql`TRUNCATE cleanup_members, jurisdiction_contacts RESTART IDENTITY CASCADE`
    await h.sql`DELETE FROM cleanups`
    await h.sql`DELETE FROM reports`
    await h.sql`DELETE FROM users`
    await h.sql`UPDATE jurisdictions SET contact_emails = NULL WHERE geoid = ${GEOID}`
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("kpis: pins this month + resolved ratio over public, non-deleted reports", async () => {
    await insertReport(h, { status: "resolved" })
    await insertReport(h, { status: "submitted" })
    await insertReport(h, { status: "submitted", visibility: "hidden" })

    const agg = await repo.kpis()
    expect(agg.pins.current).toBe(2)
    expect(agg.resolvedRatio.current).toBeCloseTo(0.5, 5)
  })

  it("byCategory: grouped counts for public reports only", async () => {
    await insertReport(h, { category: "trash" })
    await insertReport(h, { category: "trash" })
    await insertReport(h, { category: "hazard" })
    await insertReport(h, { category: "hazard", visibility: "hidden" })

    const rows = await repo.byCategory()
    const byCat = new Map(rows.map((r) => [r.category, r.count]))
    expect(byCat.get("trash")).toBe(2)
    expect(byCat.get("hazard")).toBe(1)
  })

  it("funnel: dropped / routed / acknowledged / resolved", async () => {
    await insertReport(h, { status: "submitted" })
    await insertReport(h, { status: "in_progress" })
    await insertReport(h, { status: "resolved" })
    await insertReport(h, { status: "submitted", geoid: null })

    const f = await repo.funnel()
    expect(f.dropped).toBe(4)
    expect(f.routed).toBe(3)
    expect(f.acknowledged).toBe(2)
    expect(f.resolved).toBe(1)
  })

  it("coverage: mapped vs needs-mapping by contact presence", async () => {
    await h.sql`UPDATE jurisdictions SET contact_emails = ARRAY['x@city.gov'] WHERE geoid = ${GEOID}`
    const c = await repo.coverage()
    expect(c.mapped).toBeGreaterThanOrEqual(1)
    expect(c.mapped + c.needsMapping).toBeGreaterThanOrEqual(3)
  })

  it("resolutionByCategory: percentile_cont median hours for resolved reports", async () => {
    const created = new Date("2026-06-01T00:00:00Z")
    await insertReport(h, {
      category: "trash",
      status: "resolved",
      createdAt: created,
      publishedAt: new Date(created.getTime() + 10 * 3600 * 1000),
    })
    await insertReport(h, {
      category: "trash",
      status: "resolved",
      createdAt: created,
      publishedAt: new Date(created.getTime() + 20 * 3600 * 1000),
    })
    const rows = await repo.resolutionByCategory()
    const trash = rows.find((r) => r.category === "trash")
    expect(trash?.medianHours).toBeCloseTo(15, 1)
  })

  it("events: thisMonth + bags + volunteers + byMonth", async () => {
    const org = await insertUser(h, "Organizer")
    const id = await insertCleanup(h, { organizerId: org, bags: 12, scheduledAt: new Date() })
    const vol = await insertUser(h, "Volunteer")
    await addMember(h, id, vol)

    const e = await repo.events(8)
    expect(e.thisMonth).toBe(1)
    expect(e.bags).toBe(12)
    expect(e.volunteers).toBe(1)
    expect(e.byMonth.length).toBeGreaterThanOrEqual(1)
  })

  it("topJurisdictions: ranked by pin volume with the joined name", async () => {
    await insertReport(h, { status: "resolved" })
    await insertReport(h, { status: "submitted" })
    const rows = await repo.topJurisdictions(10)
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows[0]?.pins).toBe(2)
    expect(rows[0]?.resolved).toBe(1)
    expect(rows[0]?.org).toBe(LA_CITY.name)
  })

  it("topContributors: reports + cleanups per user, ranked", async () => {
    const alice = await insertUser(h, "Alice")
    await insertReport(h, { reporterId: alice })
    await insertReport(h, { reporterId: alice })
    await insertCleanup(h, { organizerId: alice })

    const rows = await repo.topContributors(10)
    const a = rows.find((r) => r.name === "Alice")
    expect(a?.reports).toBe(2)
    expect(a?.cleanups).toBe(1)
  })

  it("heatmap: per-jurisdiction density with ST_Centroid lat/lng", async () => {
    await insertReport(h, {})
    await insertReport(h, {})
    const cells = await repo.heatmap(100)
    const la = cells.find((c) => c.geoid === GEOID)
    expect(la?.density).toBe(2)
    expect(typeof la?.lat).toBe("number")
    expect(typeof la?.lng).toBe("number")
  })

  it("pinsByWeek: weekly buckets within the trailing window", async () => {
    await insertReport(h, { createdAt: new Date() })
    const buckets = await repo.pinsByWeek(8)
    const total = buckets.reduce((a, b) => a + b.count, 0)
    expect(total).toBeGreaterThanOrEqual(1)
  })

  it("retention: a signup-month cohort with its size + active counts", async () => {
    const u = await insertUser(h, "Cohort User")
    await insertReport(h, { reporterId: u, createdAt: new Date() })
    const rows = await repo.retention(6)
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const cohort = rows.find((r) => r.size >= 1)
    expect(cohort).toBeDefined()
    expect(cohort!.activeByPeriod[0]).toBeGreaterThanOrEqual(1)
  })

  it("F117: events this-month excludes a cleanup scheduled in a future month", async () => {
    const org = await insertUser(h, "Organizer")
    await insertCleanup(h, { organizerId: org, bags: 5, scheduledAt: new Date() })
    const future = new Date()
    future.setUTCMonth(future.getUTCMonth() + 3)
    await insertCleanup(h, { organizerId: org, bags: 99, scheduledAt: future })

    const e = await repo.events(8)
    expect(e.thisMonth).toBe(1)
    expect(e.bags).toBe(5)

    const k = await repo.kpis()
    expect(k.events.current).toBe(1)
  })

  it("F120: a blank-email contact does not mark a jurisdiction as mapped", async () => {
    const before = await repo.coverage()
    await h.sql`
      INSERT INTO jurisdiction_contacts (geoid, category, email)
      VALUES (${GEOID}, 'graffiti', '')
    `
    const after = await repo.coverage()
    expect(after.mapped).toBe(before.mapped)
  })

  it("F121: two jurisdictions sharing a name stay separate rows (grouped by geoid)", async () => {
    const dupGeoid = "TESTDUP01"
    await h.sql`
      INSERT INTO jurisdictions (geoid, name, layer, priority, geom)
      VALUES (
        ${dupGeoid}, ${LA_CITY.name}, 'county', 5,
        ST_Multi(ST_SetSRID(ST_GeomFromText('POLYGON((-118 34,-118 34.1,-118.1 34.1,-118.1 34,-118 34))'), 4326))
      )
    `
    await insertReport(h, {})
    await insertReport(h, {})
    await insertReport(h, { geoid: dupGeoid })
    await insertReport(h, { geoid: dupGeoid })
    await insertReport(h, { geoid: dupGeoid })

    const rows = await repo.topJurisdictions(10)
    const named = rows.filter((r) => r.org.startsWith(LA_CITY.name))
    expect(named.length).toBe(2)
    expect(named.some((r) => r.pins === 2)).toBe(true)
    expect(named.some((r) => r.pins === 3)).toBe(true)
    expect(named.some((r) => r.pins === 5)).toBe(false)

    await h.sql`DELETE FROM reports WHERE jurisdiction_geoid = ${dupGeoid}`
    await h.sql`DELETE FROM jurisdictions WHERE geoid = ${dupGeoid}`
  })

  it("F124: soft-deleted users are excluded from retention cohort sizes", async () => {
    const active = await insertUser(h, "Active")
    await insertReport(h, { reporterId: active, createdAt: new Date() })
    const deleted = await insertUser(h, "Deleted User")
    await h.sql`UPDATE users SET deleted_at = now() WHERE id = ${deleted}`

    const rows = await repo.retention(6)
    const cohort = rows.find((r) => r.size >= 1)
    expect(cohort).toBeDefined()
    expect(cohort!.size).toBe(1)
  })
})
