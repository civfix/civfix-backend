import { describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { PgUserStore } from "../../src/auth/pg-stores.js"

/**
 * Account-deletion content cascade (Docker-gated). `PgUserStore.softDeleteAndAnonymize` must, in ONE
 * transaction, tombstone the user AND UNLIST (never delete) the content they authored:
 *   - their public reports flip visibility 'public' -> 'hidden' (off the map / search / public detail);
 *   - their still-active events ('upcoming' | 'active') flip status -> 'cancelled' (off the map + lists);
 * while another user's content, the victim's PAST ('done') events, and anon reports are left untouched.
 * Reports are never hard-deleted (a report is already forwarded to the city). Skips when Docker is
 * unavailable so the local suite stays green; CI runs it.
 */

const pg = await withPg()

async function insertUser(h: PgHarness, name: string): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO users (display_name) VALUES (${name}) RETURNING id
  `
  return rows[0]!.id
}

async function insertReport(
  h: PgHarness,
  opts: { reporterId: string | null; visibility?: string; status?: string },
): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO reports (
      reporter_user_id, idempotency_key, geom, geom_source, category, status, visibility, h3_cell,
      jurisdiction_geoid, created_at, published_at
    )
    VALUES (
      ${opts.reporterId},
      gen_random_uuid(),
      ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326),
      'manual',
      'trash',
      ${opts.status ?? "published"},
      ${opts.visibility ?? "public"},
      'h0',
      ${null},
      ${new Date()},
      ${null}
    )
    RETURNING id
  `
  return rows[0]!.id
}

async function insertCleanup(
  h: PgHarness,
  opts: { organizerId: string; status?: string },
): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO cleanups (organizer_user_id, type, title, geom, scheduled_at, status)
    VALUES (
      ${opts.organizerId},
      'site',
      'Cleanup',
      ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326),
      ${new Date()},
      ${opts.status ?? "upcoming"}
    )
    RETURNING id
  `
  return rows[0]!.id
}

describe.skipIf(!pg)("account deletion content cascade (PgUserStore.softDeleteAndAnonymize)", () => {
  it("unlists the deleted user's public reports + active events, sparing others and past events", async () => {
    const h = pg!
    const victim = await insertUser(h, "Victim")
    const bystander = await insertUser(h, "Bystander")

    const victimReport = await insertReport(h, { reporterId: victim, visibility: "public" })
    const bystanderReport = await insertReport(h, { reporterId: bystander, visibility: "public" })
    const anonReport = await insertReport(h, { reporterId: null, visibility: "public" })
    const upcoming = await insertCleanup(h, { organizerId: victim, status: "upcoming" })
    const active = await insertCleanup(h, { organizerId: victim, status: "active" })
    const past = await insertCleanup(h, { organizerId: victim, status: "done" })
    const bystanderEvent = await insertCleanup(h, { organizerId: bystander, status: "upcoming" })

    await new PgUserStore(h.db).softDeleteAndAnonymize(victim)

    const reportVis = async (id: string) =>
      (await h.sql<{ visibility: string }[]>`SELECT visibility FROM reports WHERE id = ${id}`)[0]!.visibility
    const cleanupStatus = async (id: string) =>
      (await h.sql<{ status: string }[]>`SELECT status FROM cleanups WHERE id = ${id}`)[0]!.status

    // Victim's content is unlisted (but retained)...
    expect(await reportVis(victimReport)).toBe("hidden")
    expect(await cleanupStatus(upcoming)).toBe("cancelled")
    expect(await cleanupStatus(active)).toBe("cancelled")
    // ...the victim's PAST event keeps its history; others + anon reports are untouched.
    expect(await cleanupStatus(past)).toBe("done")
    expect(await reportVis(bystanderReport)).toBe("public")
    expect(await reportVis(anonReport)).toBe("public")
    expect(await cleanupStatus(bystanderEvent)).toBe("upcoming")

    // The user row survives, tombstoned (kept for admin truth / "Deleted User" projection).
    const rows = await h.sql<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM users WHERE id = ${victim}
    `
    expect(rows[0]!.deleted_at).not.toBeNull()
  })
})
