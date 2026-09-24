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
 *   - postMessage inserts a chat_messages row (from the official account) + a 'message' timeline row, returns
 *     the members, and audits; notifyMember inserts a notifications row.
 *
 * When Docker is unavailable the whole describe block SKIPS; CI runs it for real.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedOfficialAccount } from "../helpers/official-account.js"
import { CIVFIX_OFFICIAL_USER_ID } from "../../src/auth/official-account.js"
import { makeDrizzleAdminEventRepository } from "../../src/services/admin/admin-event-repository.drizzle.js"
import type { AdminEventRepository } from "../../src/services/admin/admin-event-repository.js"

const pg = await withPg()

async function insertUser(h: PgHarness, name = "Org"): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO users (display_name) VALUES (${name}) RETURNING id
  `
  return rows[0]!.id
}

async function insertCleanup(
  h: PgHarness,
  opts: {
    organizerId: string
    status?: string
    title?: string
    capacity?: number | null
    bags?: number
    startsAt?: Date
    endsAt?: Date
  },
): Promise<string> {
  const startsAt = opts.startsAt ?? new Date(Date.now() + 2 * 86_400_000)
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO cleanups (
      organizer_user_id, type, title, geom, scheduled_at, ends_at, status, capacity, bags
    )
    VALUES (
      ${opts.organizerId},
      'site',
      ${opts.title ?? "Park cleanup"},
      ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326),
      ${startsAt},
      ${opts.endsAt ?? new Date(startsAt.getTime() + 4 * 60 * 60 * 1000)},
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
    await seedOfficialAccount(h.sql)
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

  it("projects completed for a past window whose stored status is still upcoming", async () => {
    const org = await insertUser(h)
    const id = await insertCleanup(h, {
      organizerId: org,
      status: "upcoming",
      startsAt: new Date(Date.now() - 8 * 60 * 60 * 1000),
      endsAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
    })

    const stored = await h.sql<{ status: string }[]>`SELECT status FROM cleanups WHERE id = ${id}`
    expect(stored[0]?.status).toBe("upcoming")
    expect((await repo.getEvent(id))?.status).toBe("completed")

    const page = await repo.listEvents({
      q: null,
      status: "completed",
      flaggedOnly: false,
      cursor: null,
      limit: 25,
    })
    expect(page.records.map((x) => x.id)).toContain(id)
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
    // Notifications are fanned out in the SAME transaction; the count matches the member count.
    expect(result?.notified).toBe(2)
    const chat = await h.sql<
      { id: string; body: string | null; sender_id: string }[]
    >`SELECT id, body, sender_id FROM chat_messages WHERE cleanup_id = ${id}`
    expect(chat[0]?.body).toBe("Rescheduled")
    expect(chat[0]?.sender_id).toBe(CIVFIX_OFFICIAL_USER_ID)
    const audit = await h.sql<
      { actor_id: string; meta: { members: number; messageId: string } }[]
    >`SELECT actor_id, meta FROM audit_log WHERE action = 'event.message_posted'`
    expect(audit).toEqual([{ actor_id: org, meta: { members: 2, messageId: chat[0]!.id } }])
    const timeline = await h.sql<
      { actor_id: string }[]
    >`SELECT actor_id FROM cleanup_timeline WHERE cleanup_id = ${id} AND kind = 'message'`
    expect(timeline).toEqual([{ actor_id: org }])

    // A notification row was written for each member, atomically with the chat message.
    const notes = await h.sql<{ user_id: string; type: string }[]>`
      SELECT user_id, type FROM notifications WHERE user_id IN (${org}, ${m1})
    `
    expect(notes).toHaveLength(2)
    expect(notes.every((n) => n.type === "cleanup_chat")).toBe(true)
  })
})
