/**
 * drizzle/0065_void_report_volunteer_hours.sql, against a real database.
 *
 * Filing a report is not volunteer service, so the report auto-award was removed AND every credit it ever
 * wrote is voided. Every other test in the suite gets its database from the template, where 0065 was
 * applied to EMPTY tables — so the branch that matters in production (a live ledger full of report rows
 * and a rollup inflated by them) had no coverage at all. This file covers the void, the rollup RECOMPUTE
 * (which is authoritative: it overwrites total_hours wholesale), what it must NOT touch, and the re-apply
 * guarantee the migration's banner makes.
 *
 * The SQL is READ OUT OF THE MIGRATION FILE rather than retyped, so this cannot pass against a copy that
 * has drifted from what the production runner applies. It runs against a template-cloned database where
 * 0065 has already been applied once, which is exactly the "safe to re-apply" case.
 */

import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const GEOID = LA_CITY.geoid

const pg = await withPg()

const MIGRATION = fileURLToPath(
  new URL("../../drizzle/0065_void_report_volunteer_hours.sql", import.meta.url),
)

describe.skipIf(!pg)("0065 report-hours void (integration)", () => {
  let h: PgHarness
  let migration: string

  beforeAll(async () => {
    h = pg as PgHarness
    migration = await readFile(MIGRATION, "utf8")
    // Fail loudly rather than silently testing nothing if the migration is ever restructured.
    expect(migration).toContain("UPDATE volunteer_hours")
    expect(migration).toContain("UPDATE user_jurisdiction_hours")
  })

  afterAll(async () => {
    await h.teardown()
  })

  /** Apply the migration exactly as the runner does: the whole file, one `unsafe` call, no parameters. */
  async function applyMigration(): Promise<void> {
    await h.sql.unsafe(migration)
  }

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id
    `
    return u!.id
  }

  /** A done cleanup, so an event credit has a real row to hang off. */
  async function newCleanup(organizerId: string): Promise<string> {
    const id = randomUUID()
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, status, jurisdiction_geoid)
      VALUES (
        ${id}, ${organizerId}, 'site', 'Void sweep',
        ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326),
        now() - interval '1 day', 'done', ${GEOID}
      )
    `
    return id
  }

  /** A published report row, so a report-source credit satisfies its FK. */
  async function newReport(reporterId: string): Promise<string> {
    const [r] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (
        reporter_user_id, idempotency_key, geom, geom_source, category, status, visibility,
        h3_cell, jurisdiction_geoid
      )
      VALUES (
        ${reporterId}, ${randomUUID()},
        ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326), 'device',
        'trash', 'published', 'public',
        '8a2a1072b59ffff', ${GEOID}
      )
      RETURNING id
    `
    return r!.id
  }

  /** The pre-0065 report auto-award: a ledger row plus its contribution to the public rollup. */
  async function seedReportCredit(userId: string, note: string | null = null): Promise<string> {
    const reportId = await newReport(userId)
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO volunteer_hours (user_id, hours, source, report_id, jurisdiction_geoid, note)
      VALUES (${userId}, 0.1, 'report', ${reportId}, ${GEOID}, ${note})
      RETURNING id
    `
    await addRollup(userId, 0.1)
    return row!.id
  }

  async function seedEventCredit(userId: string, hours: number, host: string): Promise<string> {
    const cleanupId = await newCleanup(host)
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO volunteer_hours (user_id, hours, source, cleanup_id, jurisdiction_geoid, logged_by_user_id)
      VALUES (${userId}, ${hours}, 'event', ${cleanupId}, ${GEOID}, ${host})
      RETURNING id
    `
    await addRollup(userId, hours)
    return row!.id
  }

  async function addRollup(userId: string, hours: number): Promise<void> {
    await h.sql`
      INSERT INTO user_jurisdiction_hours (user_id, jurisdiction_geoid, total_hours)
      VALUES (${userId}, ${GEOID}, ${hours})
      ON CONFLICT (user_id, jurisdiction_geoid)
      DO UPDATE SET total_hours = user_jurisdiction_hours.total_hours + EXCLUDED.total_hours
    `
  }

  async function rollupFor(userId: string): Promise<number> {
    const rows = await h.sql<{ total: number }[]>`
      SELECT total_hours::float8 AS total FROM user_jurisdiction_hours
      WHERE user_id = ${userId} AND jurisdiction_geoid = ${GEOID}
    `
    return rows[0]?.total ?? 0
  }

  async function ledgerRow(
    id: string,
  ): Promise<{ voided_at: Date | null; note: string | null; hours: number }> {
    const [row] = await h.sql<{ voided_at: Date | null; note: string | null; hours: number }[]>`
      SELECT voided_at, note, hours::float8 AS hours FROM volunteer_hours WHERE id = ${id}
    `
    return row!
  }

  /**
   * The invariant the recompute establishes, platform-wide: every rollup total equals the SUM of that
   * (user, jurisdiction)'s non-voided ledger rows. Empty is what this migration exists to guarantee.
   */
  async function drift(): Promise<{ user_id: string }[]> {
    return await h.sql<{ user_id: string }[]>`
      SELECT ujh.user_id
      FROM user_jurisdiction_hours ujh
      WHERE ujh.total_hours <> COALESCE((
        SELECT SUM(vh.hours) FROM volunteer_hours vh
        WHERE vh.user_id = ujh.user_id
          AND vh.jurisdiction_geoid = ujh.jurisdiction_geoid
          AND vh.voided_at IS NULL
      ), 0)
    `
  }

  it("voids every report credit, leaves event credits alone, and recomputes the rollup", async () => {
    const host = await newUser("Void Host")
    // Mixed: an event credit that must survive, plus a report credit that must not.
    const alice = await newUser("Void Alice")
    const aliceEvent = await seedEventCredit(alice, 3, host)
    const aliceReport = await seedReportCredit(alice)
    // Report-only, i.e. most of the platform: their public total goes to 0.
    const bob = await newUser("Void Bob")
    const bobReport = await seedReportCredit(bob)
    // Event-only control: nothing about this user may move.
    const carol = await newUser("Void Carol")
    await seedEventCredit(carol, 2, host)

    expect(await rollupFor(alice)).toBe(3.1)
    expect(await rollupFor(bob)).toBeCloseTo(0.1, 5)

    await applyMigration()

    // The report rows are void, and carry the explanatory note.
    for (const id of [aliceReport, bobReport]) {
      const row = await ledgerRow(id)
      expect(row.voided_at).not.toBeNull()
      expect(row.note).toContain("filing a report is not volunteer service")
      // `hours numeric(6,2) CHECK (hours > 0)` forbids zeroing, which is why voided_at is the remedy.
      expect(row.hours).toBeCloseTo(0.1, 5)
    }

    // The event credit is untouched — this is the hours a host logged for time actually served.
    const kept = await ledgerRow(aliceEvent)
    expect(kept.voided_at).toBeNull()
    expect(kept.note).toBeNull()

    // The rollup is rebuilt from the surviving ledger, NOT decremented.
    expect(await rollupFor(alice)).toBe(3)
    expect(await rollupFor(bob)).toBe(0)
    expect(await rollupFor(carol)).toBe(2)

    // A zeroed row is LEFT IN PLACE (every read filters total_hours > 0, and deleting would race the
    // event upsert's ON CONFLICT target).
    const [bobRollup] = await h.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM user_jurisdiction_hours WHERE user_id = ${bob}
    `
    expect(bobRollup!.count).toBe(1)

    expect(await drift()).toEqual([])
  })

  it("is safe to re-apply: the void is not re-stamped and an existing note is never overwritten", async () => {
    const host = await newUser("Rerun Host")
    const dave = await newUser("Rerun Dave")
    await seedEventCredit(dave, 1.5, host)
    // A row an operator had already annotated: COALESCE must leave their note alone.
    const annotated = await seedReportCredit(dave, "operator: spam filing")

    await applyMigration()
    const first = await ledgerRow(annotated)
    expect(first.voided_at).not.toBeNull()
    expect(first.note).toBe("operator: spam filing")
    expect(await rollupFor(dave)).toBe(1.5)

    await applyMigration()
    const second = await ledgerRow(annotated)
    // Statement 1 matches nothing the second time (`voided_at IS NULL`), so the timestamp is stable...
    expect(second.voided_at?.getTime()).toBe(first.voided_at?.getTime())
    expect(second.note).toBe("operator: spam filing")
    // ...and statement 2 is a pure recompute, so a replay converges on the same number.
    expect(await rollupFor(dave)).toBe(1.5)
    expect(await drift()).toEqual([])
  })

  /**
   * The recompute is AUTHORITATIVE: a rollup value with no backing non-voided ledger row is erased. That
   * is only safe because logEventHours is the sole remaining writer of either table (there is no
   * source='manual' writer anywhere, and no script or worker touches them). Pinned here so the day
   * somebody adds a second writer, this fails and they have to think about it.
   */
  it("erases a rollup value that has no backing ledger row", async () => {
    const orphan = await newUser("Rollup Orphan")
    await addRollup(orphan, 12)
    expect(await rollupFor(orphan)).toBe(12)

    await applyMigration()

    expect(await rollupFor(orphan)).toBe(0)
    expect(await drift()).toEqual([])
  })
})
