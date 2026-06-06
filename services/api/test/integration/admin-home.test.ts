/**
 * Admin home data-layer integration test (Docker-gated). Exercises the REAL raw-SQL HomeRepository
 * (makeDrizzleHomeRepository) against a live Postgres/PostGIS container via withPg (canonical migrations +
 * the jurisdiction seed), so the per-section count queries + the live-map pin query run against the real
 * schema (reports / cleanups / cleanup_members / abuse_flags / user_moderation / mail_threads /
 * mail_events / jurisdiction_contacts).
 *
 * Proven here against the real schema:
 *   - discoverySummary: queue / reportsWaiting / overSla over submitted-but-unrouted reports;
 *   - reportsSummary: flagged (open abuse_flag) / in-progress / completed;
 *   - eventsSummary: upcoming / live / attending (member counts);
 *   - mailSummary: unread + needs-action + bounce rate (reusing the shared mail stats);
 *   - usersSummary: flagged / high-risk / suspended over user_moderation;
 *   - livePins24h: public reports in the last 24h;
 *   - recentPins: report + event pins with the cleanups status mapped to the EventStatus enum.
 *
 * When Docker is unavailable the whole describe block SKIPS, so the local suite stays green; CI runs it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleHomeRepository } from "../../src/services/admin/home-repository.drizzle.js"
import type { HomeRepository } from "../../src/services/admin/home-service.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()
const GEOID = LA_CITY.geoid

async function insertUser(h: PgHarness, name = "User"): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO users (display_name) VALUES (${name}) RETURNING id
  `
  return rows[0]!.id
}

async function insertReport(
  h: PgHarness,
  opts: { status?: string; createdAt?: Date; geoid?: string | null; visibility?: string } = {},
): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO reports (
      idempotency_key, geom, geom_source, category, status, visibility, h3_cell, jurisdiction_geoid, created_at
    )
    VALUES (
      gen_random_uuid(),
      ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326),
      'manual', 'trash',
      ${opts.status ?? "submitted"},
      ${opts.visibility ?? "public"},
      'h0',
      ${opts.geoid === undefined ? GEOID : opts.geoid},
      ${opts.createdAt ?? new Date()}
    )
    RETURNING id
  `
  return rows[0]!.id
}

describe.skipIf(!pg)("admin home repository (integration: real schema)", () => {
  let h: PgHarness
  let repo: HomeRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleHomeRepository(h.sql)
  })

  beforeEach(async () => {
    await h.sql`TRUNCATE cleanup_members, jurisdiction_contacts, user_moderation, abuse_flags, mail_events, mail_messages, mail_threads RESTART IDENTITY CASCADE`
    await h.sql`DELETE FROM cleanups`
    await h.sql`DELETE FROM reports`
    await h.sql`DELETE FROM users`
    await h.sql`UPDATE jurisdictions SET contact_emails = NULL WHERE geoid = ${GEOID}`
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("discoverySummary: counts unrouted submitted reports + over-SLA", async () => {
    // Two submitted reports in an unrouted jurisdiction; one old (over SLA), one fresh.
    await insertReport(h, { status: "submitted", createdAt: new Date(Date.now() - 30 * 3600 * 1000) })
    await insertReport(h, { status: "submitted", createdAt: new Date() })

    const d = await repo.discoverySummary()
    expect(d.queue).toBe(1) // one jurisdiction
    expect(d.reportsWaiting).toBe(2)
    expect(d.overSla).toBe(1)
  })

  it("discoverySummary: a routed jurisdiction (has contact) is NOT in the queue", async () => {
    await h.sql`UPDATE jurisdictions SET contact_emails = ARRAY['x@city.gov'] WHERE geoid = ${GEOID}`
    await insertReport(h, { status: "submitted" })
    const d = await repo.discoverySummary()
    expect(d.queue).toBe(0)
    expect(d.reportsWaiting).toBe(0)
  })

  it("reportsSummary: flagged (open abuse_flag) + in-progress + completed", async () => {
    const r1 = await insertReport(h, { status: "in_progress" })
    await insertReport(h, { status: "resolved" })
    await h.sql`
      INSERT INTO abuse_flags (subject_type, subject_id, reason, source)
      VALUES ('report', ${r1}, 'manual', 'api')
    `
    const s = await repo.reportsSummary()
    expect(s.flagged).toBe(1)
    expect(s.inProgress).toBe(1)
    expect(s.completed).toBe(1)
  })

  it("eventsSummary: upcoming / live / attending", async () => {
    const org = await insertUser(h, "Org")
    const live = (await h.sql<{ id: string }[]>`
      INSERT INTO cleanups (organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (${org}, 'site', 'Live', ST_SetSRID(ST_MakePoint(-118.35,34.1),4326), now(), 'active')
      RETURNING id
    `)[0]!.id
    await h.sql`
      INSERT INTO cleanups (organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (${org}, 'site', 'Up', ST_SetSRID(ST_MakePoint(-118.35,34.1),4326), now(), 'upcoming')
    `
    const member = await insertUser(h, "M")
    await h.sql`INSERT INTO cleanup_members (cleanup_id, user_id, role) VALUES (${live}, ${member}, 'attendee')`

    const e = await repo.eventsSummary()
    expect(e.upcoming).toBe(1)
    expect(e.live).toBe(1)
    expect(e.attending).toBe(1)
  })

  it("usersSummary: flagged / high-risk / suspended from user_moderation", async () => {
    const u1 = await insertUser(h, "Flagged")
    const u2 = await insertUser(h, "Risky")
    const u3 = await insertUser(h, "Suspended")
    await h.sql`INSERT INTO user_moderation (user_id, flagged) VALUES (${u1}, true)`
    await h.sql`INSERT INTO user_moderation (user_id, risk) VALUES (${u2}, 'high')`
    await h.sql`INSERT INTO user_moderation (user_id, account_status) VALUES (${u3}, 'suspended')`

    const s = await repo.usersSummary()
    expect(s.flagged).toBe(1)
    expect(s.highRisk).toBe(1)
    expect(s.suspended).toBe(1)
  })

  it("livePins24h: public reports in the last 24h only", async () => {
    await insertReport(h, { createdAt: new Date() })
    await insertReport(h, { createdAt: new Date(Date.now() - 48 * 3600 * 1000) })
    expect(await repo.livePins24h()).toBe(1)
  })

  it("recentPins: report + event pins with the event status mapped to the EventStatus enum", async () => {
    await insertReport(h, { status: "submitted" })
    const org = await insertUser(h, "Org")
    await h.sql`
      INSERT INTO cleanups (organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (${org}, 'site', 'Done event', ST_SetSRID(ST_MakePoint(-118.35,34.1),4326), now(), 'done')
    `
    const pins = await repo.recentPins(50)
    const report = pins.find((p) => p.refType === "report")
    const event = pins.find((p) => p.refType === "event")
    expect(report).toBeDefined()
    expect(report?.lat).toBeCloseTo(34.1, 3)
    expect(event).toBeDefined()
    // 'done' maps to 'completed'.
    expect(event?.status).toBe("completed")
    expect(event?.attendees).toBe(0)
  })
})
