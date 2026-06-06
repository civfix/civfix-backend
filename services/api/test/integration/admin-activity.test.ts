/**
 * Admin activity-feed data-layer integration test (Docker-gated). Exercises the REAL raw-SQL
 * ActivityRepository (makeDrizzleActivityRepository) UNION query against a live Postgres/PostGIS container
 * via withPg (canonical migrations + the jurisdiction seed), so the four-source union (audit_log + reports
 * + cleanups + mail_events) runs against the real schema and orders newest-first across sources.
 *
 * When Docker is unavailable the whole describe block SKIPS, so the local suite stays green; CI runs it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleActivityRepository } from "../../src/services/admin/activity-repository.drizzle.js"
import type { ActivityRepository } from "../../src/services/admin/activity-service.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()
const GEOID = LA_CITY.geoid

async function insertUser(h: PgHarness, name = "User"): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO users (display_name) VALUES (${name}) RETURNING id
  `
  return rows[0]!.id
}

describe.skipIf(!pg)("admin activity repository (integration: real schema)", () => {
  let h: PgHarness
  let repo: ActivityRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleActivityRepository(h.sql)
  })

  beforeEach(async () => {
    await h.sql`TRUNCATE audit_log, cleanup_members, mail_events, mail_messages, mail_threads RESTART IDENTITY CASCADE`
    await h.sql`DELETE FROM cleanups`
    await h.sql`DELETE FROM reports`
    await h.sql`DELETE FROM users`
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("unions audit + report + cleanup + mail_event sources, newest-first", async () => {
    const actor = await insertUser(h, "Operator")
    const reporter = await insertUser(h, "Reporter")
    const org = await insertUser(h, "Organizer")

    // A report (2h ago).
    await h.sql`
      INSERT INTO reports (reporter_user_id, idempotency_key, geom, geom_source, category, status, visibility, h3_cell, jurisdiction_geoid, created_at)
      VALUES (${reporter}, gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.35,34.1),4326), 'manual', 'trash', 'submitted', 'public', 'h0', ${GEOID}, now() - interval '2 hours')
    `
    // A cleanup (3h ago).
    await h.sql`
      INSERT INTO cleanups (organizer_user_id, type, title, geom, scheduled_at, status, created_at)
      VALUES (${org}, 'site', 'Park cleanup', ST_SetSRID(ST_MakePoint(-118.35,34.1),4326), now(), 'upcoming', now() - interval '3 hours')
    `
    // An audit row (1h ago).
    await h.sql`
      INSERT INTO audit_log (actor_id, action, target, created_at)
      VALUES (${actor}, 'gov_claim.approved', 'gov_claim:1', now() - interval '1 hour')
    `
    // A mail thread + a bounced event (30m ago).
    const threadId = (await h.sql<{ id: string }[]>`
      INSERT INTO mail_threads (thread_token, org, subject, status)
      VALUES ('tok-1', 'Waynesboro', 'Outreach', 'bounced')
      RETURNING id
    `)[0]!.id
    await h.sql`
      INSERT INTO mail_events (thread_id, type, created_at)
      VALUES (${threadId}, 'bounced', now() - interval '30 minutes')
    `

    const records = await repo.recent(25)
    expect(records).toHaveLength(4)
    // Newest first: mail_event (30m) -> audit (1h) -> report (2h) -> cleanup (3h).
    expect(records.map((r) => r.source)).toEqual(["mail_event", "audit", "report", "cleanup"])
    // The audit row carries the actor name + action.
    const audit = records.find((r) => r.source === "audit")!
    expect(audit.who).toBe("Operator")
    expect(audit.action).toBe("gov_claim.approved")
    // The report carries the category subject + the jurisdiction place.
    const report = records.find((r) => r.source === "report")!
    expect(report.subject).toBe("trash")
    expect(report.where).toBe(LA_CITY.name)
    expect(report.who).toBe("Reporter")
    // The mail event carries its type.
    const mail = records.find((r) => r.source === "mail_event")!
    expect(mail.eventType).toBe("bounced")
  })

  it("excludes non-public / deleted reports from the feed", async () => {
    await h.sql`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, status, visibility, h3_cell, jurisdiction_geoid)
      VALUES (gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.35,34.1),4326), 'manual', 'trash', 'held', 'hidden', 'h0', ${GEOID})
    `
    const records = await repo.recent(25)
    expect(records.filter((r) => r.source === "report")).toHaveLength(0)
  })

  it("respects the limit across the union", async () => {
    const reporter = await insertUser(h, "R")
    for (let i = 0; i < 5; i++) {
      await h.sql`
        INSERT INTO reports (reporter_user_id, idempotency_key, geom, geom_source, category, status, visibility, h3_cell, jurisdiction_geoid, created_at)
        VALUES (${reporter}, gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.35,34.1),4326), 'manual', 'trash', 'submitted', 'public', 'h0', ${GEOID}, now() - make_interval(hours => ${i}))
      `
    }
    const records = await repo.recent(3)
    expect(records).toHaveLength(3)
  })
})
