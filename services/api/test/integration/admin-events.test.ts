/**
 * Admin events (cleanups) data-layer integration test (Docker-gated). Exercises the REAL Drizzle/raw-SQL
 * AdminEventRepository (makeDrizzleAdminEventRepository) against a live Postgres/PostGIS container via
 * withPg (canonical migrations + seed), so cleanups / cleanup_members / cleanup_timeline / chat_messages
 * / notifications / audit_log all exist with their real constraints + the 0007 capacity/bags columns.
 *
 * Proven here against the real schema:
 *   - listEvents computes attendees (cleanup_members) + the timeline-derived flagged state + the
 *     status/flagged facet, and returns capacity/bags;
 *   - setStatus writes cleanup_timeline + an audit row;
 *   - toggleFlag appends a flag/unflag cleanup_timeline row (and the derived flagged flips) + audit;
 *   - cancel sets status cancelled + a 'cancel' timeline row + audit;
 *   - postMessage inserts a chat_messages row (from the operator) + a 'message' timeline row, returns
 *     the members, and audits; notifyMember inserts a notifications row.
 *
 * When Docker is unavailable the whole describe block SKIPS; CI runs it for real.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleAdminEventRepository } from "../../src/services/admin/admin-event-repository.drizzle.js"
import type { AdminEventRepository } from "../../src/services/admin/admin-event-service.js"

const pg = await withPg()

/** Insert a user and return its id. */
async function insertUser(h: PgHarness, name = "Org"): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO users (display_name) VALUES (${name}) RETURNING id
  `
  return rows[0]!.id
}

/** Insert a cleanup and return its id. */
async function insertCleanup(
  h: PgHarness,
  opts: {
    organizerId: string
    status?: string
    title?: string
    capacity?: number | null
    bags?: number
  },
): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO cleanups (organizer_user_id, type, title, geom, scheduled_at, status, capacity, bags)
    VALUES (
      ${opts.organizerId},
      'site',
      ${opts.title ?? "Park cleanup"},
      ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326),
      now() + interval '2 days',
      ${opts.status ?? "upcoming"},
      ${opts.capacity ?? null},
      ${opts.bags ?? 0}
    )
    RETURNING id
  `
  return rows[0]!.id
}

describe.skipIf(!pg)("admin event repository (integration: real schema)", () => {
  let h: PgHarness
  let repo: AdminEventRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleAdminEventRepository(h.sql)
  })

  beforeEach(async () => {
    await h.sql`TRUNCATE cleanup_timeline, cleanup_members, chat_messages, notifications, audit_log RESTART IDENTITY CASCADE`
    await h.sql`DELETE FROM cleanups`
    await h.sql`DELETE FROM users`
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("lists a cleanup with attendees, capacity/bags, and the flagged facet (timeline-derived)", async () => {
    const org = await insertUser(h, "Olive")
    const id = await insertCleanup(h, { organizerId: org, capacity: 30, bags: 5 })
    const m1 = await insertUser(h)
    const m2 = await insertUser(h)
    await h.sql`
      INSERT INTO cleanup_members (cleanup_id, user_id, role)
      VALUES (${id}, ${org}, 'organizer'), (${id}, ${m1}, 'member'), (${id}, ${m2}, 'member')
    `
    const { records } = await repo.listEvents({
      q: null,
      status: null,
      flaggedOnly: false,
      cursor: null,
      limit: 25,
    })
    expect(records).toHaveLength(1)
    expect(records[0]?.attendees).toBe(3)
    expect(records[0]?.capacity).toBe(30)
    expect(records[0]?.bags).toBe(5)
    expect(records[0]?.flagged).toBe(false)

    await repo.toggleFlag(id, { reason: "x", actorId: null })
    const flagged = await repo.listEvents({
      q: null,
      status: null,
      flaggedOnly: true,
      cursor: null,
      limit: 25,
    })
    expect(flagged.records.map((x) => x.id)).toEqual([id])
  })

  it("setStatus writes cleanup_timeline + audit", async () => {
    const org = await insertUser(h)
    const id = await insertCleanup(h, { organizerId: org, status: "upcoming" })
    const ok = await repo.setStatus(id, { status: "in_progress", note: "live", actorId: null })
    expect(ok).toBe(true)
    const status = await h.sql<{ status: string }[]>`SELECT status FROM cleanups WHERE id = ${id}`
    expect(status[0]?.status).toBe("in_progress")
    const tl = await h.sql<
      { kind: string }[]
    >`SELECT kind FROM cleanup_timeline WHERE cleanup_id = ${id} ORDER BY created_at DESC LIMIT 1`
    expect(tl[0]?.kind).toBe("status")
    const audit = await h.sql<
      { action: string }[]
    >`SELECT action FROM audit_log WHERE action = 'event.status_changed'`
    expect(audit).toHaveLength(1)
  })

  it("toggleFlag flips the derived flagged state via cleanup_timeline (+ audit)", async () => {
    const org = await insertUser(h)
    const id = await insertCleanup(h, { organizerId: org })
    expect(await repo.toggleFlag(id, { reason: "spam", actorId: null })).toBe(true)
    expect((await repo.getEvent(id))?.flagged).toBe(true)
    expect(await repo.toggleFlag(id, { reason: null, actorId: null })).toBe(false)
    expect((await repo.getEvent(id))?.flagged).toBe(false)
  })

  it("cancel sets status cancelled + a 'cancel' timeline row + audit", async () => {
    const org = await insertUser(h)
    const id = await insertCleanup(h, { organizerId: org, status: "upcoming" })
    const ok = await repo.cancel(id, { note: "weather", actorId: null })
    expect(ok).toBe(true)
    const status = await h.sql<{ status: string }[]>`SELECT status FROM cleanups WHERE id = ${id}`
    expect(status[0]?.status).toBe("cancelled")
    const audit = await h.sql<
      { action: string }[]
    >`SELECT action FROM audit_log WHERE action = 'event.cancelled'`
    expect(audit).toHaveLength(1)
  })

  it("postMessage inserts a chat row + timeline + fans out a notification per member IN-TX (L4)", async () => {
    const org = await insertUser(h, "Olive")
    const id = await insertCleanup(h, { organizerId: org })
    const m1 = await insertUser(h)
    await h.sql`
      INSERT INTO cleanup_members (cleanup_id, user_id, role)
      VALUES (${id}, ${org}, 'organizer'), (${id}, ${m1}, 'member')
    `
    const result = await repo.postMessage(id, { body: "Rescheduled", actorId: org })
    expect(result).not.toBeNull()
    // L4: notifications are fanned out in the SAME transaction; the count matches the member count.
    expect(result?.notified).toBe(2)
    const chat = await h.sql<
      { body: string | null }[]
    >`SELECT body FROM chat_messages WHERE cleanup_id = ${id}`
    expect(chat[0]?.body).toBe("Rescheduled")
    const audit = await h.sql<
      { action: string }[]
    >`SELECT action FROM audit_log WHERE action = 'event.message_posted'`
    expect(audit).toHaveLength(1)

    // A notification row was written for each member, atomically with the chat message.
    const notes = await h.sql<{ user_id: string; type: string }[]>`
      SELECT user_id, type FROM notifications WHERE user_id IN (${org}, ${m1})
    `
    expect(notes).toHaveLength(2)
    expect(notes.every((n) => n.type === "cleanup_chat")).toBe(true)
  })
})
