import { randomUUID } from "node:crypto"
import { readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { Sql } from "../../src/db/client.js"
import { pruneNonAuthoritativeJurisdictions } from "../../src/db/backfill-jurisdictions-core.js"
import { purgeDemo } from "../../src/db/seed-demo-la.js"
import { DEMO_EMAIL_DOMAIN } from "../../src/db/seed-demo-domain.js"
import { makeDrizzleFilingRepository } from "../../src/services/filings/filing-repository.drizzle.js"
import { withPg, type PgHarness } from "../helpers/pg.js"
import {
  defineFilingRepositoryCases,
  seedRow,
  type FilingSeedRow,
  type FilingWorld,
  type SeedReport,
} from "../helpers/filings/filing-repository-cases.js"

const pg = await withPg()

const DRIZZLE_DIR = fileURLToPath(new URL("../../drizzle/", import.meta.url))
const FILINGS_MIGRATION = readdirSync(DRIZZLE_DIR).find((f) =>
  /^\d{4}_report_filings\.sql$/.test(f),
)

const G = "FILING-G"
const G2 = "FILING-G2"
const STALE = "DEVFED-FILING"

type Row = Record<string, string | number | boolean | Date | string[] | null>

async function code(p: PromiseLike<unknown>): Promise<string | undefined> {
  try {
    await p
  } catch (err) {
    return (err as { code?: string }).code
  }
  return undefined
}

async function addJurisdiction(sql: Sql, geoid: string, name: string, layer = "place") {
  await sql`
    INSERT INTO jurisdictions (geoid, name, layer, priority)
    VALUES (${geoid}, ${name}, ${layer}, 0)
    ON CONFLICT (geoid) DO NOTHING
  `
}

async function addUser(sql: Sql, email: string | null = null): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (display_name, email) VALUES ('Filing Tester', ${email}) RETURNING id
  `
  return u!.id
}

async function addReport(
  sql: Sql,
  opts: SeedReport & { reporter?: string | null } = {},
): Promise<{ id: string; title: string | null; referenceCode: string }> {
  const referenceCode = `FT-${randomUUID().slice(0, 13)}`
  const title = opts.title ?? null
  const [r] = await sql<{ id: string }[]>`
    INSERT INTO reports (
      idempotency_key, geom, geom_source, category, type, status, h3_cell, jurisdiction_geoid,
      title, reference_code, deleted_at, verification_verdict, reporter_user_id
    )
    VALUES (
      gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326), 'manual', 'trash', 'dump',
      ${opts.status ?? "published"}, 'h0', ${opts.geoid === undefined ? G : opts.geoid},
      ${title}, ${referenceCode}, ${opts.deletedAt ?? null}, ${opts.verificationVerdict ?? null},
      ${opts.reporter ?? null}
    )
    RETURNING id
  `
  return { id: r!.id, title, referenceCode }
}

async function addFiling(sql: Sql, row: FilingSeedRow): Promise<string> {
  const [f] = await sql<{ id: string }[]>`
    INSERT INTO report_filings (
      report_id, geoid, category, route_category, channel, portal_host, form_url, status, method,
      reason, reason_detail, case_id, case_url, city_closed_at, attempts, run_id, next_attempt_at,
      ai_wait_since, script_version, dry_run, ticket_text, note, mail_thread_id, created_by,
      created_at, updated_at, submitted_at
    )
    VALUES (
      ${row.reportId}, ${row.geoid}, ${row.category}, ${row.routeCategory}, ${row.channel},
      ${row.portalHost}, ${row.formUrl}, ${row.status}, ${row.method}, ${row.reason},
      ${row.reasonDetail}, ${row.caseId}, ${row.caseUrl}, ${row.cityClosedAt}, ${row.attempts},
      ${row.runId}, ${row.nextAttemptAt}, ${row.aiWaitSince}, ${row.scriptVersion}, ${row.dryRun},
      ${row.ticketText}, ${row.note}, ${row.mailThreadId}, ${row.createdBy}, ${row.createdAt},
      ${row.updatedAt}, ${row.submittedAt}
    )
    RETURNING id
  `
  return f!.id
}

async function addMailThread(sql: Sql): Promise<string> {
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO mail_threads (thread_token) VALUES (${randomUUID()}) RETURNING id
  `
  return t!.id
}

async function addMailMessage(sql: Sql, threadId: string): Promise<string> {
  const [m] = await sql<{ id: string }[]>`
    INSERT INTO mail_messages (thread_id, direction) VALUES (${threadId}, 'in') RETURNING id
  `
  return m!.id
}

async function addInboundEmail(sql: Sql): Promise<string> {
  const [e] = await sql<{ id: string }[]>`
    INSERT INTO inbound_emails (message_id) VALUES (${`<${randomUUID()}@city.example.gov>`})
    RETURNING id
  `
  return e!.id
}

async function resetFilings(sql: Sql): Promise<void> {
  await sql`
    TRUNCATE filing_messages, filing_evidence, report_filings, filing_routes, report_timeline,
      audit_log
  `
  await sql`UPDATE filing_settings SET paused = false, updated_by = NULL, updated_at = now()`
}

async function pgWorld(h: PgHarness): Promise<FilingWorld> {
  await resetFilings(h.sql)
  await addJurisdiction(h.sql, G, "City of Los Angeles")
  await addJurisdiction(h.sql, G2, "G2 City")
  const actor = await addUser(h.sql)
  let statements = 0
  const counted = new Proxy(h.sql, {
    apply(target, thisArg, args) {
      statements += 1
      return Reflect.apply(target, thisArg, args) as unknown
    },
  })
  const sql = h.sql
  return {
    kind: "pg",
    repo: makeDrizzleFilingRepository(counted),
    G,
    G2,
    actor,
    queries: () => statements,
    report: (opts) => addReport(sql, opts),
    filing: (row) => addFiling(sql, row),
    async evidence(filingId, e) {
      await sql`
        INSERT INTO filing_evidence (filing_id, r2_key, kind, label, created_at)
        VALUES (${filingId}, ${e.r2Key}, ${e.kind}, ${e.label}, ${e.createdAt})
      `
    },
    mailThread: () => addMailThread(sql),
    mailMessage: (threadId) => addMailMessage(sql, threadId),
    inboundEmail: () => addInboundEmail(sql),
    async setReport(id, patch) {
      if (patch.status !== undefined) {
        await sql`UPDATE reports SET status = ${patch.status} WHERE id = ${id}`
      }
      if (patch.deletedAt !== undefined) {
        await sql`UPDATE reports SET deleted_at = ${patch.deletedAt} WHERE id = ${id}`
      }
      if (patch.verificationVerdict !== undefined) {
        await sql`
          UPDATE reports SET verification_verdict = ${patch.verificationVerdict} WHERE id = ${id}
        `
      }
    },
    async getReport(id) {
      const [r] = await sql<
        { status: string; deleted_at: Date | null; verification_verdict: string | null }[]
      >`SELECT status, deleted_at, verification_verdict FROM reports WHERE id = ${id}`
      return {
        status: r!.status,
        deletedAt: r!.deleted_at,
        verificationVerdict: r!.verification_verdict,
      }
    },
    async timeline(reportId) {
      const rows = await sql<
        { kind: string | null; status: string; note: string | null; actor_id: string | null }[]
      >`
        SELECT kind, status, note, actor_id FROM report_timeline
        WHERE report_id = ${reportId} ORDER BY created_at, id
      `
      return rows.map((r) => ({
        kind: r.kind,
        status: r.status,
        note: r.note,
        actorId: r.actor_id,
      }))
    },
    async audits() {
      const rows = await sql<{ action: string; actor_id: string | null; target: string | null }[]>`
        SELECT action, actor_id, target FROM audit_log ORDER BY created_at, id
      `
      return rows.map((r) => ({ action: r.action, actorId: r.actor_id, target: r.target }))
    },
    async filingIds(reportId) {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM report_filings WHERE report_id = ${reportId}
      `
      return rows.map((r) => r.id)
    },
    async messageCount() {
      const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM filing_messages`
      return n!.n
    },
  }
}

describe.skipIf(!pg)("filing tables (integration: migration)", () => {
  let h: PgHarness

  beforeAll(async () => {
    h = pg as PgHarness
    await addJurisdiction(h.sql, G, "City of Los Angeles")
    await addJurisdiction(h.sql, G2, "G2 City")
  })

  beforeEach(async () => {
    await resetFilings(h.sql)
  })

  async function insertFiling(overrides: Row): Promise<string | undefined> {
    const report = await addReport(h.sql)
    const row: Row = {
      report_id: report.id,
      geoid: G,
      category: "pothole",
      status: "submitted",
      ticket_text: "t",
      ...overrides,
    }
    return code(h.sql`INSERT INTO report_filings ${h.sql(row, Object.keys(row))}`)
  }

  it("T1: the migration applies a second time and seeds one settings row", async () => {
    expect(FILINGS_MIGRATION).toBeDefined()
    const text = await readFile(`${DRIZZLE_DIR}${FILINGS_MIGRATION}`, "utf8")
    await h.sql.begin((tx) => tx.unsafe(text))
    const tables = await h.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (
        'report_filings', 'filing_evidence', 'filing_routes', 'filing_settings', 'filing_messages'
      )
    `
    expect(tables).toHaveLength(5)
    const settings = await h.sql`SELECT id, paused FROM filing_settings`
    expect([...settings]).toEqual([{ id: 1, paused: false }])
  })

  it("T2: filing_settings is a singleton", async () => {
    expect(await code(h.sql`INSERT INTO filing_settings (id) VALUES (2)`)).toBe("23514")
  })

  it("T3: report_filings refuses values outside its CHECKs and NULL required columns", async () => {
    const refused: [Row, string][] = [
      [{ status: "done" }, "23514"],
      [{ method: "robot" }, "23514"],
      [{ reason: "bogus" }, "23514"],
      [{ channel: "fax" }, "23514"],
      [{ attempts: -1 }, "23514"],
      [{ case_id: "x".repeat(65) }, "23514"],
      [{ reason_detail: "x".repeat(501) }, "23514"],
      [{ note: "x".repeat(501) }, "23514"],
      [{ ticket_text: null }, "23502"],
      [{ status: null }, "23502"],
    ]
    for (const [overrides, expected] of refused) {
      expect(await insertFiling(overrides), JSON.stringify(overrides)).toBe(expected)
    }
  })

  it("T4: report_filings accepts every D15 value and fills its defaults", async () => {
    const accepted: Row[] = [
      ...["queued", "running", "submitted", "linked_existing", "needs_human", "cancelled"].map(
        (status) => ({ status }),
      ),
      ...["email", "script", "operator"].map((method) => ({ method })),
      ...["email", "portal", "manual"].map((channel) => ({ channel })),
      ...[
        "no_route",
        "route_disabled",
        "manual_route",
        "filing_off",
        "dry_run",
        "captcha",
        "login_required",
        "missing_info",
        "portal_error",
        "attempts_exhausted",
        "uncertain_submission",
        "ai_unavailable",
        "city_needs_info",
        "reopened_after_city_closed",
        "other",
      ].map((reason) => ({ reason })),
      { geoid: null, channel: null, method: null, reason: null },
      { case_id: "x".repeat(64) },
      { reason_detail: "x".repeat(500) },
    ]
    for (const overrides of accepted) {
      expect(await insertFiling(overrides), JSON.stringify(overrides)).toBeUndefined()
    }
    const defaults = await h.sql<{ ok: boolean }[]>`
      SELECT bool_and(
        attempts = 0 AND dry_run = false AND run_id IS NULL
          AND created_at IS NOT NULL AND updated_at IS NOT NULL
      ) AS ok, count(*)::int AS n
      FROM report_filings
    `
    expect(defaults[0]).toEqual({ ok: true, n: accepted.length })
  })

  it("T5: filing_evidence checks its kind and label", async () => {
    const report = await addReport(h.sql)
    const filing = await addFiling(h.sql, seedRow({ reportId: report.id, status: "submitted" }))
    const evidence = (kind: string, label: string) =>
      code(h.sql`
        INSERT INTO filing_evidence (filing_id, r2_key, kind, label)
        VALUES (${filing}, 'k', ${kind}, ${label})
      `)
    expect(await evidence("video", "x")).toBe("23514")
    expect(await evidence("screenshot", "x".repeat(121))).toBe("23514")
    expect(await evidence("screenshot", "x".repeat(120))).toBeUndefined()
  })

  it("T6: filing_routes refuses bad routes and a second route per (geoid, category)", async () => {
    const route = (row: Row) => {
      const full: Row = { geoid: G, category: null, channel: "email", ...row }
      return code(h.sql`INSERT INTO filing_routes ${h.sql(full, Object.keys(full))}`)
    }
    expect(await route({ category: "pothole" })).toBeUndefined()
    expect(await route({})).toBeUndefined()
    expect(await route({ category: "a", channel: "portal", form_url: null })).toBe("23514")
    expect(await route({ category: "b", channel: "sms" })).toBe("23514")
    const six = ["a.gov", "b.gov", "c.gov", "d.gov", "e.gov", "f.gov"]
    expect(await route({ category: "c", status_sender_domains: six })).toBe("23514")
    expect(await route({ category: "d", request_type_hint: "x".repeat(201) })).toBe("23514")
    expect(await route({ category: "pothole" })).toBe("23505")
    expect(await route({})).toBe("23505")
  })

  it("T7: filing_routes defaults include_link, enabled and status_sender_domains", async () => {
    await h.sql`
      INSERT INTO filing_routes (geoid, category, channel)
      VALUES (${G}, NULL, 'email'), (${G}, 'pothole', 'email'), (${G2}, NULL, 'email')
    `
    const rows = await h.sql<
      { include_link: boolean; enabled: boolean; status_sender_domains: string[] }[]
    >`SELECT include_link, enabled, status_sender_domains FROM filing_routes`
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(r).toEqual({ include_link: true, enabled: true, status_sender_domains: [] })
    }
  })

  it("T8: filing_messages links at most one message, each message once", async () => {
    const report = await addReport(h.sql)
    const filing = await addFiling(h.sql, seedRow({ reportId: report.id, status: "submitted" }))
    const e = await addInboundEmail(h.sql)
    const m = await addMailMessage(h.sql, await addMailThread(h.sql))
    const message = (row: Row) => {
      const full: Row = { filing_id: filing, ...row }
      return code(h.sql`INSERT INTO filing_messages ${h.sql(full, Object.keys(full))}`)
    }
    expect(await message({ inbound_email_id: e, mail_message_id: m })).toBe("23514")
    expect(await message({ inbound_email_id: e })).toBeUndefined()
    expect(await message({ inbound_email_id: e })).toBe("23505")
    expect(await message({ mail_message_id: m })).toBeUndefined()
    expect(await message({ mail_message_id: m })).toBe("23505")
    expect(await message({ summary: "x".repeat(281) })).toBe("23514")
    expect(await message({})).toBeUndefined()
    expect(await message({})).toBeUndefined()
  })

  it("T9: at most one active filing per report", async () => {
    const pair = async (first: string, second: string) => {
      const report = await addReport(h.sql)
      await addFiling(h.sql, seedRow({ reportId: report.id, status: first as "queued" }))
      return code(addFiling(h.sql, seedRow({ reportId: report.id, status: second as "queued" })))
    }
    expect(await pair("queued", "queued")).toBe("23505")
    expect(await pair("submitted", "queued")).toBeUndefined()
    expect(await pair("needs_human", "running")).toBe("23505")
  })

  it("T10: deleting the inbox row keeps the message link with a NULL inbox id", async () => {
    const report = await addReport(h.sql)
    const filing = await addFiling(h.sql, seedRow({ reportId: report.id, status: "submitted" }))
    const e = await addInboundEmail(h.sql)
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO filing_messages (filing_id, inbound_email_id, summary)
      VALUES (${filing}, ${e}, 'kept') RETURNING id
    `
    await h.sql`DELETE FROM inbound_emails WHERE id = ${e}`
    const [after] = await h.sql<{ inbound_email_id: string | null; summary: string }[]>`
      SELECT inbound_email_id, summary FROM filing_messages WHERE id = ${row!.id}
    `
    expect(after).toEqual({ inbound_email_id: null, summary: "kept" })
  })
})

describe.skipIf(!pg)("makeDrizzleFilingRepository (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  defineFilingRepositoryCases(() => pgWorld(h))

  it("T25: a refused transition write rolls back its audit and evidence", async () => {
    const w = await pgWorld(h)
    const r = await w.report()
    const id = await w.filing(seedRow({ reportId: r.id, geoid: G, status: "queued" }))
    const before = await w.repo.getById(id)
    const err = await code(
      w.repo.transition(id, {
        from: ["queued"],
        set: { status: "needs_human", reasonDetail: "x".repeat(501) },
        audit: { action: "report.status_changed", actorId: w.actor, target: `report:${r.id}` },
        evidence: [{ r2Key: "k", kind: "screenshot" }],
      }),
    )
    expect(err).toBe("23514")
    expect(await w.repo.getById(id)).toEqual(before)
    expect(await w.audits()).toEqual([])
    expect(await w.repo.listEvidence(id)).toEqual([])
  })

  it("T40: filings sharing updated_at to the microsecond page once each", async () => {
    const w = await pgWorld(h)
    const r = await w.report()
    const ids = [
      await w.filing(seedRow({ reportId: r.id, geoid: G, status: "cancelled" })),
      await w.filing(seedRow({ reportId: r.id, geoid: G, status: "cancelled" })),
    ]
    await h.sql`
      UPDATE report_filings SET updated_at = '2026-01-01T00:00:00.123456Z'::timestamptz
      WHERE id = ANY(${ids}::uuid[])
    `
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page = await w.repo.list({ group: "cancelled", limit: 1, cursor })
      seen.push(...page.records.map((f) => f.id))
      cursor = page.nextCursor
    } while (cursor !== null && seen.length <= ids.length)
    expect(seen.sort()).toEqual([...ids].sort())
  })
})

describe.skipIf(!pg)("jobs that delete filing FK targets (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("T58: the boundary prune drops a stale geoid's routes and unlinks its filings", async () => {
    await resetFilings(h.sql)
    await addJurisdiction(h.sql, STALE, STALE, "federal")
    await h.sql`
      INSERT INTO filing_routes (geoid, category, channel)
      VALUES (${STALE}, NULL, 'email'), (${STALE}, 'pothole', 'email')
    `
    const report = await addReport(h.sql, { geoid: null })
    const filing = await addFiling(
      h.sql,
      seedRow({ reportId: report.id, geoid: STALE, status: "submitted" }),
    )
    const state = async () => {
      const [s] = await h.sql<{ routes: number; geoid: string | null; jurisdictions: number }[]>`
        SELECT
          (SELECT count(*)::int FROM filing_routes WHERE geoid = ${STALE}) AS routes,
          (SELECT geoid FROM report_filings WHERE id = ${filing}) AS geoid,
          (SELECT count(*)::int FROM jurisdictions WHERE geoid = ${STALE}) AS jurisdictions
      `
      return s
    }

    const dry = await pruneNonAuthoritativeJurisdictions(h.sql, { apply: false })
    expect(dry.affected.filing_routes).toBe(2)
    expect(dry.affected.report_filings).toBe(1)
    expect(await state()).toEqual({ routes: 2, geoid: STALE, jurisdictions: 1 })

    const applied = await pruneNonAuthoritativeJurisdictions(h.sql, { apply: true })
    expect(applied.applied).toBe(true)
    expect(applied.affected.filing_routes).toBe(2)
    expect(applied.affected.report_filings).toBe(1)
    expect(await state()).toEqual({ routes: 0, geoid: null, jurisdictions: 0 })
  })

  it("T59: the demo purge deletes a demo report's filing rows and keeps real ones", async () => {
    await resetFilings(h.sql)
    await addJurisdiction(h.sql, G, "City of Los Angeles")
    const demoUser = await addUser(h.sql, `filer@${DEMO_EMAIL_DOMAIN}`)
    const demoReport = await addReport(h.sql, { reporter: demoUser })
    const demoFiling = await addFiling(
      h.sql,
      seedRow({ reportId: demoReport.id, geoid: G, status: "submitted" }),
    )
    await h.sql`
      INSERT INTO filing_evidence (filing_id, r2_key, kind) VALUES (${demoFiling}, 'k', 'screenshot')
    `
    const e = await addInboundEmail(h.sql)
    await h.sql`INSERT INTO filing_messages (filing_id, inbound_email_id) VALUES (${demoFiling}, ${e})`
    const realReport = await addReport(h.sql)
    const realFiling = await addFiling(
      h.sql,
      seedRow({ reportId: realReport.id, geoid: G, status: "submitted" }),
    )

    const counts = await h.sql.begin((tx) => purgeDemo(tx))
    expect(counts).toMatchObject({ filing_messages: 1, filing_evidence: 1, report_filings: 1 })
    const [left] = await h.sql<{ demo: number; real: number }[]>`
      SELECT
        (SELECT count(*)::int FROM report_filings WHERE id = ${demoFiling})
          + (SELECT count(*)::int FROM filing_evidence WHERE filing_id = ${demoFiling})
          + (SELECT count(*)::int FROM filing_messages WHERE filing_id = ${demoFiling}) AS demo,
        (SELECT count(*)::int FROM report_filings WHERE id = ${realFiling}) AS real
    `
    expect(left).toEqual({ demo: 0, real: 1 })
  })
})
