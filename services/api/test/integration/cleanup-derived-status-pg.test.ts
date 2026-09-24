/**
 * Derived event status against a live PostGIS container (Docker-gated).
 *
 * The unit suite runs the TS twin (`deriveCleanupStatus`) through the in-memory repository; this file
 * runs the SQL half (`cleanupStatusExpr` and the `ends_at`-based filters) against a real database,
 * because a divergence between the two is invisible to CI otherwise. The four things only a real
 * database can show:
 *
 *   - 0168's NOT NULL: an insert without `ends_at` is rejected outright, so no row can ever reach the
 *     derivation without a right edge;
 *   - a row whose stored status is still the legacy 'upcoming' but whose `ends_at` has passed reads back
 *     as 'done': the projection, not the column, is what a DTO carries;
 *   - `cancelCleanupTx` refuses a past event with "already_ended" and writes NOTHING (the guard
 *     `status <> 'cancelled' AND ends_at > now()` is what keeps cancel from rewriting history);
 *   - the `when=upcoming` list filter keeps an UNDERWAY event and drops an ended one.
 *
 * When Docker is unavailable the whole block SKIPS so the local suite stays green; CI runs it for real.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import type { CleanupRepository } from "../../src/services/cleanup-repository.js"

const pg = await withPg()

describe.skipIf(!pg)("derived event status (integration)", () => {
  let h: PgHarness
  let repo: CleanupRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleCleanupRepository(h.sql)
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

  const HOUR = 60 * 60 * 1000

  async function newCleanup(
    organizerId: string,
    over: { status?: string; startsAt?: Date; endsAt?: Date } = {},
  ): Promise<string> {
    const id = randomUUID()
    const startsAt = over.startsAt ?? new Date(Date.now() + 7 * 86_400_000)
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, ends_at, status)
      VALUES (
        ${id}, ${organizerId}, 'site', 'Derivation sweep',
        ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326),
        ${startsAt}, ${over.endsAt ?? new Date(startsAt.getTime() + 4 * HOUR)},
        ${over.status ?? "upcoming"}
      )
    `
    return id
  }

  it("rejects a cleanup insert with no ends_at", async () => {
    const org = await newUser("Null Ends Org")
    await expect(
      h.sql`
        INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, status)
        VALUES (
          ${randomUUID()}, ${org}, 'site', 'No end',
          ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326),
          ${new Date()}, 'upcoming'
        )
      `,
    ).rejects.toMatchObject({ code: "23502" })
  })

  it("projects done for a past window whose stored status is still upcoming", async () => {
    const org = await newUser("Past Org")
    const id = await newCleanup(org, {
      startsAt: new Date(Date.now() - 8 * HOUR),
      endsAt: new Date(Date.now() - 4 * HOUR),
    })

    const [stored] = await h.sql<{ status: string }[]>`
      SELECT status FROM cleanups WHERE id = ${id}
    `
    expect(stored!.status).toBe("upcoming")
    expect((await repo.findCleanupById(id, null))?.status).toBe("done")
  })

  it("projects active while the event is underway", async () => {
    const org = await newUser("Underway Org")
    const id = await newCleanup(org, {
      startsAt: new Date(Date.now() - HOUR),
      endsAt: new Date(Date.now() + 3 * HOUR),
    })
    expect((await repo.findCleanupById(id, null))?.status).toBe("active")
  })

  it("refuses to cancel a past event and writes nothing", async () => {
    const org = await newUser("Late Cancel Org")
    const id = await newCleanup(org, {
      startsAt: new Date(Date.now() - 8 * HOUR),
      endsAt: new Date(Date.now() - 4 * HOUR),
    })

    const outcome = await repo.cancelCleanupTx(id, {
      note: "Event cancelled",
      body: "b",
      reason: null,
      actorId: org,
    })

    expect(outcome).toBe("already_ended")
    const [row] = await h.sql<{ status: string }[]>`SELECT status FROM cleanups WHERE id = ${id}`
    expect(row!.status).toBe("upcoming")
    const timeline = await h.sql<{ id: string }[]>`
      SELECT id FROM cleanup_timeline WHERE cleanup_id = ${id} AND kind = 'cancel'
    `
    expect(timeline).toHaveLength(0)
  })

  it("cancels an event that has not ended", async () => {
    const org = await newUser("Cancel Org")
    const id = await newCleanup(org)

    expect(
      await repo.cancelCleanupTx(id, {
        note: "Event cancelled",
        body: "b",
        reason: null,
        actorId: org,
      }),
    ).toBe("cancelled")
    expect((await repo.findCleanupById(id, null))?.status).toBe("cancelled")
  })

  it("keeps an underway event in the upcoming list and drops an ended one", async () => {
    const org = await newUser("List Org")
    const underway = await newCleanup(org, {
      startsAt: new Date(Date.now() - HOUR),
      endsAt: new Date(Date.now() + 3 * HOUR),
    })
    const ended = await newCleanup(org, {
      startsAt: new Date(Date.now() - 8 * HOUR),
      endsAt: new Date(Date.now() - 4 * HOUR),
    })

    const { records } = await repo.listCleanups({
      when: "upcoming",
      bbox: undefined,
      near: undefined,
      cursor: null,
      limit: 50,
      viewerId: null,
    })
    const ids = records.map((r) => r.id)
    expect(ids).toContain(underway)
    expect(ids).not.toContain(ended)
  })
})
