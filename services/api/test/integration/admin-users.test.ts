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
 *   - applyRole writes users.role + its user.role_changed audit row in ONE transaction (L5).
 *
 * The ban -> revoke-all-sessions behavior lives in SessionService (covered by the auth-session unit
 * test); this repo only persists the status. When Docker is unavailable the block SKIPS; CI runs it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import type { Sql } from "../../src/db/client.js"
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
      ${opts.handle ?? testHandle()},
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
    await h.sql`TRUNCATE user_moderation, report_timeline, abuse_flags, audit_log, cleanup_members, cleanup_timeline, chat_messages, chat_group_members, chat_groups, sessions RESTART IDENTITY CASCADE`
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

  it("search matches a user by the CITY (jurisdiction of their reports), not just name/handle", async () => {
    // The Drizzle search must match the derived city via the reports->jurisdictions join, like the
    // in-memory repo + the documented contract (it previously only matched name/handle — a divergence).
    const inLa = await insertUser(h, { name: "Ada", handle: "ada" })
    await insertReport(h, inLa) // resolves to LA_CITY
    const elsewhere = await insertUser(h, { name: "Bo", handle: "bob" }) // no reports -> no city
    const { records } = await repo.listUsers({
      q: LA_CITY.name,
      status: null,
      flaggedOnly: false,
      cursor: null,
      limit: 25,
    })
    const ids = records.map((r) => r.id)
    expect(ids).toContain(inLa)
    expect(ids).not.toContain(elsewhere)
  })

  it("F095: a city search resolves a capped user-id set instead of a correlated EXISTS", async () => {
    const inLa = await insertUser(h, { name: "Cora", handle: "cora" })
    await insertReport(h, inLa)
    const elsewhere = await insertUser(h, { name: "Dana", handle: "dana" })

    const statements: string[] = []
    const recorder = ((strings: TemplateStringsArray, ...args: unknown[]) => {
      const raw = (strings as unknown as { raw?: unknown }).raw
      if (Array.isArray(raw)) statements.push((raw as string[]).join("?"))
      return (h.sql as unknown as (s: TemplateStringsArray, ...a: unknown[]) => unknown)(
        strings,
        ...args,
      )
    }) as unknown as Sql
    Object.setPrototypeOf(recorder, h.sql)

    const { records } = await makeDrizzleAdminUserRepository(recorder).listUsers({
      q: LA_CITY.name,
      status: null,
      flaggedOnly: false,
      cursor: null,
      limit: 25,
    })
    const ids = records.map((r) => r.id)
    expect(ids).toContain(inLa)
    expect(ids).not.toContain(elsewhere)

    const cityResolution = statements.find((sqlText) => sqlText.includes("FROM reports r2"))
    expect(cityResolution).toBeDefined()
    expect(cityResolution).toContain("LIMIT")
    expect(statements.some((sqlText) => sqlText.includes("u.id = ANY("))).toBe(true)
    expect(statements.some((sqlText) => sqlText.includes("EXISTS (SELECT 1"))).toBe(false)
  })

  it("getUser returns the role", async () => {
    const u = await insertUser(h, { role: "gov_admin" })
    expect((await repo.getUser(u))?.role).toBe("gov_admin")
  })

  /**
   * countByFacet has two arms and only the SEARCHED one is capped. The unfiltered arm must stay an exact
   * aggregate: AdminUserCounts is four bare numbers with no truncation flag, so a capped `all` renders on
   * the console's chips as if the cap WERE the account total. Pinned against the real schema because the
   * in-memory fake counts exactly either way and so cannot catch a regression here.
   */
  it("countByFacet: the unfiltered counts are exact per bucket; a search still narrows them", async () => {
    const a = await insertUser(h, { name: "Ann", handle: "annfacet" })
    const b = await insertUser(h, { name: "Bob", handle: "bobfacet" })
    const c = await insertUser(h, { name: "Cyd", handle: "cydfacet" })
    await insertUser(h, { name: "Dee", handle: "deefacet" })
    // Bob suspended, Cyd flagged (orthogonal to status), Ann/Dee default-active with no moderation row.
    await repo.setStatus(b, { status: "suspended", reason: null, actorId: null })
    await repo.toggleFlag(c, { reason: "spam", actorId: null })

    expect(await repo.countByFacet({ q: null })).toEqual({
      all: 4,
      active: 3,
      suspended: 1,
      flagged: 1,
    })
    // The LEFT JOIN's COALESCE default (no user_moderation row at all) must land in `active`, which is the
    // arm most easily lost when the CTE is replaced by a direct aggregate.
    expect(await repo.getUser(a)).toMatchObject({ accountStatus: "active" })

    const searched = await repo.countByFacet({ q: "bobfacet" })
    expect(searched).toEqual({ all: 1, active: 0, suspended: 1, flagged: 0 })
  })

  it("the sub-lists preserve cleanup, standalone group, and report message origins", async () => {
    const u = await insertUser(h, { handle: "sam" })
    await insertReport(h, u)
    const org = await insertUser(h)
    const cleanupId = await seedCleanup(h.sql, { organizerUserId: org, title: "Park" })
    await h.sql`INSERT INTO cleanup_members (cleanup_id, user_id, role) VALUES (${cleanupId}, ${u}, 'member')`
    await h.sql`INSERT INTO chat_messages (cleanup_id, sender_id, body, kind) VALUES (${cleanupId}, ${u}, 'hello', 'text')`
    const group = await h.sql<{ id: string }[]>`
      INSERT INTO chat_groups (owner_id, name) VALUES (${org}, 'Neighbors') RETURNING id
    `
    const groupId = group[0]!.id
    await h.sql`INSERT INTO chat_messages (group_id, sender_id, body, kind) VALUES (${groupId}, ${u}, 'group hello', 'text')`
    const reportId = await insertReport(h, u)
    await h.sql`INSERT INTO chat_messages (report_id, sender_id, body, kind) VALUES (${reportId}, ${u}, 'report hello', 'text')`

    // Two reports seeded for this user: the standalone one above and the chat-origin one.
    expect((await repo.listUserReports(u, null, 20)).records).toHaveLength(2)
    const events = await repo.listUserEvents(u, null, 20)
    expect(events.records[0]?.role).toBe("member")
    const messages = await repo.listUserMessages(u, null, 20)
    expect(messages.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "hello", source: "chat", sourceId: cleanupId, thread: "Park" }),
        expect.objectContaining({
          text: "group hello",
          source: "group",
          sourceId: groupId,
          thread: "Neighbors",
        }),
        expect.objectContaining({ text: "report hello", source: "report", sourceId: reportId }),
      ]),
    )
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

  // L5: the role UPDATE and its audit row are ONE transaction, so a committed privilege change can never
  // be missing its audit. Assert both landed AND that the prior role was captured on the audit meta.
  it("applyRole writes users.role AND a user.role_changed audit row in one transaction", async () => {
    const u = await insertUser(h)
    expect(await repo.applyRole(u, { role: "gov_admin", actorId: null })).toBe(true)
    const rows = await h.sql<{ role: string }[]>`SELECT role FROM users WHERE id = ${u}`
    expect(rows[0]?.role).toBe("gov_admin")
    const audit = await h.sql<{ action: string; target: string; meta: Record<string, unknown> }[]>`
      SELECT action, target, meta FROM audit_log WHERE action = 'user.role_changed'
    `
    expect(audit[0]?.target).toBe(`user:${u}`)
    expect(audit[0]?.meta).toMatchObject({ role: "gov_admin", priorRole: "citizen" })
  })

  it("applyRole returns false (and writes nothing) for an unknown user", async () => {
    const before = await h.sql<{ n: string }[]>`SELECT count(*) AS n FROM audit_log`
    expect(
      await repo.applyRole("00000000-0000-0000-0000-000000000000", {
        role: "gov_admin",
        actorId: null,
      }),
    ).toBe(false)
    const after = await h.sql<{ n: string }[]>`SELECT count(*) AS n FROM audit_log`
    expect(after[0]?.n).toBe(before[0]?.n)
  })
})
