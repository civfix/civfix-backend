import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { pruneNonAuthoritativeJurisdictions } from "../../src/db/backfill-jurisdictions-core.js"

const pg = await withPg()

const DEV_GEOID = "DEVFED-PRUNE"
const PADUS_GEOID = "PADUS-PRUNE-1"
const SQUARE = "POLYGON((-100.5 40.5,-99.5 40.5,-99.5 41.5,-100.5 41.5,-100.5 40.5))"
const POINT = { lng: -100, lat: 41 }

describe.skipIf(!pg)("non-authoritative jurisdiction prune (integration)", () => {
  let h: PgHarness
  let volunteer: string
  let voidedVolunteer: string
  let prunedCleanup: string
  let paddedCleanup: string

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id
    `
    return u!.id
  }

  async function addJurisdiction(geoid: string): Promise<void> {
    await h.sql`
      INSERT INTO jurisdictions (geoid, name, layer, priority, geom)
      VALUES (${geoid}, ${geoid}, 'federal', 0, ST_Multi(ST_SetSRID(ST_GeomFromText(${SQUARE}), 4326)))
    `
  }

  async function addHours(args: {
    userId: string
    cleanupId: string
    hours: number
    geoid: string
    voided?: boolean
  }): Promise<void> {
    await h.sql`
      INSERT INTO volunteer_hours (user_id, hours, source, cleanup_id, jurisdiction_geoid, voided_at)
      VALUES (
        ${args.userId}, ${args.hours}, 'event', ${args.cleanupId}, ${args.geoid},
        ${args.voided === true ? new Date() : null}
      )
    `
  }

  async function rollup(userId: string, geoid: string): Promise<number | null> {
    const rows = await h.sql<{ total: number }[]>`
      SELECT total_hours::float8 AS total FROM user_jurisdiction_hours
      WHERE user_id = ${userId} AND jurisdiction_geoid = ${geoid}
    `
    return rows[0]?.total ?? null
  }

  beforeAll(async () => {
    h = pg as PgHarness
    await addJurisdiction(DEV_GEOID)
    const organizer = await newUser("Prune Organizer")
    volunteer = await newUser("Prune Volunteer")
    voidedVolunteer = await newUser("Voided Volunteer")
    prunedCleanup = await seedCleanup(h.sql, {
      organizerUserId: organizer,
      ...POINT,
      jurisdictionGeoid: DEV_GEOID,
    })
    await addHours({ userId: volunteer, cleanupId: prunedCleanup, hours: 2.5, geoid: DEV_GEOID })
    await addHours({
      userId: voidedVolunteer,
      cleanupId: prunedCleanup,
      hours: 4,
      geoid: DEV_GEOID,
      voided: true,
    })
    await h.sql`
      INSERT INTO user_jurisdiction_hours (user_id, jurisdiction_geoid, total_hours)
      VALUES (${volunteer}, ${DEV_GEOID}, 2.5)
    `

    await addJurisdiction(PADUS_GEOID)
    paddedCleanup = await seedCleanup(h.sql, {
      organizerUserId: organizer,
      ...POINT,
      jurisdictionGeoid: PADUS_GEOID,
    })
    await addHours({ userId: volunteer, cleanupId: paddedCleanup, hours: 1.5, geoid: PADUS_GEOID })
    await h.sql`
      INSERT INTO user_jurisdiction_hours (user_id, jurisdiction_geoid, total_hours)
      VALUES (${volunteer}, ${PADUS_GEOID}, 1.5)
    `
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("changes nothing without confirmation", async () => {
    const result = await pruneNonAuthoritativeJurisdictions(h.sql, { apply: false })

    expect(result.applied).toBe(false)
    expect(result.staleGeoids).toContain(DEV_GEOID)
    expect(result.staleGeoids).not.toContain(PADUS_GEOID)
    expect(result.affected.cleanups).toBeGreaterThanOrEqual(1)
    expect(result.affected.volunteer_hours).toBeGreaterThanOrEqual(2)
    const [cleanup] = await h.sql<{ geoid: string | null }[]>`
      SELECT jurisdiction_geoid AS geoid FROM cleanups WHERE id = ${prunedCleanup}
    `
    expect(cleanup?.geoid).toBe(DEV_GEOID)
    expect(await rollup(volunteer, DEV_GEOID)).toBe(2.5)
  })

  it("moves the cleanup, its hours and the rollup onto the authoritative boundary", async () => {
    const result = await pruneNonAuthoritativeJurisdictions(h.sql, { apply: true })
    expect(result.applied).toBe(true)
    expect(result.reresolved?.cleanups).toBeGreaterThanOrEqual(1)

    const [cleanup] = await h.sql<{ geoid: string | null }[]>`
      SELECT jurisdiction_geoid AS geoid FROM cleanups WHERE id = ${prunedCleanup}
    `
    expect(cleanup?.geoid).toBe(PADUS_GEOID)

    const hours = await h.sql<{ user_id: string; geoid: string | null }[]>`
      SELECT user_id, jurisdiction_geoid AS geoid FROM volunteer_hours WHERE cleanup_id = ${prunedCleanup}
    `
    expect(hours.map((r) => r.geoid)).toEqual([PADUS_GEOID, PADUS_GEOID])

    expect(await rollup(volunteer, PADUS_GEOID)).toBe(4)
    expect(await rollup(volunteer, DEV_GEOID)).toBeNull()
    expect(await rollup(voidedVolunteer, PADUS_GEOID)).toBeNull()

    const gone = await h.sql`SELECT 1 FROM jurisdictions WHERE geoid = ${DEV_GEOID}`
    expect(gone).toHaveLength(0)
  })

  it("is a no-op once nothing non-authoritative remains", async () => {
    const result = await pruneNonAuthoritativeJurisdictions(h.sql, { apply: true })
    expect(result.staleGeoids).toEqual([])
    expect(await rollup(volunteer, PADUS_GEOID)).toBe(4)
  })
})
