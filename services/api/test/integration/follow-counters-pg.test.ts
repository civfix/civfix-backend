/**
 * drizzle/0059_users_follow_counters.sql: the BACKFILL branch, against a real database.
 *
 * The migration adds users.follower_count / following_count and backfills them from follows_people. Every
 * other test in the suite gets its database from the template, where 0059 was applied to an EMPTY
 * follows_people, so the backfill UPDATE rewrote zero rows and the only branch that matters in
 * production (a live database full of existing edges -> correct counters) had no coverage at all. The
 * write path (addFollow/removeFollow moving the counters) is covered in social-notifications-pg.test.ts;
 * this file covers the one-time convergence, the re-apply guard, and the documented tombstone semantics.
 *
 * The statement under test is READ OUT OF THE MIGRATION FILE rather than retyped, so this cannot pass
 * against a copy that has drifted from the SQL the production runner applies. It is executed here against
 * a template-cloned database in which 0059's DDL is already in place, which is exactly the shape of the
 * "re-apply after the columns exist" case the operator runbook documents.
 */

import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seedFollowEdge, testHandle, withPg, type PgHarness } from "../helpers/pg.js"

const pg = await withPg()

const MIGRATION = fileURLToPath(
  new URL("../../drizzle/0059_users_follow_counters.sql", import.meta.url),
)

/**
 * The backfill statement, sliced out of the canonical migration: everything from the leading CTE to the
 * end of the file. The two ADD COLUMNs before it are already applied in the template, and re-running them
 * is not what this file is about.
 */
async function backfillStatement(): Promise<string> {
  const sql = await readFile(MIGRATION, "utf8")
  const start = sql.indexOf("WITH followers_agg")
  // Fail loudly rather than silently testing nothing if the migration is ever restructured.
  expect(start).toBeGreaterThan(0)
  expect(sql.split("WITH followers_agg")).toHaveLength(2)
  const stmt = sql.slice(start).trim()
  expect(stmt).toContain("UPDATE users")
  expect(stmt.endsWith(";")).toBe(true)
  return stmt
}

describe.skipIf(!pg)("0059 follow-counter backfill (integration)", () => {
  let h: PgHarness
  let backfill: string

  beforeAll(async () => {
    h = pg as PgHarness
    backfill = await backfillStatement()
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

  /** A raw edge, with NO counter maintenance: what a psql session or a bulk import leaves behind. */
  async function rawEdge(followerId: string, followeeId: string): Promise<void> {
    await h.sql`
      INSERT INTO follows_people (follower_id, followee_id) VALUES (${followerId}, ${followeeId})
    `
  }

  async function counters(id: string): Promise<{ followers: number; following: number }> {
    const [row] = await h.sql<{ followers: number; following: number }[]>`
      SELECT follower_count AS followers, following_count AS following FROM users WHERE id = ${id}
    `
    return row!
  }

  /** Run the migration's own statement; returns the number of user rows it rewrote. */
  async function runBackfill(): Promise<number> {
    const res = await h.sql.unsafe(backfill)
    return res.count
  }

  /**
   * Every user whose stored counters disagree with a live count over follows_people: the drift detector
   * from the operator runbook. Empty is the invariant the backfill exists to establish.
   */
  async function drift(): Promise<Array<{ id: string }>> {
    return await h.sql<{ id: string }[]>`
      SELECT u.id
        FROM users u
       WHERE u.follower_count <> (SELECT count(*) FROM follows_people f WHERE f.followee_id = u.id)
          OR u.following_count <> (SELECT count(*) FROM follows_people f WHERE f.follower_id = u.id)
    `
  }

  it("converges BOTH counters onto count(*) for edges that predate the columns", async () => {
    const alice = await newUser("Backfill Alice")
    const bob = await newUser("Backfill Bob")
    const carol = await newUser("Backfill Carol")
    const loner = await newUser("Backfill Loner")

    // alice and carol follow bob; bob follows carol. Raw inserts, i.e. counters untouched.
    await rawEdge(alice, bob)
    await rawEdge(carol, bob)
    await rawEdge(bob, carol)

    // The trap this migration documents: the edges exist and every counter still reads 0.
    expect(await counters(bob)).toEqual({ followers: 0, following: 0 })
    expect(await drift()).not.toHaveLength(0)

    // EXACTLY the three users with edges: the WHERE guard skips `loner`, whose 0/0 already agrees with
    // the aggregate. That is what keeps a re-apply (and this apply, on a mostly-followless users table)
    // off every row; see the guard's rationale in the migration.
    expect(await runBackfill()).toBe(3)

    expect(await counters(bob)).toEqual({ followers: 2, following: 1 })
    expect(await counters(alice)).toEqual({ followers: 0, following: 1 })
    expect(await counters(carol)).toEqual({ followers: 1, following: 1 })
    // A user with no edges is left at the column default rather than nulled out.
    expect(await counters(loner)).toEqual({ followers: 0, following: 0 })
    expect(await drift()).toEqual([])
  })

  it("is idempotent: a re-apply rewrites ZERO rows (the WHERE guard)", async () => {
    const a = await newUser("Idem A")
    const b = await newUser("Idem B")
    await rawEdge(a, b)

    // First run fixes this file's drift (its own two rows, plus anything an earlier test left).
    expect(await runBackfill()).toBeGreaterThanOrEqual(2)
    // Second run must touch nothing; this is what keeps a re-apply off the whole users table.
    expect(await runBackfill()).toBe(0)
    expect(await counters(b)).toEqual({ followers: 1, following: 0 })
  })

  it("repairs drift in the OTHER direction too (counters ahead of the edges)", async () => {
    const a = await newUser("Drift A")
    const b = await newUser("Drift B")
    await rawEdge(a, b)
    // A stale over-count is the failure mode the runbook's detector exists for (a fixture or bulk import
    // that bumped counters without inserting, or an edge deleted out of band).
    await h.sql`UPDATE users SET follower_count = 999, following_count = 7 WHERE id IN (${a}, ${b})`

    expect(await runBackfill()).toBeGreaterThanOrEqual(2)
    expect(await counters(a)).toEqual({ followers: 0, following: 1 })
    expect(await counters(b)).toEqual({ followers: 1, following: 0 })
    expect(await drift()).toEqual([])
  })

  it("COUNTS edges to and from soft-deleted users, exactly as the aggregates it replaced did", async () => {
    const ghost = await newUser("Ghost Follower")
    const target = await newUser("Ghost Target")
    const ghostee = await newUser("Ghost Followee")
    await rawEdge(ghost, target)
    await rawEdge(target, ghostee)
    // Account deletion is a tombstone that leaves follows_people untouched (see 0059's SEMANTICS note),
    // so a follower_count may legitimately exceed the length of the visible followers roster.
    await h.sql`UPDATE users SET deleted_at = now() WHERE id IN (${ghost}, ${ghostee})`

    await runBackfill()

    expect(await counters(target)).toEqual({ followers: 1, following: 1 })
    expect(await drift()).toEqual([])
  })

  it("seedFollowEdge (the fixture helper) leaves the database ALREADY converged", async () => {
    // Converge first, so the assertion below is about the helper and not about earlier fixtures.
    await runBackfill()

    const a = await newUser("Helper A")
    const b = await newUser("Helper B")
    expect(await seedFollowEdge(h.sql, a, b)).toBe(true)

    expect(await counters(a)).toEqual({ followers: 0, following: 1 })
    expect(await counters(b)).toEqual({ followers: 1, following: 0 })
    // The canonical backfill finds nothing to fix: the property a raw INSERT fixture does not have.
    expect(await runBackfill()).toBe(0)

    // Re-seeding the same edge is a no-op, not a double count (mirrors addFollow's ON CONFLICT gate).
    expect(await seedFollowEdge(h.sql, a, b)).toBe(false)
    expect(await counters(b)).toEqual({ followers: 1, following: 0 })
    expect(await drift()).toEqual([])
  })

  it("seedFollowEdge honours an explicit created_at (fixtures that window on edge age)", async () => {
    const a = await newUser("Aged A")
    const b = await newUser("Aged B")
    const when = new Date("2025-03-04T05:06:07.000Z")
    expect(await seedFollowEdge(h.sql, a, b, when)).toBe(true)

    const [edge] = await h.sql<{ created_at: Date }[]>`
      SELECT created_at FROM follows_people WHERE follower_id = ${a} AND followee_id = ${b}
    `
    expect(edge!.created_at.toISOString()).toBe(when.toISOString())
    // Default path still lands on server time rather than a null/epoch.
    const c = await newUser("Aged C")
    await seedFollowEdge(h.sql, a, c)
    const [now] = await h.sql<{ created_at: Date }[]>`
      SELECT created_at FROM follows_people WHERE follower_id = ${a} AND followee_id = ${c}
    `
    expect(now!.created_at.getTime()).toBeGreaterThan(when.getTime())
    expect(await counters(a)).toEqual({ followers: 0, following: 2 })
  })
})
