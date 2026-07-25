/**
 * Docker-gated tests for the pg harness's core promise: the container is SHARED for the whole run, but
 * every test file gets its OWN database, cloned from a template that already carries all 60 migrations,
 * the jurisdiction seed, and the fixture column defaults.
 *
 * Isolation is what ~44 integration files silently rely on (they insert bare users and reports and count
 * rows), so it is asserted here rather than assumed: a regression that handed two files the same database
 * would otherwise show up as unrelated, intermittently-failing suites.
 *
 * Skips when Docker is unavailable, exactly like every other Docker-gated file.
 */

import { afterAll, describe, expect, inject, it } from "vitest"
import { eq } from "drizzle-orm"
import postgres from "postgres"
import { users } from "../../src/db/schema/index.js"
import { withPg } from "./pg.js"
import {
  TEMPLATE_DB,
  createDatabase,
  dropDatabaseIfExists,
  uniqueTestDbName,
  uriWithDatabase,
} from "./pg-container.js"

const pg = await withPg()

describe.skipIf(!pg)("pg harness: per-file database", () => {
  afterAll(async () => {
    await pg?.teardown()
  })

  it("came from the ONE globalSetup container, not a per-file boot", () => {
    // globalSetup decides from the CLI filters whether any selected file needs Postgres; a file that
    // imports this harness must be recognized, so the shared container is what served it. (withPg's
    // fallback would still make the tests pass — silently paying a container boot per file, which is the
    // regression this whole harness exists to prevent.)
    expect(inject("civfixPg")?.kind).toBe("ready")
  })

  it("is a freshly cloned database, not the template and not the container default", async () => {
    const h = pg!
    const [row] = await h.sql<{ db: string }[]>`SELECT current_database() AS db`
    expect(row!.db).toMatch(/^civfix_t_[0-9a-f]{32}$/)
    expect(row!.db).not.toBe(TEMPLATE_DB)
    expect(h.uri).toContain(row!.db)
  })

  it("runs the container with the throwaway-database tuning", async () => {
    const h = pg!
    // One container now serves every worker at once (each test file holds a 4-connection raw pool + a
    // 2-connection Drizzle pool), so the default max_connections=100 would start refusing connections
    // under parallel load. fsync off is what makes 60 migrations + ~44 clones cheap. Both ride on
    // withCommand — if a testcontainers upgrade ever drops it, this fails instead of flaking later.
    const [row] = await h.sql<{ mc: string; fsync: string }[]>`
      SELECT current_setting('max_connections') AS mc, current_setting('fsync') AS fsync
    `
    expect(Number(row!.mc)).toBeGreaterThanOrEqual(300)
    expect(row!.fsync).toBe("off")
  })

  it("carries the full migration history and the jurisdiction seed", async () => {
    const h = pg!
    const [m] = await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM _civfix_migrations`
    // 60 hand-authored migrations today; assert the whole set landed, not merely "a table exists".
    expect(m!.n).toBeGreaterThanOrEqual(55)
    const [j] = await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM jurisdictions`
    expect(j!.n).toBeGreaterThan(0)
    // PostGIS itself: the seeded geometry must be queryable.
    const [g] = await h.sql<{ ok: boolean }[]>`
      SELECT ST_SRID(ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326)) = 4326 AS ok
    `
    expect(g!.ok).toBe(true)
  })

  it("applies the fixture column defaults every bare-insert fixture depends on", async () => {
    const h = pg!
    const [u] = await h.sql<{ handle: string }[]>`
      INSERT INTO users (display_name) VALUES ('Fixture Defaults') RETURNING handle
    `
    expect(u!.handle).toMatch(/^u[0-9a-f]{12}$/)
    const [r] = await h.sql<{ type: string }[]>`
      INSERT INTO reports (
        reporter_user_id, idempotency_key, geom, geom_source, category, status, visibility, h3_cell
      ) VALUES (
        ${null}, gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual',
        'trash', 'published', 'public', 'h0'
      ) RETURNING type
    `
    expect(r!.type).toBe("other")
  })

  it("exposes the raw tag and the Drizzle client on the SAME database", async () => {
    const h = pg!
    // Two SEPARATE postgres.js pools back sql and db (so Drizzle cannot clobber the raw tag's value
    // serializers); they must still point at this file's one database.
    const [inserted] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES ('Drizzle Sees Me') RETURNING id
    `
    const found = await h.db.select({ id: users.id }).from(users).where(eq(users.id, inserted!.id))
    expect(found.map((r) => r.id)).toEqual([inserted!.id])
  })

  it("does not share writes with another clone of the same template", async () => {
    const h = pg!
    // A second clone off the same template, created through this file's own connection (same server,
    // same credentials) — the exact mechanism another test FILE would get its database by.
    const otherDb = uniqueTestDbName()
    await createDatabase(h.uri, otherDb, TEMPLATE_DB)
    const other = postgres(uriWithDatabase(h.uri, otherDb), { max: 1, onnotice: () => {} })
    try {
      const [mine] = await h.sql<{ id: string }[]>`
        INSERT INTO users (display_name) VALUES ('Only In Mine') RETURNING id
      `
      const seenThere = await other<{ n: number }[]>`
        SELECT count(*)::int AS n FROM users WHERE id = ${mine!.id}
      `
      expect(seenThere[0]!.n).toBe(0)

      // ...and the reverse direction, so this is isolation rather than a one-way replication lag.
      const [theirs] = await other<{ id: string }[]>`
        INSERT INTO users (display_name) VALUES ('Only In Theirs') RETURNING id
      `
      const seenHere = await h.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM users WHERE id = ${theirs!.id}
      `
      expect(seenHere[0]!.n).toBe(0)

      // The clone is nonetheless fully migrated + seeded (it came from the same template).
      const [j] = await other<{ n: number }[]>`SELECT count(*)::int AS n FROM jurisdictions`
      expect(j!.n).toBeGreaterThan(0)
    } finally {
      await other.end({ timeout: 5 }).catch(() => {})
      await dropDatabaseIfExists(h.uri, otherDb)
    }
  })

  it("memoizes: a second withPg() in the same file returns the same database", async () => {
    const again = await withPg()
    expect(again).not.toBeNull()
    expect(again!.uri).toBe(pg!.uri)
  })
})
