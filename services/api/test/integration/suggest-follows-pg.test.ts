/**
 * Audit H18: GET /users/follow-suggestions used to build its candidate set from EVERY non-deleted,
 * handle-bearing user and run a per-candidate LATERAL + geography distance before applying the LIMIT.
 * The rewrite bounds the candidates FIRST, with three index-backed pools over the materialized
 * users.last_activity_geom / last_activity_at pair (0102).
 *
 * Docker-gated, because the only honest test of "this query is index-bounded" is the real planner
 * against the real schema. Two things are asserted here that no unit test can see:
 *   - the KNN pool plans as an Index Scan on users_last_activity_gist (and the recency pool on
 *     users_last_activity_at_idx), i.e. the LIMIT is applied by the index, not after a full sort;
 *   - a viewer with NO location still gets a bounded page instead of the whole users table.
 *
 * The two indexes are built HERE, not by migration 0102: `users` is a hot table, so on a live box they
 * are built out of band with CREATE INDEX CONCURRENTLY (docs/out-of-band-indexes.md), which cannot run
 * inside the migration runner's per-file transaction. This test builds the same definitions
 * non-concurrently on the empty testcontainer, so a drift between the documented DDL and what the query
 * needs shows up as a failing plan assertion.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import {
  makeDrizzleSocialRepository,
  SUGGEST_CANDIDATE_POOL,
  SUGGEST_KNN_INDEX,
  SUGGEST_RECENCY_INDEX,
} from "../../src/services/social-repository.drizzle.js"
import { backfillUserActivity } from "../../src/db/backfill-user-activity-core.js"
import { touchUserActivity } from "../../src/db/sql/user-activity.js"
import type { SocialRepository } from "../../src/services/social-service.js"

const pg = await withPg()

const LA = { lat: 34.05, lng: -118.24 }
const NY = { lat: 40.71, lng: -74.0 }

describe.skipIf(!pg)("H18: follow suggestions are bounded before ranking", () => {
  let h: PgHarness
  let repo: SocialRepository

  beforeAll(async () => {
    h = pg as PgHarness
    repo = makeDrizzleSocialRepository(h.sql)
    await h.sql`
      CREATE INDEX IF NOT EXISTS users_last_activity_gist
        ON users USING gist (last_activity_geom)
        WHERE last_activity_geom IS NOT NULL AND deleted_at IS NULL
    `
    await h.sql`
      CREATE INDEX IF NOT EXISTS users_last_activity_at_idx
        ON users (last_activity_at DESC)
        WHERE last_activity_at IS NOT NULL AND deleted_at IS NULL
    `
  })

  beforeEach(async () => {
    await h.sql`DELETE FROM follows_people`
    await h.sql`UPDATE users SET last_activity_geom = NULL, last_activity_at = NULL`
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${testHandle()}) RETURNING id
    `
    return u!.id
  }

  it("plans the KNN candidate pool as an index scan on the GiST index", async () => {
    const viewer = await newUser("Viewer")
    const plan = await h.sql<{ "QUERY PLAN": string }[]>`
      EXPLAIN (COSTS OFF)
      SELECT u.id
      FROM users u
      WHERE u.deleted_at IS NULL
        AND u.handle IS NOT NULL
        AND u.id <> ${viewer}
        AND u.last_activity_geom IS NOT NULL
      ORDER BY u.last_activity_geom <-> ST_SetSRID(ST_MakePoint(${LA.lng}, ${LA.lat}), 4326)
      LIMIT ${SUGGEST_CANDIDATE_POOL}
    `
    const text = plan.map((r) => r["QUERY PLAN"]).join("\n")
    expect(text).toContain(SUGGEST_KNN_INDEX)
    expect(text).not.toContain("Seq Scan on users")
  })

  it("plans the recency fallback pool as an index scan on the recency index", async () => {
    const viewer = await newUser("Viewer")
    const plan = await h.sql<{ "QUERY PLAN": string }[]>`
      EXPLAIN (COSTS OFF)
      SELECT u.id
      FROM users u
      WHERE u.deleted_at IS NULL
        AND u.handle IS NOT NULL
        AND u.id <> ${viewer}
        AND u.last_activity_at IS NOT NULL
      ORDER BY u.last_activity_at DESC
      LIMIT ${SUGGEST_CANDIDATE_POOL}
    `
    const text = plan.map((r) => r["QUERY PLAN"]).join("\n")
    expect(text).toContain(SUGGEST_RECENCY_INDEX)
    expect(text).not.toContain("Seq Scan on users")
  })

  it("ranks a nearby activity point ahead of a far one, from the materialized column alone", async () => {
    const viewer = await newUser("Viewer")
    const near = await newUser("Near")
    const far = await newUser("Far")
    const at = new Date("2026-08-01T00:00:00Z")
    await touchUserActivity(h.sql, { userId: viewer, ...LA, at })
    await touchUserActivity(h.sql, { userId: near, lat: LA.lat + 0.05, lng: LA.lng + 0.05, at })
    await touchUserActivity(h.sql, { userId: far, ...NY, at })

    // The viewer's own point comes from their reports/events, not the column, so seed one event.
    await seedOrganizedEvent(viewer, LA)

    const results = await repo.suggestFollows({ viewerId: viewer, limit: 10 })
    const ids = results.map((r) => r.id)
    expect(ids).toContain(near)
    expect(ids).toContain(far)
    expect(ids.indexOf(near)).toBeLessThan(ids.indexOf(far))
    expect(ids).not.toContain(viewer)
  })

  it("returns a bounded page for a viewer with no location at all", async () => {
    const viewer = await newUser("Rootless")
    for (let i = 0; i < 25; i++) await newUser(`Person ${i}`)
    const results = await repo.suggestFollows({ viewerId: viewer, limit: 10 })
    const ids = results.map((r) => r.id)
    expect(ids).toHaveLength(10)
    expect(new Set(ids).size).toBe(10)
    expect(ids).not.toContain(viewer)
  })

  it("backfills the pair from existing events and never moves it backwards on a re-run", async () => {
    const organizer = await newUser("Organizer")
    const created = await seedOrganizedEvent(organizer, LA)

    const first = await backfillUserActivity(h.sql, { batchSize: 5, log: () => undefined })
    expect(first.filled).toBeGreaterThanOrEqual(1)
    const [row] = await h.sql<{ at: Date | null; lng: number | null }[]>`
      SELECT last_activity_at AS at, ST_X(last_activity_geom) AS lng
      FROM users WHERE id = ${organizer}
    `
    expect(row!.at?.toISOString()).toBe(created.toISOString())
    expect(row!.lng).toBeCloseTo(LA.lng, 5)

    // A newer live write wins, and re-running the backfill must not drag the pair back to the event.
    const newer = new Date(created.getTime() + 60_000)
    await touchUserActivity(h.sql, { userId: organizer, ...NY, at: newer })
    const second = await backfillUserActivity(h.sql, { batchSize: 5, log: () => undefined })
    expect(second.scanned).toBeGreaterThan(0)
    const [after] = await h.sql<{ at: Date | null; lng: number | null }[]>`
      SELECT last_activity_at AS at, ST_X(last_activity_geom) AS lng
      FROM users WHERE id = ${organizer}
    `
    expect(after!.at?.toISOString()).toBe(newer.toISOString())
    expect(after!.lng).toBeCloseTo(NY.lng, 5)
  })

  async function seedOrganizedEvent(
    organizerId: string,
    at: { lat: number; lng: number },
  ): Promise<Date> {
    const [row] = await h.sql<{ created_at: Date }[]>`
      INSERT INTO cleanups (organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (
        ${organizerId}, 'site', 'Sweep',
        ST_SetSRID(ST_MakePoint(${at.lng}, ${at.lat}), 4326),
        now(), 'upcoming'
      )
      RETURNING created_at
    `
    return row!.created_at
  }
})
