import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleAnonHoldReleaseRepo } from "../../src/services/anon-hold-release-repo.drizzle.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()

describe.skipIf(!pg)("anon hold-release candidates (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function seedHeld(ageMinutes: number, title: string): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (
        idempotency_key, geom, geom_source, category, title, status, visibility, h3_cell,
        jurisdiction_geoid, anon_session_id, created_at
      )
      VALUES (
        gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', ${title},
        'held', 'hidden', 'h0', ${LA_CITY.geoid}, ${`anontok-${title}`},
        now() - make_interval(mins => ${ageMinutes})
      )
      RETURNING id
    `
    return row!.id
  }

  it("F019: the checked-at watermark rotates the batch so a newer held report is never starved", async () => {
    await h.sql`DELETE FROM reports WHERE anon_session_id IS NOT NULL`
    const stuckA = await seedHeld(180, "stuckA")
    const stuckB = await seedHeld(170, "stuckB")
    const fresh = await seedHeld(5, "fresh")

    const repo = makeDrizzleAnonHoldReleaseRepo(h.sql)

    const first = await repo.findHeldAnonReportIds(2)
    expect([...first].sort()).toEqual([stuckA, stuckB].sort())
    const stamped = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM reports
      WHERE id = ANY(${first}::uuid[]) AND hold_release_checked_at IS NOT NULL
    `
    expect(stamped[0]!.n).toBe(2)

    const second = await repo.findHeldAnonReportIds(2)
    expect(second).toContain(fresh)
    expect([...second].sort()).not.toEqual([...first].sort())

    const third = await repo.findHeldAnonReportIds(3)
    expect([...third].sort()).toEqual([stuckA, stuckB, fresh].sort())
  })
})
