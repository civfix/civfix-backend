/**
 * Admin audit-view data-layer integration test (Docker-gated). Exercises the REAL raw-SQL AuditRepository
 * (makeDrizzleAuditRepository) against a live Postgres/PostGIS container via withPg (canonical migrations +
 * the jurisdiction seed), so the audit_log read (LEFT JOIN users for the actor name + the actor/action/
 * target filters + the keyset cursor + the jsonb meta round-trip) runs against the real schema. Rows are
 * written through the production insertAuditRow helper so the read is proven end-to-end with the writer.
 *
 * When Docker is unavailable the whole describe block SKIPS, so the local suite stays green; CI runs it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import {
  insertAuditRow,
  makeDrizzleAuditRepository,
} from "../../src/services/admin/audit-repository.drizzle.js"
import type { AdminAuditAction } from "../../src/services/admin/audit.js"
import type { AuditRepository } from "../../src/services/admin/audit-service.js"

const pg = await withPg()

async function insertUser(h: PgHarness, name: string): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO users (display_name) VALUES (${name}) RETURNING id
  `
  return rows[0]!.id
}

describe.skipIf(!pg)("admin audit repository (integration: real schema)", () => {
  let h: PgHarness
  let repo: AuditRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleAuditRepository(h.sql)
  })

  beforeEach(async () => {
    await h.sql`TRUNCATE audit_log RESTART IDENTITY CASCADE`
    await h.sql`DELETE FROM users`
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("reads rows newest-first, joining the actor display name + the jsonb meta", async () => {
    const actor = await insertUser(h, "Alice Operator")
    await insertAuditRow(h.sql, {
      actorId: actor,
      action: "report.status_changed",
      target: "report:111",
      meta: { from: "submitted", to: "in_progress" },
    })
    await insertAuditRow(h.sql, { actorId: actor, action: "user.banned", target: "user:222" })

    const page = await repo.list({
      actor: null,
      action: null,
      target: null,
      cursor: null,
      limit: 25,
    })
    expect(page.records).toHaveLength(2)
    // Newest first.
    expect(page.records[0]?.action).toBe("user.banned")
    expect(page.records[0]?.actorName).toBe("Alice Operator")
    const statusRow = page.records.find((r) => r.action === "report.status_changed")!
    expect(statusRow.target).toBe("report:111")
    expect(statusRow.meta).toEqual({ from: "submitted", to: "in_progress" })
  })

  it("filters by action (ILIKE substring)", async () => {
    const actor = await insertUser(h, "Op")
    await insertAuditRow(h.sql, { actorId: actor, action: "report.flagged", target: "report:1" })
    await insertAuditRow(h.sql, { actorId: actor, action: "user.banned", target: "user:1" })

    const page = await repo.list({
      actor: null,
      action: "user",
      target: null,
      cursor: null,
      limit: 25,
    })
    expect(page.records.map((r) => r.action)).toEqual(["user.banned"])
  })

  it("filters by actor name OR exact actor id", async () => {
    const alice = await insertUser(h, "Alice")
    const bob = await insertUser(h, "Bob")
    await insertAuditRow(h.sql, { actorId: alice, action: "report.flagged", target: "t1" })
    await insertAuditRow(h.sql, { actorId: bob, action: "event.flagged", target: "t2" })

    const byName = await repo.list({
      actor: "alice",
      action: null,
      target: null,
      cursor: null,
      limit: 25,
    })
    expect(byName.records.map((r) => r.action)).toEqual(["report.flagged"])

    const byId = await repo.list({
      actor: bob,
      action: null,
      target: null,
      cursor: null,
      limit: 25,
    })
    expect(byId.records.map((r) => r.action)).toEqual(["event.flagged"])
  })

  it("a non-uuid actor filter does not error (matches by name only)", async () => {
    const alice = await insertUser(h, "Alice")
    await insertAuditRow(h.sql, { actorId: alice, action: "report.flagged", target: "t1" })
    const page = await repo.list({
      actor: "not-a-uuid",
      action: null,
      target: null,
      cursor: null,
      limit: 25,
    })
    expect(page.records).toHaveLength(0)
  })

  it("paginates newest-first with the keyset cursor (no overlap)", async () => {
    const actor = await insertUser(h, "Op")
    const actions: AdminAuditAction[] = [
      "report.flagged",
      "report.unflagged",
      "event.flagged",
      "event.unflagged",
      "user.flagged",
    ]
    for (const [i, action] of actions.entries()) {
      await insertAuditRow(h.sql, { actorId: actor, action, target: `t${i}` })
    }
    const first = await repo.list({
      actor: null,
      action: null,
      target: null,
      cursor: null,
      limit: 2,
    })
    expect(first.records).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const second = await repo.list({
      actor: null,
      action: null,
      target: null,
      cursor: first.nextCursor,
      limit: 2,
    })
    const firstIds = new Set(first.records.map((r) => r.id))
    expect(second.records.every((r) => !firstIds.has(r.id))).toBe(true)
  })
})
