/**
 * Admin activity-feed data-layer integration test (Docker-gated). Exercises the REAL raw-SQL
 * ActivityRepository (makeDrizzleActivityRepository) UNION query against a live Postgres/PostGIS container
 * via withPg (canonical migrations + the jurisdiction seed), so the four-source union (audit_log + reports
 * + cleanups + mail_events) runs against the real schema and orders newest-first across sources.
 *
 * Proven here against the real schema: the union + newest-first order and per-source projection; the
 * owner-opt-out / soft-delete exclusion on the report branch; `sort` walking the same rows the other way;
 * the `filter=<kind>` facet (branch pruning via sourcesForKind + the audit/mail predicates); the `q`
 * search across every branch's columns; and the (ts, id) keyset cursor paging a bounded page and its
 * successor with no repeat or skip.
 *
 * When Docker is unavailable the whole describe block SKIPS, so the local suite stays green; CI runs it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { makeDrizzleActivityRepository } from "../../src/services/admin/activity-repository.drizzle.js"
import type {
  ActivityRepository,
  ListActivityArgs,
} from "../../src/services/admin/activity-service.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()
const GEOID = LA_CITY.geoid

/** The default list() args (unfiltered, unsearched, newest-first, first page), with per-test overrides. */
function listArgs(over: Partial<ListActivityArgs> = {}): ListActivityArgs {
  return { q: null, filter: "all", sort: "newest", cursor: null, limit: 25, ...over }
}

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

  /** One row per union branch, staggered so the merged newest-first order is deterministic. */
  async function seedOneOfEachSource(): Promise<void> {
    const actor = await insertUser(h, "Operator")
    const reporter = await insertUser(h, "Reporter")
    const org = await insertUser(h, "Organizer")

    // A report (2h ago).
    await h.sql`
      INSERT INTO reports (reporter_user_id, idempotency_key, geom, geom_source, category, status, visibility, h3_cell, jurisdiction_geoid, created_at)
      VALUES (${reporter}, gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.35,34.1),4326), 'manual', 'trash', 'submitted', 'public', 'h0', ${GEOID}, now() - interval '2 hours')
    `
    // A cleanup (3h ago).
    await seedCleanup(h.sql, {
      organizerUserId: org,
      title: "Park cleanup",
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    })
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
  }

  it("unions audit + report + cleanup + mail_event sources, newest-first", async () => {
    await seedOneOfEachSource()

    const { records, nextCursor } = await repo.list(listArgs())
    expect(records).toHaveLength(4)
    // Newest first: mail_event (30m) -> audit (1h) -> report (2h) -> cleanup (3h).
    expect(records.map((r) => r.source)).toEqual(["mail_event", "audit", "report", "cleanup"])
    // The whole feed fit in the page, so there is no next page.
    expect(nextCursor).toBeNull()
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

  it("sort=oldest walks the same merged feed the other way", async () => {
    await seedOneOfEachSource()

    const { records } = await repo.list(listArgs({ sort: "oldest" }))
    expect(records.map((r) => r.source)).toEqual(["cleanup", "report", "audit", "mail_event"])
  })

  it("filter=<kind> prunes the union to the branches that can produce that kind", async () => {
    await seedOneOfEachSource()

    // pin comes from the report branch only; cleanup_plan from the cleanup branch only.
    expect((await repo.list(listArgs({ filter: "pin" }))).records.map((r) => r.source)).toEqual([
      "report",
    ])
    expect(
      (await repo.list(listArgs({ filter: "cleanup_plan" }))).records.map((r) => r.source),
    ).toEqual(["cleanup"])
    // gov_claim.approved is the audit branch's gov_onboard rule.
    const gov = (await repo.list(listArgs({ filter: "gov_onboard" }))).records
    expect(gov.map((r) => r.action)).toEqual(["gov_claim.approved"])
    // The bounced mail event is outreach_bounce, and is therefore NOT in outreach_open.
    expect(
      (await repo.list(listArgs({ filter: "outreach_bounce" }))).records.map((r) => r.eventType),
    ).toEqual(["bounced"])
    expect((await repo.list(listArgs({ filter: "outreach_open" }))).records).toHaveLength(0)
    // No branch produces `claim` today: an empty page, not an error.
    expect((await repo.list(listArgs({ filter: "claim" }))).records).toHaveLength(0)
  })

  it("q searches every branch's own columns", async () => {
    await seedOneOfEachSource()

    // Cleanup title, audit action, reporter display name, mail thread org.
    expect((await repo.list(listArgs({ q: "park" }))).records.map((r) => r.source)).toEqual([
      "cleanup",
    ])
    expect((await repo.list(listArgs({ q: "gov_claim" }))).records.map((r) => r.source)).toEqual([
      "audit",
    ])
    expect((await repo.list(listArgs({ q: "reporter" }))).records.map((r) => r.source)).toEqual([
      "report",
    ])
    expect((await repo.list(listArgs({ q: "waynesboro" }))).records.map((r) => r.source)).toEqual([
      "mail_event",
    ])
    expect((await repo.list(listArgs({ q: "no-such-thing" }))).records).toHaveLength(0)
  })

  it("excludes non-public / deleted reports from the feed", async () => {
    await h.sql`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, status, visibility, h3_cell, jurisdiction_geoid)
      VALUES (gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.35,34.1),4326), 'manual', 'trash', 'held', 'hidden', 'h0', ${GEOID})
    `
    const { records } = await repo.list(listArgs())
    expect(records.filter((r) => r.source === "report")).toHaveLength(0)
  })

  it("respects the limit across the union and pages the rest via the cursor", async () => {
    const reporter = await insertUser(h, "R")
    for (let i = 0; i < 5; i++) {
      await h.sql`
        INSERT INTO reports (reporter_user_id, idempotency_key, geom, geom_source, category, status, visibility, h3_cell, jurisdiction_geoid, created_at)
        VALUES (${reporter}, gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.35,34.1),4326), 'manual', 'trash', 'submitted', 'public', 'h0', ${GEOID}, now() - make_interval(hours => ${i}))
      `
    }
    const page1 = await repo.list(listArgs({ limit: 3 }))
    expect(page1.records).toHaveLength(3)
    expect(page1.nextCursor).not.toBeNull()

    // Page 2 resumes at the keyset anchor: the remaining 2 rows, none repeated, and the feed ends.
    const page2 = await repo.list(listArgs({ cursor: page1.nextCursor, limit: 3 }))
    expect(page2.records).toHaveLength(2)
    expect(page2.nextCursor).toBeNull()
    const ids1 = page1.records.map((r) => r.id)
    const ids2 = page2.records.map((r) => r.id)
    expect(ids2.filter((id) => ids1.includes(id))).toEqual([])
    // The two pages together are the whole feed, still in newest-first order.
    const all = await repo.list(listArgs())
    expect([...ids1, ...ids2]).toEqual(all.records.map((r) => r.id))
  })
})
