/**
 * Admin discovery + jurisdiction-contacts data-layer integration test (Docker-gated). Exercises the REAL
 * Drizzle/raw-SQL repositories (makeDrizzleDiscoveryRepository + makeDrizzleJurisdictionContactsRepository)
 * against a live Postgres/PostGIS container via withPg, which applies the canonical migrations + the
 * jurisdiction seed (so jurisdiction_discovery_tasks / jurisdiction_contacts / reports / audit_log /
 * abuse_flags / outreach_state all exist with their real constraints).
 *
 * Proven here against the real schema:
 *   - the discovery list aggregates per-category waiting counts + contact state from a task's geoid;
 *   - getDetail returns the task + existing per-category contacts + ST_X/ST_Y sample pins;
 *   - addNote persists + reads back the note via an audit_log discovery.note_added row (no notes column);
 *   - flagTask opens an abuse_flag against the sample report + moves the task to in_progress;
 *   - saveDraft upserts jurisdiction_contacts WITHOUT routing;
 *   - saveAndRoute upserts contacts (+ legacy mirror), sets contact_updated_at, resolves the discovery
 *     task, routes waiting reports (-> acknowledged + report_timeline), and audits in-tx (no outreach
 *     pre-stamp; the send window is started only on an actual digest send).
 *
 * When Docker is unavailable the whole describe block SKIPS (describe.skipIf), so the local suite stays
 * green; CI runs it for real. Reuses withPg() per the harness contract.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleDiscoveryRepository } from "../../src/services/admin/discovery-repository.drizzle.js"
import { makeDrizzleJurisdictionContactsRepository } from "../../src/services/admin/jurisdiction-contacts-repository.drizzle.js"
import type { DiscoveryRepository } from "../../src/services/admin/discovery-service.js"
import type { JurisdictionContactsRepository } from "../../src/services/admin/jurisdiction-contacts-service.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()

const GEOID = LA_CITY.geoid

/** Insert a report in the seeded jurisdiction and return its id. */
async function insertReport(
  h: PgHarness,
  opts: { category: string; status?: string; lng?: number; lat?: number },
): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO reports (idempotency_key, geom, geom_source, category, status, h3_cell, jurisdiction_geoid)
    VALUES (
      gen_random_uuid(),
      ST_SetSRID(ST_MakePoint(${opts.lng ?? -118.35}, ${opts.lat ?? 34.1}), 4326),
      'manual',
      ${opts.category},
      ${opts.status ?? "submitted"},
      'h0',
      ${GEOID}
    )
    RETURNING id
  `
  return rows[0]!.id
}

/** Insert an open discovery task for the seeded jurisdiction and return its id. */
async function insertTask(h: PgHarness, sampleReportId: string | null): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO jurisdiction_discovery_tasks (geoid, status, sample_report_id, population)
    VALUES (${GEOID}, 'open', ${sampleReportId}, 3900000)
    RETURNING id
  `
  return rows[0]!.id
}

describe.skipIf(!pg)("admin discovery + contacts repositories (integration: real schema)", () => {
  let h: PgHarness
  let discovery: DiscoveryRepository
  let contacts: JurisdictionContactsRepository

  beforeAll(() => {
    h = pg as PgHarness
    discovery = makeDrizzleDiscoveryRepository(h.sql)
    contacts = makeDrizzleJurisdictionContactsRepository(h.sql)
  })

  beforeEach(async () => {
    await h.sql`TRUNCATE jurisdiction_discovery_tasks, jurisdiction_contacts, report_timeline, abuse_flags, audit_log, outreach_state RESTART IDENTITY CASCADE`
    await h.sql`DELETE FROM reports`
    await h.sql`UPDATE jurisdictions SET contact_emails = NULL, report_form_url = NULL, contact_updated_at = NULL, notes = NULL WHERE geoid = ${GEOID}`
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("lists a task with per-category waiting counts + missing contact state", async () => {
    await insertReport(h, { category: "trash" })
    await insertReport(h, { category: "trash" })
    await insertReport(h, { category: "hazard" })
    // A resolved report must NOT count as waiting.
    await insertReport(h, { category: "trash", status: "resolved" })
    await insertTask(h, null)

    const { records } = await discovery.listTasks({
      q: null,
      filter: "all",
      sort: "pop",
      cursor: null,
      limit: 25,
    })
    expect(records).toHaveLength(1)
    const task = records[0]!
    expect(task.geoid).toBe(GEOID)
    expect(task.total).toBe(3)
    expect(task.perCategory.trash).toBe(2)
    expect(task.perCategory.hazard).toBe(1)
    expect(task.contactCategories).toEqual([])
  })

  it("getDetail returns existing contacts + sample pins", async () => {
    await insertReport(h, { category: "trash", lng: -118.4, lat: 34.05 })
    const taskId = await insertTask(h, null)
    await h.sql`
      INSERT INTO jurisdiction_contacts (geoid, category, email)
      VALUES (${GEOID}, 'trash', 'trash@lacity.gov')
    `

    const detail = await discovery.getDetail(taskId)
    expect(detail).not.toBeNull()
    expect(detail?.contacts).toContainEqual({ category: "trash", email: "trash@lacity.gov" })
    expect(detail?.samplePins).toHaveLength(1)
    expect(detail?.samplePins[0]?.category).toBe("trash")
    expect(detail?.samplePins[0]?.lat).toBeCloseTo(34.05, 4)
  })

  it("addNote persists + reads back via audit_log (no notes column)", async () => {
    const taskId = await insertTask(h, null)
    await discovery.addNote(taskId, { text: "Called the clerk", actorId: null, who: "jane" })

    const notes = await discovery.listNotes(taskId)
    expect(notes).toHaveLength(1)
    expect(notes[0]?.text).toBe("Called the clerk")
    expect(notes[0]?.who).toBe("jane")

    const audit = await h.sql<{ action: string; target: string }[]>`
      SELECT action, target FROM audit_log WHERE action = 'discovery.note_added'
    `
    expect(audit[0]?.target).toBe(`discovery:${taskId}`)
  })

  it("flagTask opens an abuse_flag on the sample report + moves the task to in_progress", async () => {
    const reportId = await insertReport(h, { category: "trash" })
    const taskId = await insertTask(h, reportId)

    const ok = await discovery.flagTask(taskId, { reason: "looks off", actorId: null })
    expect(ok).toBe(true)

    const flags = await h.sql<{ subject_id: string; reason: string }[]>`
      SELECT subject_id, reason FROM abuse_flags WHERE subject_type = 'report'
    `
    expect(flags[0]?.subject_id).toBe(reportId)
    const task = await h.sql<{ status: string }[]>`
      SELECT status FROM jurisdiction_discovery_tasks WHERE id = ${taskId}
    `
    expect(task[0]?.status).toBe("in_progress")
  })

  it("saveDraft upserts per-category contacts WITHOUT routing", async () => {
    await insertReport(h, { category: "trash" })
    const taskId = await insertTask(h, null)

    const ok = await discovery.saveDraft(taskId, {
      contacts: { trash: "trash@city.gov" },
      defaultEmails: [],
      formUrl: null,
      actorId: null,
    })
    expect(ok).toBe(true)

    const contactRows = await h.sql<{ category: string | null; email: string | null }[]>`
      SELECT category, email FROM jurisdiction_contacts WHERE geoid = ${GEOID}
    `
    expect(contactRows).toContainEqual({ category: "trash", email: "trash@city.gov" })
    // Draft does NOT route: the report stays submitted and the task stays open.
    const report = await h.sql<{ status: string }[]>`SELECT status FROM reports LIMIT 1`
    expect(report[0]?.status).toBe("submitted")
  })

  it("saveAndRoute upserts contacts, resolves the task, routes waiting reports, audits in-tx (no outreach pre-stamp)", async () => {
    const r1 = await insertReport(h, { category: "trash" })
    const r2 = await insertReport(h, { category: "hazard", status: "published" })
    await insertReport(h, { category: "trash", status: "resolved" })
    const taskId = await insertTask(h, null)

    const result = await contacts.saveAndRoute(
      GEOID,
      {
        contacts: { trash: "trash@lacity.gov" },
        defaultEmails: ["311@lacity.gov"],
        formUrl: null,
      },
      { actorId: "00000000-0000-0000-0000-000000000001" },
    )
    expect(result.taskResolved).toBe(true)
    expect(result.routedReports).toBe(2)

    // Contacts + legacy mirror.
    const cat = await h.sql<{ email: string }[]>`
      SELECT email FROM jurisdiction_contacts WHERE geoid = ${GEOID} AND category = 'trash'
    `
    expect(cat[0]?.email).toBe("trash@lacity.gov")
    const j = await h.sql<{ contact_emails: string[] | null; contact_updated_at: Date | null }[]>`
      SELECT contact_emails, contact_updated_at FROM jurisdictions WHERE geoid = ${GEOID}
    `
    expect(j[0]?.contact_emails).toContain("311@lacity.gov")
    expect(j[0]?.contact_updated_at).not.toBeNull()

    // Task resolved.
    const task = await h.sql<{ status: string }[]>`
      SELECT status FROM jurisdiction_discovery_tasks WHERE id = ${taskId}
    `
    expect(task[0]?.status).toBe("done")

    // Waiting reports routed (acknowledged + timeline); the resolved one untouched.
    const statuses = await h.sql<{ id: string; status: string }[]>`
      SELECT id, status FROM reports WHERE id IN (${r1}, ${r2})
    `
    expect(statuses.every((s) => s.status === "acknowledged")).toBe(true)
    const timeline = await h.sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM report_timeline WHERE status = 'acknowledged'
    `
    expect(Number(timeline[0]?.count)).toBe(2)

    // C1: save-and-route does NOT pre-stamp outreach_state - the send window is started only when a digest
    // is actually sent (so the immediate outreach is not throttled-by-construction).
    const outreach = await contacts.getOutreachState(GEOID)
    expect(outreach).toBeNull()

    // H4: the discovery.contacts_saved audit was written IN the same transaction as the routing effect.
    const audit = await h.sql<{ action: string; target: string }[]>`
      SELECT action, target FROM audit_log WHERE action = 'discovery.contacts_saved'
    `
    expect(audit[0]?.target).toBe(`jurisdiction:${GEOID}`)
  })

  it("listDirectory projects a routed jurisdiction with last-routed time", async () => {
    await insertReport(h, { category: "trash" })
    await insertTask(h, null)
    await contacts.saveAndRoute(
      GEOID,
      {
        contacts: {},
        defaultEmails: ["311@lacity.gov"],
        formUrl: null,
      },
      { actorId: "00000000-0000-0000-0000-000000000001" },
    )

    const { records } = await contacts.listDirectory({
      q: null,
      filter: "all",
      cursor: null,
      limit: 25,
    })
    const row = records.find((r) => r.geoid === GEOID)
    expect(row).toBeDefined()
    expect(row?.defaultEmails).toContain("311@lacity.gov")
    expect(row?.lastRoutedAt).not.toBeNull()
  })
})
