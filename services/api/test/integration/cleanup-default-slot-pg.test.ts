/**
 * 0169_default_event_slot.sql against a live PostGIS container (Docker-gated).
 *
 * The template database this harness clones has already applied the whole chain, so the file under test
 * has already run once against an EMPTY events table — which proves nothing. This file therefore seeds
 * the legacy shapes the backfill exists for and then re-executes the migration's own text (read off
 * disk, run through `sql.unsafe` exactly as src/db/migrate.ts does), which is the only way to observe
 * what it writes:
 *
 *   - an OPEN slot-less event gains exactly one 'General volunteers' slot, untimed, carrying the event's
 *     capacity, and one claim per existing cleanup_members row;
 *   - an ENDED slot-less event gains NOTHING — its roster is what credited hours were attested against,
 *     and cleanup-service already refuses every slot edit on it (a cancelled event is skipped for the
 *     same reason, plus the obvious one);
 *   - an open event that ALREADY has a board is untouched: no extra slot, and no claim conjured onto a
 *     host's own slot;
 *   - running the file a second time inserts nothing at all, which is what makes it safe to leave in the
 *     chain forever.
 *
 * When Docker is unavailable the whole block SKIPS so the local suite stays green; CI runs it for real.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { withPg, type PgHarness } from "../helpers/pg.js"

const pg = await withPg()

const MIGRATION_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "drizzle",
  "0169_default_event_slot.sql",
)

describe.skipIf(!pg)("0169 default event slot backfill (integration)", () => {
  let h: PgHarness
  let migration: string

  const HOUR = 60 * 60 * 1000

  beforeAll(async () => {
    h = pg as PgHarness
    migration = await readFile(MIGRATION_FILE, "utf8")
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id
    `
    return u!.id
  }

  async function newCleanup(
    organizerId: string,
    over: { status?: string; startsAt?: Date; endsAt?: Date; capacity?: number | null } = {},
  ): Promise<string> {
    const id = randomUUID()
    const startsAt = over.startsAt ?? new Date(Date.now() + 7 * 86_400_000)
    const endsAt = over.endsAt ?? new Date(startsAt.getTime() + 4 * HOUR)
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, ends_at, status, capacity)
      VALUES (
        ${id}, ${organizerId}, 'site', 'Backfill sweep',
        ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326),
        ${startsAt}, ${endsAt}, ${over.status ?? "upcoming"},
        ${over.capacity ?? null}
      )
    `
    await h.sql`
      INSERT INTO cleanup_members (cleanup_id, user_id, role)
      VALUES (${id}, ${organizerId}, 'organizer')
      ON CONFLICT DO NOTHING
    `
    return id
  }

  async function addMember(cleanupId: string, userId: string): Promise<void> {
    await h.sql`
      INSERT INTO cleanup_members (cleanup_id, user_id, role)
      VALUES (${cleanupId}, ${userId}, 'member')
      ON CONFLICT DO NOTHING
    `
  }

  async function boardOf(
    cleanupId: string,
  ): Promise<{ title: string; capacity: number | null; startsAt: Date | null; endsAt: Date | null }[]> {
    const rows = await h.sql<
      { title: string; capacity: number | null; starts_at: Date | null; ends_at: Date | null }[]
    >`
      SELECT title, capacity, starts_at, ends_at
      FROM cleanup_slots WHERE cleanup_id = ${cleanupId}
      ORDER BY sort_order, title
    `
    return rows.map((r) => ({
      title: r.title,
      capacity: r.capacity,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
    }))
  }

  async function claimantsOf(cleanupId: string): Promise<string[]> {
    const rows = await h.sql<{ user_id: string }[]>`
      SELECT user_id FROM cleanup_slot_claims WHERE cleanup_id = ${cleanupId} ORDER BY user_id
    `
    return rows.map((r) => r.user_id)
  }

  async function runMigration(): Promise<void> {
    await h.sql.unsafe(migration)
  }

  it("gives an OPEN slot-less event one 'General volunteers' slot and a claim per member", async () => {
    const organizer = await newUser("Olive Organizer")
    const member = await newUser("Mel Member")
    const id = await newCleanup(organizer, { capacity: 30 })
    await addMember(id, member)

    expect(await boardOf(id)).toEqual([])
    await runMigration()

    expect(await boardOf(id)).toEqual([
      { title: "General volunteers", capacity: 30, startsAt: null, endsAt: null },
    ])
    expect(await claimantsOf(id)).toEqual([organizer, member].sort())
  })

  it("skips an ENDED slot-less event and a CANCELLED one (their rosters are frozen)", async () => {
    const organizer = await newUser("Olive Organizer")
    const member = await newUser("Mel Member")
    const startsAt = new Date(Date.now() - 8 * HOUR)
    const ended = await newCleanup(organizer, { startsAt, endsAt: new Date(startsAt.getTime() + 4 * HOUR) })
    const cancelled = await newCleanup(organizer, { status: "cancelled" })
    await addMember(ended, member)
    await addMember(cancelled, member)

    await runMigration()

    expect(await boardOf(ended)).toEqual([])
    expect(await claimantsOf(ended)).toEqual([])
    expect(await boardOf(cancelled)).toEqual([])
    expect(await claimantsOf(cancelled)).toEqual([])
  })

  it("leaves an open event that already has a board alone — no extra slot, no conjured claim", async () => {
    const organizer = await newUser("Olive Organizer")
    const member = await newUser("Mel Member")
    const id = await newCleanup(organizer)
    await addMember(id, member)
    await h.sql`
      INSERT INTO cleanup_slots (cleanup_id, title, sort_order) VALUES (${id}, 'Grill', 0)
    `

    await runMigration()

    expect((await boardOf(id)).map((s) => s.title)).toEqual(["Grill"])
    expect(await claimantsOf(id)).toEqual([])
  })

  it("is idempotent: a second run inserts no slot and no claim", async () => {
    const organizer = await newUser("Olive Organizer")
    const member = await newUser("Mel Member")
    const id = await newCleanup(organizer)
    await addMember(id, member)

    await runMigration()
    const boardAfterFirst = await boardOf(id)
    const claimsAfterFirst = await claimantsOf(id)
    const [before] = await h.sql<{ slots: number; claims: number }[]>`
      SELECT (SELECT count(*)::int FROM cleanup_slots) AS slots,
             (SELECT count(*)::int FROM cleanup_slot_claims) AS claims
    `

    await runMigration()

    const [after] = await h.sql<{ slots: number; claims: number }[]>`
      SELECT (SELECT count(*)::int FROM cleanup_slots) AS slots,
             (SELECT count(*)::int FROM cleanup_slot_claims) AS claims
    `
    expect(after).toEqual(before)
    expect(await boardOf(id)).toEqual(boardAfterFirst)
    expect(await claimantsOf(id)).toEqual(claimsAfterFirst)
  })
})
