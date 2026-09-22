
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleDiscoveryRepository } from "../../src/services/admin/discovery-repository.drizzle.js"
import { makeDrizzleJurisdictionContactsRepository } from "../../src/services/admin/jurisdiction-contacts-repository.drizzle.js"
import type { DiscoveryRepository } from "../../src/services/admin/discovery-service.js"
import type { JurisdictionContactsRepository } from "../../src/services/admin/jurisdiction-contacts-service.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()

const GEOID = LA_CITY.geoid

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

async function insertWaitingReports(h: PgHarness, count: number): Promise<void> {
  await h.sql`
    INSERT INTO reports (idempotency_key, geom, geom_source, category, status, h3_cell, jurisdiction_geoid)
    SELECT
      gen_random_uuid(),
      ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326),
      'manual',
      'trash',
      'submitted',
      'h0',
      ${GEOID}
    FROM generate_series(1, ${count})
  `
}

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
    await h.sql`TRUNCATE jurisdiction_discovery_tasks, jurisdiction_contacts, report_timeline, abuse_flags, audit_log, outreach_state, mail_events, mail_messages, mail_threads RESTART IDENTITY CASCADE`
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
    const report = await h.sql<{ status: string }[]>`SELECT status FROM reports LIMIT 1`
    expect(report[0]?.status).toBe("submitted")
  })

  it("F010: saving only a form URL preserves the existing default email + its bounce marker", async () => {
    await insertReport(h, { category: "trash" })
    const taskId = await insertTask(h, null)

    await discovery.saveDraft(taskId, {
      contacts: {},
      defaultEmails: ["pw@city.gov"],
      formUrl: null,
      actorId: null,
    })
    await h.sql`UPDATE jurisdiction_contacts SET bounced_at = now() WHERE geoid = ${GEOID} AND category IS NULL`

    await discovery.saveDraft(taskId, {
      contacts: {},
      defaultEmails: [],
      formUrl: "https://city.gov/report",
      actorId: null,
    })

    const rows = await h.sql<
      { email: string | null; form_url: string | null; bounced_at: Date | null }[]
    >`
      SELECT email, form_url, bounced_at FROM jurisdiction_contacts WHERE geoid = ${GEOID} AND category IS NULL
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]?.email).toBe("pw@city.gov")
    expect(rows[0]?.form_url).toBe("https://city.gov/report")
    expect(rows[0]?.bounced_at).not.toBeNull()

    await discovery.saveDraft(taskId, {
      contacts: {},
      defaultEmails: ["pw@city.gov"],
      formUrl: null,
      actorId: null,
    })
    const after = await h.sql<{ bounced_at: Date | null; form_url: string | null }[]>`
      SELECT bounced_at, form_url FROM jurisdiction_contacts WHERE geoid = ${GEOID} AND category IS NULL
    `
    expect(after[0]?.bounced_at).toBeNull()
    expect(after[0]?.form_url).toBe("https://city.gov/report")
  })

  it("F156: list + detail agree on waiting counts (grouped-CTE aggregate, scoped per geoid)", async () => {
    await insertReport(h, { category: "trash" })
    await insertReport(h, { category: "trash" })
    await insertReport(h, { category: "hazard" })
    await insertReport(h, { category: "trash", status: "resolved" })
    const taskId = await insertTask(h, null)

    const { records } = await discovery.listTasks({
      q: null,
      filter: "all",
      sort: "pop",
      cursor: null,
      limit: 25,
    })
    expect(records).toHaveLength(1)
    expect(records[0]!.total).toBe(3)
    expect(records[0]!.perCategory.trash).toBe(2)
    expect(records[0]!.perCategory.hazard).toBe(1)

    const detail = await discovery.getDetail(taskId)
    expect(detail?.task.total).toBe(3)
    expect(detail?.task.perCategory.trash).toBe(2)
    expect(detail?.task.perCategory.hazard).toBe(1)
  })

  it("saveAndRoute upserts contacts, resolves the task, leaves every report alone, audits in-tx (no outreach pre-stamp)", async () => {
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
      { actorId: null },
    )
    expect(result.taskResolved).toBe(true)

    const cat = await h.sql<{ email: string }[]>`
      SELECT email FROM jurisdiction_contacts WHERE geoid = ${GEOID} AND category = 'trash'
    `
    expect(cat[0]?.email).toBe("trash@lacity.gov")
    const j = await h.sql<{ contact_emails: string[] | null; contact_updated_at: Date | null }[]>`
      SELECT contact_emails, contact_updated_at FROM jurisdictions WHERE geoid = ${GEOID}
    `
    expect(j[0]?.contact_emails).toContain("311@lacity.gov")
    expect(j[0]?.contact_updated_at).not.toBeNull()

    const task = await h.sql<{ status: string }[]>`
      SELECT status FROM jurisdiction_discovery_tasks WHERE id = ${taskId}
    `
    expect(task[0]?.status).toBe("done")

    const statuses = await h.sql<{ id: string; status: string }[]>`
      SELECT id, status FROM reports WHERE id IN (${r1}, ${r2})
    `
    expect(statuses.every((s) => s.status === "submitted" || s.status === "published")).toBe(true)
    const timeline = await h.sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM report_timeline WHERE status = 'acknowledged'
    `
    expect(Number(timeline[0]?.count)).toBe(0)

    const outreach = await contacts.getOutreachState(GEOID)
    expect(outreach).toBeNull()

    const audit = await h.sql<{ action: string; target: string }[]>`
      SELECT action, target FROM audit_log WHERE action = 'discovery.contacts_saved'
    `
    expect(audit[0]?.target).toBe(`jurisdiction:${GEOID}`)
  })

  it("leaves a large waiting backlog untouched (no status flip, no timeline rows, no drain)", async () => {
    const total = 25
    await insertWaitingReports(h, total)

    await contacts.saveAndRoute(
      GEOID,
      { contacts: { trash: "trash@lacity.gov" }, defaultEmails: [], formUrl: null },
      { actorId: null },
    )


    const waiting = await h.sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM reports
      WHERE jurisdiction_geoid = ${GEOID}
        AND deleted_at IS NULL
        AND status NOT IN ('rejected', 'resolved', 'acknowledged', 'in_progress')
    `
    expect(Number(waiting[0]!.count)).toBe(total)

    const timeline = await h.sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM report_timeline WHERE status = 'acknowledged'
    `
    expect(Number(timeline[0]!.count)).toBe(0)

    const audit = await h.sql<{ meta: { taskResolved: boolean } }[]>`
      SELECT meta FROM audit_log WHERE action = 'discovery.contacts_saved'
    `
    expect(audit).toHaveLength(1)
    expect(audit[0]!.meta).not.toHaveProperty("routedReports")

    const contactRow = await h.sql<{ email: string }[]>`
      SELECT email FROM jurisdiction_contacts WHERE geoid = ${GEOID} AND category = 'trash'
    `
    expect(contactRow[0]?.email).toBe("trash@lacity.gov")
  })

  it("listDirectory projects a routed jurisdiction with last-routed time", async () => {
    const reportId = await insertReport(h, { category: "trash", status: "acknowledged" })
    await h.sql`INSERT INTO report_timeline (report_id, status) VALUES (${reportId}, 'acknowledged')`
    await insertTask(h, null)
    await contacts.saveAndRoute(
      GEOID,
      {
        contacts: {},
        defaultEmails: ["311@lacity.gov"],
        formUrl: null,
      },
      { actorId: null },
    )

    const { records } = await contacts.listDirectory({
      q: null,
      filter: "all",
      sort: "population",
      layer: null,
      cursor: null,
      limit: 25,
    })
    const row = records.find((r) => r.geoid === GEOID)
    expect(row).toBeDefined()
    expect(row?.defaultEmails).toContain("311@lacity.gov")
    expect(row?.lastRoutedAt).not.toBeNull()
  })

  it("listDirectory returns total + routed/unrouted facets on the first page (cursor absent)", async () => {
    const res = await contacts.listDirectory({
      q: null,
      filter: "all",
      sort: "population",
      layer: null,
      cursor: null,
      limit: 25,
    })
    expect(typeof res.total).toBe("number")
    expect(res.total!).toBeGreaterThan(0)
    expect(res.facets).not.toBeNull()
    expect(res.facets!.routed + res.facets!.unrouted).toBe(res.total)
  })

  it("the routed/none filter splits jurisdictions by whether a contact is on file", async () => {
    await contacts.saveAndRoute(
      GEOID,
      { contacts: {}, defaultEmails: ["311@lacity.gov"], formUrl: null },
      { actorId: null },
    )
    const routed = await contacts.listDirectory({
      q: null,
      filter: "routed",
      sort: "population",
      layer: null,
      cursor: null,
      limit: 100,
    })
    expect(routed.records.some((r) => r.geoid === GEOID)).toBe(true)
    const none = await contacts.listDirectory({
      q: null,
      filter: "none",
      sort: "population",
      layer: null,
      cursor: null,
      limit: 100,
    })
    expect(none.records.some((r) => r.geoid === GEOID)).toBe(false)
  })

  describe("directory 'bounced' flag clears on a contact re-save", () => {
    async function seedBounceEvent(at: Date): Promise<void> {
      const rows = await h.sql<{ id: string }[]>`
        INSERT INTO mail_threads (thread_token, jurisdiction_geoid, subject, status)
        VALUES (${`tok-${at.getTime()}`}, ${GEOID}, 'Digest', 'bounced')
        RETURNING id
      `
      await h.sql`
        INSERT INTO mail_events (thread_id, type, created_at)
        VALUES (${rows[0]!.id}, 'bounced', ${at})
      `
    }

    async function directoryRow(): Promise<{ bounced: boolean } | undefined> {
      const { records } = await contacts.listDirectory({
        q: null,
        filter: "all",
        sort: "population",
        layer: null,
        cursor: null,
        limit: 100,
      })
      return records.find((r) => r.geoid === GEOID)
    }

    async function saveContact(email: string): Promise<void> {
      await contacts.saveAndRoute(
        GEOID,
        { contacts: {}, defaultEmails: [email], formUrl: null },
        { actorId: null },
      )
    }

    it("reads bounced from the per-contact stamp, then CLEARS it when a good address is re-saved", async () => {
      await saveContact("bad@lacity.gov")
      await h.sql`
        UPDATE jurisdiction_contacts SET bounced_at = now()
        WHERE geoid = ${GEOID} AND category IS NULL
      `
      expect((await directoryRow())?.bounced).toBe(true)

      await saveContact("good@lacity.gov")
      expect((await directoryRow())?.bounced).toBe(false)
      const stamps = await h.sql<{ bounced_at: Date | null }[]>`
        SELECT bounced_at FROM jurisdiction_contacts WHERE geoid = ${GEOID}
      `
      expect(stamps.every((s) => s.bounced_at === null)).toBe(true)
    })

    it("clears a mail_events-only bounce once the contact is saved AFTER the event", async () => {
      await seedBounceEvent(new Date(Date.now() - 60 * 60 * 1000))
      await h.sql`UPDATE jurisdictions SET contact_updated_at = NULL WHERE geoid = ${GEOID}`
      expect((await directoryRow())?.bounced).toBe(true)

      await saveContact("good@lacity.gov")
      expect((await directoryRow())?.bounced).toBe(false)
    })

    it("RE-flags when a bounce arrives after the last save (the fallback is not dead)", async () => {
      await saveContact("good@lacity.gov")
      expect((await directoryRow())?.bounced).toBe(false)
      await seedBounceEvent(new Date(Date.now() + 60 * 60 * 1000))
      expect((await directoryRow())?.bounced).toBe(true)
    })
  })

  it("getGeometry returns the simplified boundary + bbox + interior point for a seeded jurisdiction", async () => {
    const geo = await contacts.getGeometry(GEOID)
    expect(geo).not.toBeNull()
    expect(geo!.geoid).toBe(GEOID)
    expect(geo!.geometry.type).toMatch(/Polygon/)
    expect(Array.isArray(geo!.geometry.coordinates)).toBe(true)
    const [west, south, east, north] = geo!.bbox
    expect(west).toBeLessThanOrEqual(east)
    expect(south).toBeLessThanOrEqual(north)
    const [clng, clat] = geo!.centroid
    expect(clng).toBeGreaterThanOrEqual(west)
    expect(clng).toBeLessThanOrEqual(east)
    expect(clat).toBeGreaterThanOrEqual(south)
    expect(clat).toBeLessThanOrEqual(north)
  })

  it("getGeometry returns null for an unknown geoid", async () => {
    expect(await contacts.getGeometry("99999999")).toBeNull()
  })
})
