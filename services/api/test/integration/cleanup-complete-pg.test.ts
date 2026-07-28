/**
 * Host event completion against a live PostGIS container (Docker-gated).
 *
 * The unit suite runs `completeCleanupTx`'s matrix through the in-memory twin; this file runs the SAME
 * observable contract through the real Drizzle repository, because a divergence between the two is
 * invisible to CI otherwise (unit tests exercise the fake, integration the real one). The three things
 * only a real database can show:
 *
 *   - the status flip and the `kind='status'` cleanup_timeline row COMMIT TOGETHER (B16's one
 *     transaction) — and neither lands when the matrix refuses the transition;
 *   - a CONCURRENT double-complete yields exactly ONE "completed" and exactly ONE timeline row: the
 *     FOR NO KEY UPDATE row lock serializes the racers, and the loser reads status 'done' under the lock;
 *   - `cancelCleanupTx` on a completed event returns "already_completed" and writes NOTHING (B18) — the
 *     guard `status <> 'cancelled' AND status <> 'done'` is what keeps cancel from becoming a back door
 *     out of B17's forward-only rule.
 *
 * When Docker is unavailable the whole block SKIPS so the local suite stays green; CI runs it for real.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import type { CleanupRepository } from "../../src/services/cleanup-repository.types.js"

const pg = await withPg()

describe.skipIf(!pg)("host event completion (integration)", () => {
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

  /** An already-started event (the only kind a host may complete) unless `scheduledAt` says otherwise. */
  const STARTED = new Date(Date.now() - 2 * 60 * 60 * 1000)
  const NOT_STARTED = new Date(Date.now() + 7 * 86_400_000)

  /** Insert a cleanup with an explicit status + scheduled_at and return its id. */
  async function newCleanup(
    organizerId: string,
    over: { status?: string; scheduledAt?: Date } = {},
  ): Promise<string> {
    const id = randomUUID()
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (
        ${id}, ${organizerId}, 'site', 'Completion sweep',
        ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326),
        ${over.scheduledAt ?? STARTED}, ${over.status ?? "upcoming"}
      )
    `
    return id
  }

  async function statusOf(id: string): Promise<string> {
    const rows = await h.sql<{ status: string }[]>`SELECT status FROM cleanups WHERE id = ${id}`
    return rows[0]!.status
  }

  async function timelineOf(
    id: string,
    kind: string,
  ): Promise<{ note: string | null; actor_id: string | null }[]> {
    return h.sql<{ note: string | null; actor_id: string | null }[]>`
      SELECT note, actor_id FROM cleanup_timeline
      WHERE cleanup_id = ${id} AND kind = ${kind}
      ORDER BY created_at ASC, id ASC
    `
  }

  it("commits the status flip and the 'status' timeline row together", async () => {
    const org = await newUser("Complete Org")
    const id = await newCleanup(org)

    const outcome = await repo.completeCleanupTx(id, {
      note: "Event marked complete: 42 bags",
      actorId: org,
      now: new Date(),
    })

    expect(outcome).toBe("completed")
    expect(await statusOf(id)).toBe("done")
    // The timeline row is the audit half of the transition; a flip without it (or vice versa) would mean
    // the two writes were not actually atomic.
    expect(await timelineOf(id, "status")).toEqual([
      { note: "Event marked complete: 42 bags", actor_id: org },
    ])
  })

  it("refuses an event that has not started yet and writes NOTHING (too_early)", async () => {
    const org = await newUser("Early Org")
    const id = await newCleanup(org, { scheduledAt: NOT_STARTED })

    const outcome = await repo.completeCleanupTx(id, {
      note: "Event marked complete",
      actorId: org,
      now: new Date(),
    })

    expect(outcome).toBe("too_early")
    expect(await statusOf(id)).toBe("upcoming")
    expect(await timelineOf(id, "status")).toEqual([])
  })

  it("refuses a cancelled event, reports a missing one, and no-ops a repeat", async () => {
    const org = await newUser("Matrix Org")

    const cancelled = await newCleanup(org, { status: "cancelled" })
    expect(
      await repo.completeCleanupTx(cancelled, { note: "n", actorId: org, now: new Date() }),
    ).toBe("cancelled")
    expect(await timelineOf(cancelled, "status")).toEqual([])

    expect(
      await repo.completeCleanupTx(randomUUID(), { note: "n", actorId: org, now: new Date() }),
    ).toBe("not_found")

    // A sequential repeat: the second call sees 'done' under the lock and writes no second row.
    const done = await newCleanup(org)
    expect(
      await repo.completeCleanupTx(done, { note: "first", actorId: org, now: new Date() }),
    ).toBe("completed")
    expect(
      await repo.completeCleanupTx(done, { note: "second", actorId: org, now: new Date() }),
    ).toBe("already_completed")
    expect(await timelineOf(done, "status")).toEqual([{ note: "first", actor_id: org }])
  })

  it("a CONCURRENT double-complete yields exactly one 'completed' and one timeline row", async () => {
    const org = await newUser("Race Org")
    const id = await newCleanup(org)
    const now = new Date()

    // Both statements go out on separate pooled connections, so this is a real race. FOR NO KEY UPDATE
    // is what makes it safe: the loser blocks on the lock, then reads status 'done' and returns without
    // writing. Without the lock both would pass the status branch and append two timeline rows.
    const outcomes = await Promise.all([
      repo.completeCleanupTx(id, { note: "racer A", actorId: org, now }),
      repo.completeCleanupTx(id, { note: "racer B", actorId: org, now }),
    ])

    expect(outcomes.filter((o) => o === "completed")).toHaveLength(1)
    expect(outcomes.filter((o) => o === "already_completed")).toHaveLength(1)
    expect(await statusOf(id)).toBe("done")
    expect(await timelineOf(id, "status")).toHaveLength(1)
  })

  it("B18: cancelCleanupTx on a COMPLETED event returns already_completed and writes nothing", async () => {
    const org = await newUser("Backdoor Org")
    const id = await newCleanup(org)
    expect(
      await repo.completeCleanupTx(id, { note: "done", actorId: org, now: new Date() }),
    ).toBe("completed")

    const outcome = await repo.cancelCleanupTx(id, {
      note: "Event cancelled",
      body: "This event has been cancelled by the host.",
      reason: null,
      actorId: org,
    })

    expect(outcome).toBe("already_completed")
    // The status is untouched and no 'cancel' row was appended: an event that is `cancelled` yet carries
    // credited volunteer_hours rows is a state nothing downstream can interpret, so the guard refuses
    // rather than silently no-ops.
    expect(await statusOf(id)).toBe("done")
    expect(await timelineOf(id, "cancel")).toEqual([])
  })

  it("cancel still works on an upcoming event and still reports already_cancelled / not_found", async () => {
    const org = await newUser("Cancel Org")
    const id = await newCleanup(org, { scheduledAt: NOT_STARTED })
    const input = {
      note: "Event cancelled",
      body: "This event has been cancelled by the host.",
      reason: null,
      actorId: org,
    }

    // The B18 guard tightened an EXISTING endpoint, so its untouched branches are asserted here too.
    expect(await repo.cancelCleanupTx(id, input)).toBe("cancelled")
    expect(await statusOf(id)).toBe("cancelled")
    expect(await timelineOf(id, "cancel")).toHaveLength(1)

    expect(await repo.cancelCleanupTx(id, input)).toBe("already_cancelled")
    expect(await timelineOf(id, "cancel")).toHaveLength(1)

    expect(await repo.cancelCleanupTx(randomUUID(), input)).toBe("not_found")
  })
})
