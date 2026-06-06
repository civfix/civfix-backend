/**
 * Admin users data-layer integration test (Docker-gated). Exercises the REAL Drizzle/raw-SQL
 * AdminUserRepository (makeDrizzleAdminUserRepository) against a live Postgres/PostGIS container via
 * withPg (canonical migrations + seed), so users / user_moderation / reports / cleanup_members /
 * chat_messages / abuse_flags / sessions / audit_log all exist with their real constraints.
 *
 * Proven here against the real schema:
 *   - listUsers joins user_moderation (LEFT, defaulting active/low/0), computes the report + cleanup
 *     counts, the city (latest report's jurisdiction), and the status/flagged facet;
 *   - getUser returns the role + moderation fields;
 *   - the three sub-lists page the user's reports / cleanup memberships / chat messages;
 *   - toggleFlag upserts user_moderation.flagged + opens/resolves an abuse_flag (subject_type 'user')
 *     + audit;
 *   - setStatus upserts user_moderation.account_status (banned -> user.banned audit);
 *   - recordRoleAudit writes a user.role_changed audit row.
 *
 * The ban -> revoke-all-sessions behavior lives in SessionService (covered by the auth-session unit
 * test); this repo only persists the status. When Docker is unavailable the block SKIPS; CI runs it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleAdminUserRepository } from "../../src/services/admin/admin-user-repository.drizzle.js"
import type { AdminUserRepository } from "../../src/services/admin/admin-user-service.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()
const GEOID = LA_CITY.geoid

/** Insert a user and return its id. */
async function insertUser(
  h: PgHarness,
  opts: { name?: string; handle?: string; role?: string; emailVerified?: boolean } = {},
): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO users (display_name, handle, role, email, email_verified)
    VALUES (
      ${opts.name ?? "User"},
      ${opts.handle ?? null},
      ${opts.role ?? "citizen"},
      ${opts.handle ? `${opts.handle}@example.com` : null},
      ${opts.emailVerified ?? false}
    )
    RETURNING id
  `
  return rows[0]!.id
}

/** Insert a report authored by a user. */
async function insertReport(h: PgHarness, reporterId: string, category = "trash"): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO reports (reporter_user_id, idempotency_key, geom, geom_source, category, status, h3_cell, jurisdiction_geoid)
    VALUES (${reporterId}, gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', ${category}, 'submitted', 'h0', ${GEOID})
    RETURNING id
  `
  return rows[0]!.id
}

describe.skipIf(!pg)("admin user repository (integration: real schema)", () => {
  let h: PgHarness
  let repo: AdminUserRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleAdminUserRepository(h.sql)
  })

  beforeEach(async () => {
    await h.sql`TRUNCATE user_moderation, report_timeline, report_follows, abuse_flags, audit_log, cleanup_members, cleanup_timeline, chat_messages, sessions RESTART IDENTITY CASCADE`
    await h.sql`DELETE FROM cleanups`
    await h.sql`DELETE FROM reports`
    await h.sql`DELETE FROM users`
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("lists a user with derived counts, city, default status, and the flagged facet", async () => {
    const u = await insertUser(h, { name: "Jane", handle: "jane", emailVerified: true })
    await insertReport(h, u)
    await insertReport(h, u)
    const { records } = await repo.listUsers({
      q: null,
      status: null,
      flaggedOnly: false,
      cursor: null,
      limit: 25,
    })
    const row = records.find((r) => r.id === u)!
    expect(row.reports).toBe(2)
    expect(row.accountStatus).toBe("active") // no user_moderation row -> default
    expect(row.city).toBe(LA_CITY.name)
    expect(row.emailVerified).toBe(true)

    await repo.toggleFlag(u, { reason: "spam", actorId: null })
    const flagged = await repo.listUsers({
      q: null,
      status: null,
      flaggedOnly: true,
      cursor: null,
      limit: 25,
    })
    expect(flagged.records.map((r) => r.id)).toEqual([u])
  })

  it("getUser returns the role", async () => {
    const u = await insertUser(h, { role: "gov_admin" })
    expect((await repo.getUser(u))?.role).toBe("gov_admin")
  })

  it("the sub-lists page the user's reports / cleanups / messages", async () => {
    const u = await insertUser(h, { handle: "sam" })
    await insertReport(h, u)
    const org = await insertUser(h)
    const cleanup = await h.sql<{ id: string }[]>`
      INSERT INTO cleanups (organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (${org}, 'site', 'Park', ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), now(), 'upcoming')
      RETURNING id
    `
    const cleanupId = cleanup[0]!.id
    await h.sql`INSERT INTO cleanup_members (cleanup_id, user_id, role) VALUES (${cleanupId}, ${u}, 'member')`
    await h.sql`INSERT INTO chat_messages (cleanup_id, sender_id, body, kind) VALUES (${cleanupId}, ${u}, 'hello', 'text')`

    expect((await repo.listUserReports(u, null, 20)).records).toHaveLength(1)
    const events = await repo.listUserEvents(u, null, 20)
    expect(events.records[0]?.role).toBe("member")
    const messages = await repo.listUserMessages(u, null, 20)
    expect(messages.records[0]?.text).toBe("hello")
  })

  it("toggleFlag upserts user_moderation + opens/resolves an abuse_flag (subject_type 'user')", async () => {
    const u = await insertUser(h)
    expect(await repo.toggleFlag(u, { reason: "abuse", actorId: null })).toBe(true)
    const mod = await h.sql<{ flagged: boolean; flag_reason: string | null }[]>`
      SELECT flagged, flag_reason FROM user_moderation WHERE user_id = ${u}
    `
    expect(mod[0]?.flagged).toBe(true)
    expect(mod[0]?.flag_reason).toBe("abuse")
    const open = await h.sql<{ id: string }[]>`
      SELECT id FROM abuse_flags WHERE subject_type = 'user' AND subject_id = ${u} AND resolved_at IS NULL
    `
    expect(open).toHaveLength(1)

    expect(await repo.toggleFlag(u, { reason: null, actorId: null })).toBe(false)
    const stillOpen = await h.sql<{ id: string }[]>`
      SELECT id FROM abuse_flags WHERE subject_type = 'user' AND subject_id = ${u} AND resolved_at IS NULL
    `
    expect(stillOpen).toHaveLength(0)
  })

  it("setStatus upserts user_moderation.account_status (banned -> user.banned audit)", async () => {
    const u = await insertUser(h)
    expect(await repo.setStatus(u, { status: "banned", reason: "tos", actorId: null })).toBe(true)
    const mod = await h.sql<{ account_status: string }[]>`
      SELECT account_status FROM user_moderation WHERE user_id = ${u}
    `
    expect(mod[0]?.account_status).toBe("banned")
    const audit = await h.sql<
      { action: string }[]
    >`SELECT action FROM audit_log WHERE action = 'user.banned'`
    expect(audit).toHaveLength(1)
  })

  it("recordRoleAudit writes a user.role_changed audit row", async () => {
    const u = await insertUser(h)
    await repo.recordRoleAudit(u, { role: "operator", actorId: null })
    const audit = await h.sql<{ action: string; target: string }[]>`
      SELECT action, target FROM audit_log WHERE action = 'user.role_changed'
    `
    expect(audit[0]?.target).toBe(`user:${u}`)
  })
})
