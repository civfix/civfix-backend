/**
 * Volunteer-hours integration test (Docker-gated). Exercises the Drizzle VolunteerHoursRepository's
 * WS5 per-attendee logEventHours against a live PostGIS container:
 *
 *   - the unnest(uuid[], float8[]) pairing credits each attendee THEIR OWN hours in one statement,
 *     upserting on the 0035 partial-unique index (cleanup_id, user_id) WHERE source='event';
 *   - a re-log OVERWRITES per row and adjusts the user_jurisdiction_hours rollup by the per-row delta
 *     (no double-count), including a mixed re-log that raises one attendee and lowers another;
 *   - the geoid-less branch writes the ledger and adds nothing to the rollup, but DOES reverse a prior
 *     credit out of the jurisdiction the event has moved out of.
 *
 * When Docker is unavailable the whole block SKIPS so the local suite stays green; CI runs it for real.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleVolunteerHoursRepository } from "../../src/services/volunteer-hours-repository.drizzle.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const GEOID = LA_CITY.geoid

const pg = await withPg()

describe.skipIf(!pg)("volunteer hours (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  /** Insert a user and return its id. */
  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id
    `
    return u!.id
  }

  /** Insert a minimal done cleanup owned by `organizerId` and return its id. */
  async function newCleanup(organizerId: string): Promise<string> {
    const id = randomUUID()
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, status, jurisdiction_geoid)
      VALUES (
        ${id}, ${organizerId}, 'site', 'Hours sweep',
        ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326),
        now() - interval '1 day', 'done', ${GEOID}
      )
    `
    return id
  }

  async function rollupFor(userId: string): Promise<number> {
    const rows = await h.sql<{ total: number }[]>`
      SELECT total_hours::float8 AS total FROM user_jurisdiction_hours
      WHERE user_id = ${userId} AND jurisdiction_geoid = ${GEOID}
    `
    return rows[0]?.total ?? 0
  }

  it("credits per-attendee hours in one statement and overwrites per row on re-log (rollup delta)", async () => {
    const org = await newUser("Hours Org")
    const alice = await newUser("Hours Alice")
    const bob = await newUser("Hours Bob")
    const cleanupId = await newCleanup(org)
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    // First log: three DIFFERENT amounts through the single unnest-paired statement.
    const credited = await repo.logEventHours({
      actorId: org,
      cleanupId,
      geoid: GEOID,
      entries: [
        { userId: org, hours: 2 },
        { userId: alice, hours: 4.5 },
        { userId: bob, hours: 1 },
      ],
    })
    expect(credited).toBe(3)

    const ledger = await h.sql<{ user_id: string; hours: number; logged_by: string }[]>`
      SELECT user_id, hours::float8 AS hours, logged_by_user_id AS logged_by
      FROM volunteer_hours WHERE cleanup_id = ${cleanupId} AND source = 'event'
    `
    expect(ledger).toHaveLength(3)
    const byUser = Object.fromEntries(ledger.map((r) => [r.user_id, r.hours]))
    expect(byUser).toEqual({ [org]: 2, [alice]: 4.5, [bob]: 1 })
    expect(ledger.every((r) => r.logged_by === org)).toBe(true)

    expect(await rollupFor(org)).toBe(2)
    expect(await rollupFor(alice)).toBe(4.5)
    expect(await rollupFor(bob)).toBe(1)

    // Mixed re-log for a SUBSET: alice goes DOWN (4.5 -> 3), bob goes UP (1 -> 2). Still one row each
    // (the 0035 partial-unique conflict target), and the rollup moves by the per-row delta.
    const relogged = await repo.logEventHours({
      actorId: org,
      cleanupId,
      geoid: GEOID,
      entries: [
        { userId: alice, hours: 3 },
        { userId: bob, hours: 2 },
      ],
    })
    expect(relogged).toBe(2)

    const rows = await h.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM volunteer_hours
      WHERE cleanup_id = ${cleanupId} AND source = 'event'
    `
    expect(rows[0]!.count).toBe(3)
    expect(await rollupFor(alice)).toBe(3)
    expect(await rollupFor(bob)).toBe(2)
    // Untouched attendee keeps their credit.
    expect(await rollupFor(org)).toBe(2)

    // totalsFor reads the rollup consistently.
    const totals = await repo.totalsFor(alice)
    expect(totals.totalHours).toBe(3)
    expect(totals.byJurisdiction).toEqual([{ geoid: GEOID, name: LA_CITY.name, hours: 3 }])
  })

  it("a geoid-less event writes the ledger but never the rollup", async () => {
    const org = await newUser("Hours NoGeo Org")
    const cleanupId = randomUUID()
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (
        ${cleanupId}, ${org}, 'site', 'No-geo sweep',
        ST_SetSRID(ST_MakePoint(-118.3, 34.1), 4326),
        now() - interval '1 day', 'done'
      )
    `
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)
    const credited = await repo.logEventHours({
      actorId: org,
      cleanupId,
      geoid: null,
      entries: [{ userId: org, hours: 2.5 }],
    })
    expect(credited).toBe(1)

    const ledger = await h.sql<{ hours: number }[]>`
      SELECT hours::float8 AS hours FROM volunteer_hours
      WHERE cleanup_id = ${cleanupId} AND source = 'event' AND user_id = ${org}
    `
    expect(ledger[0]!.hours).toBe(2.5)
    expect(await rollupFor(org)).toBe(0)
  })

  /**
   * The event MOVED OUT of all coverage (a host edited its location, so cleanup-service re-resolved
   * jurisdiction_geoid to null) and the hours were re-logged. The geoid-less branch used to upsert the
   * ledger row and return, leaving the prior credit on the OLD jurisdiction's PUBLIC leaderboard forever —
   * with the ledger row that backed it now saying "no jurisdiction". The in-memory twin
   * (volunteer-hours-repository.memory.ts) always reversed in this case, so fake and prod disagreed.
   */
  it("re-logging after the event moves OUT of coverage reverses the old jurisdiction's rollup", async () => {
    const org = await newUser("Hours Moved Org")
    const alice = await newUser("Hours Moved Alice")
    const cleanupId = await newCleanup(org)
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    await repo.logEventHours({
      actorId: org,
      cleanupId,
      geoid: GEOID,
      entries: [
        { userId: org, hours: 2 },
        { userId: alice, hours: 3 },
      ],
    })
    expect(await rollupFor(org)).toBe(2)
    expect(await rollupFor(alice)).toBe(3)

    // Same event, now outside coverage, re-logged with new amounts.
    const credited = await repo.logEventHours({
      actorId: org,
      cleanupId,
      geoid: null,
      entries: [
        { userId: org, hours: 4 },
        { userId: alice, hours: 1 },
      ],
    })
    expect(credited).toBe(2)

    // The ledger keeps ONE row per attendee, with the new hours and NO jurisdiction.
    const ledger = await h.sql<{ user_id: string; hours: number; geoid: string | null }[]>`
      SELECT user_id, hours::float8 AS hours, jurisdiction_geoid AS geoid
      FROM volunteer_hours WHERE cleanup_id = ${cleanupId} AND source = 'event'
    `
    expect(ledger).toHaveLength(2)
    expect(ledger.every((r) => r.geoid === null)).toBe(true)
    expect(Object.fromEntries(ledger.map((r) => [r.user_id, r.hours]))).toEqual({
      [org]: 4,
      [alice]: 1,
    })

    // ...and the old jurisdiction's leaderboard no longer carries the withdrawn credit.
    expect(await rollupFor(org)).toBe(0)
    expect(await rollupFor(alice)).toBe(0)
    const totals = await repo.totalsFor(alice)
    expect(totals.byJurisdiction).toEqual([])
    expect(totals.totalHours).toBe(0)
  })

  /**
   * Re-logging an event that NEVER had a jurisdiction must still be a plain overwrite: the reversal arm
   * only fires for a prior credit that was actually booked somewhere.
   */
  it("re-logging a never-mapped event just overwrites (no phantom reversal)", async () => {
    const org = await newUser("Hours NoGeo Twice")
    const cleanupId = randomUUID()
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (
        ${cleanupId}, ${org}, 'site', 'No-geo re-log',
        ST_SetSRID(ST_MakePoint(-118.31, 34.11), 4326),
        now() - interval '1 day', 'done'
      )
    `
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)
    await repo.logEventHours({ actorId: org, cleanupId, geoid: null, entries: [{ userId: org, hours: 1 }] })
    const credited = await repo.logEventHours({
      actorId: org,
      cleanupId,
      geoid: null,
      entries: [{ userId: org, hours: 6 }],
    })
    expect(credited).toBe(1)

    const ledger = await h.sql<{ hours: number; geoid: string | null }[]>`
      SELECT hours::float8 AS hours, jurisdiction_geoid AS geoid FROM volunteer_hours
      WHERE cleanup_id = ${cleanupId} AND source = 'event' AND user_id = ${org}
    `
    expect(ledger).toHaveLength(1)
    expect(ledger[0]!.hours).toBe(6)
    expect(ledger[0]!.geoid).toBeNull()
    const rows = await h.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM user_jurisdiction_hours WHERE user_id = ${org}
    `
    expect(rows[0]!.count).toBe(0)
  })

  // --- M21: the upsert overwrote hours in place with no history ------------------------------------
  // `DO UPDATE SET hours = EXCLUDED.hours, logged_by_user_id = EXCLUDED.logged_by_user_id` destroyed
  // both the previous value AND the only trace of who set it, so a host could inflate a credit and
  // later quietly restore it with the row left indistinguishable from one never touched — against a
  // number that feeds the PUBLIC jurisdiction leaderboard.
  it("M21: every upsert appends an immutable audit row carrying the previous + new value", async () => {
    const org = await newUser("Audit Org")
    const alice = await newUser("Audit Alice")
    const cohost = await newUser("Audit Cohost")
    const cleanupId = await newCleanup(org)
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    async function auditRows(): Promise<
      { user_id: string; actor_user_id: string; previous_hours: number | null; new_hours: number }[]
    > {
      return h.sql`
        SELECT user_id, actor_user_id, previous_hours::float8 AS previous_hours, new_hours::float8 AS new_hours
        FROM volunteer_hours_audit
        WHERE cleanup_id = ${cleanupId}
        ORDER BY created_at ASC, new_hours ASC
      `
    }

    await repo.logEventHours({ actorId: org, cleanupId, geoid: GEOID, entries: [{ userId: alice, hours: 2 }] })
    let rows = await auditRows()
    expect(rows).toHaveLength(1)
    // NULL previous_hours = there was no prior credit, deliberately distinct from a stored 0.
    expect(rows[0]).toMatchObject({ user_id: alice, actor_user_id: org, previous_hours: null, new_hours: 2 })

    // The inflation...
    await repo.logEventHours({ actorId: org, cleanupId, geoid: GEOID, entries: [{ userId: alice, hours: 40 }] })
    // ...and the quiet restore, by a different host.
    await repo.logEventHours({ actorId: cohost, cleanupId, geoid: GEOID, entries: [{ userId: alice, hours: 2 }] })

    rows = await auditRows()
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => [r.previous_hours, r.new_hours])).toEqual([
      [null, 2],
      [2, 40],
      [40, 2],
    ])
    expect(rows.map((r) => r.actor_user_id)).toEqual([org, org, cohost])

    // The live ledger is back where it started — the journal is the ONLY evidence it ever moved.
    const ledger = await h.sql<{ hours: number }[]>`
      SELECT hours::float8 AS hours FROM volunteer_hours
      WHERE cleanup_id = ${cleanupId} AND source = 'event' AND user_id = ${alice}
    `
    expect(ledger[0]!.hours).toBe(2)
  })

  it("M21: the audit is written for the geoid-less branch too", async () => {
    const org = await newUser("Audit NoGeo Org")
    const alice = await newUser("Audit NoGeo Alice")
    const cleanupId = randomUUID()
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (
        ${cleanupId}, ${org}, 'site', 'No-geo audit sweep',
        ST_SetSRID(ST_MakePoint(-118.3, 34.1), 4326),
        now() - interval '1 day', 'done'
      )
    `
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)
    await repo.logEventHours({ actorId: org, cleanupId, geoid: null, entries: [{ userId: alice, hours: 1 }] })
    await repo.logEventHours({ actorId: org, cleanupId, geoid: null, entries: [{ userId: alice, hours: 5 }] })

    const rows = await h.sql<{ previous_hours: number | null; new_hours: number }[]>`
      SELECT previous_hours::float8 AS previous_hours, new_hours::float8 AS new_hours
      FROM volunteer_hours_audit WHERE cleanup_id = ${cleanupId} ORDER BY created_at ASC, new_hours ASC
    `
    expect(rows.map((r) => [r.previous_hours, r.new_hours])).toEqual([
      [null, 1],
      [1, 5],
    ])
  })
})
