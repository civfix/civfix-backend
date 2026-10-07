import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { pruneNonAuthoritativeJurisdictions } from "../../src/db/backfill-jurisdictions-core.js"
import type { Sql } from "../../src/db/client.js"
import { makeFakeSql, type RecordedStatement, type SqlHandler } from "../helpers/fake-sql.js"

const STALE_GEOID = "NPS-YELL"
const REPORT_ID = "11111111-1111-4111-8111-111111111111"
const CLEANUP_ID = "22222222-2222-4222-8222-222222222222"
const HOURS_ID = "33333333-3333-4333-8333-333333333333"
const USER_ID = "44444444-4444-4444-8444-444444444444"
const NEW_GEOID = "PADUS-1"

interface Harness {
  sql: Sql
  statements: RecordedStatement[]
  txSpan: () => { start: number; end: number }
}

function harness(handlers: SqlHandler[]): Harness {
  const fake = makeFakeSql(handlers)
  const tag = fake.sql as unknown as Record<string, unknown>
  tag.unsafe = (text: string) =>
    fake.sql(Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray)
  let start = -1
  let end = -1
  const begin = fake.sql.begin.bind(fake.sql)
  fake.sql.begin = async <T>(cb: (tx: typeof fake.sql) => Promise<T>): Promise<T> => {
    start = fake.statements.length
    const out = await begin(cb)
    end = fake.statements.length
    return out
  }
  return {
    sql: fake.sql as unknown as Sql,
    statements: fake.statements,
    txSpan: () => ({ start, end }),
  }
}

function pagedOnce(match: RegExp, rows: unknown[]): SqlHandler {
  let served = false
  return {
    match,
    rows: () => {
      if (served) return []
      served = true
      return rows
    },
  }
}

function staleWorld(): SqlHandler[] {
  return [
    { match: /SELECT geoid FROM jurisdictions/, rows: [{ geoid: STALE_GEOID }] },
    {
      match: /AS reports,/,
      rows: [
        {
          reports: 1,
          cleanups: 1,
          volunteer_hours: 1,
          gov_claims: 2,
          mail_threads: 3,
          user_jurisdiction_hours: 1,
          jurisdiction_contacts: 0,
          outreach_state: 0,
          jurisdiction_discovery_tasks: 0,
          jurisdictions: 1,
        },
      ],
    },
    { match: /UPDATE reports\s+SET jurisdiction_geoid = NULL/, rows: [{ id: REPORT_ID }] },
    { match: /UPDATE cleanups\s+SET jurisdiction_geoid = NULL/, rows: [{ id: CLEANUP_ID }] },
    { match: /UPDATE volunteer_hours\s+SET jurisdiction_geoid = NULL/, rows: [{ id: HOURS_ID }] },
    pagedOnce(/SELECT id\s+FROM reports/, [{ id: REPORT_ID }]),
    pagedOnce(/SELECT id\s+FROM cleanups/, [{ id: CLEANUP_ID }]),
    { match: /UPDATE reports t/, rows: [{ id: REPORT_ID }] },
    { match: /UPDATE cleanups t/, rows: [{ id: CLEANUP_ID }] },
    {
      match: /UPDATE volunteer_hours vh/,
      rows: [{ user_id: USER_ID, jurisdiction_geoid: NEW_GEOID, voided: false }],
    },
    {
      match: /INSERT INTO user_jurisdiction_hours/,
      rows: [{ user_id: USER_ID }],
    },
  ]
}

function indexOf(statements: RecordedStatement[], re: RegExp): number {
  return statements.findIndex((s) => re.test(s.sql))
}

function statementMatching(statements: RecordedStatement[], re: RegExp): RecordedStatement {
  const found = statements.find((s) => re.test(s.sql))
  expect(found, `no statement matched ${re}`).toBeDefined()
  return found!
}

const MUTATION_RE = /^\s*(UPDATE|DELETE|INSERT|LOCK)\b/

describe("pruneNonAuthoritativeJurisdictions", () => {
  it("only counts, and writes nothing, until the operator confirms", async () => {
    const h = harness(staleWorld())
    const result = await pruneNonAuthoritativeJurisdictions(h.sql, { apply: false })

    expect(result.applied).toBe(false)
    expect(result.staleGeoids).toEqual([STALE_GEOID])
    expect(result.affected.gov_claims).toBe(2)
    expect(result.affected.mail_threads).toBe(3)
    expect(h.statements.filter((s) => MUTATION_RE.test(s.sql))).toHaveLength(0)
  })

  it("does nothing beyond the lookup when no non-authoritative row exists", async () => {
    const h = harness([{ match: /SELECT geoid FROM jurisdictions/, rows: [] }])
    const result = await pruneNonAuthoritativeJurisdictions(h.sql, { apply: true })

    expect(result.staleGeoids).toEqual([])
    expect(result.reresolved).toBeNull()
    expect(h.statements).toHaveLength(1)
  })

  it("re-resolves exactly the rows it nulled, inside the prune's transaction", async () => {
    const h = harness(staleWorld())
    const result = await pruneNonAuthoritativeJurisdictions(h.sql, { apply: true })

    expect(result.applied).toBe(true)
    expect(result.reresolved).toEqual({
      reports: 1,
      cleanups: 1,
      volunteerHours: 1,
      rollups: 1,
    })

    const { start, end } = h.txSpan()
    const within = (re: RegExp) => {
      const i = indexOf(h.statements, re)
      expect(i, `missing ${re}`).toBeGreaterThanOrEqual(start)
      expect(i).toBeLessThan(end)
      return i
    }
    const pruneJurisdictions = within(/DELETE FROM jurisdictions/)
    const reportsResolve = within(/UPDATE reports t/)
    const cleanupsResolve = within(/UPDATE cleanups t/)
    const hoursResolve = within(/UPDATE volunteer_hours vh/)
    const rollup = within(/INSERT INTO user_jurisdiction_hours/)
    expect(reportsResolve).toBeGreaterThan(pruneJurisdictions)
    expect(cleanupsResolve).toBeGreaterThan(pruneJurisdictions)
    expect(hoursResolve).toBeGreaterThan(cleanupsResolve)
    expect(hoursResolve).toBeGreaterThan(reportsResolve)
    expect(rollup).toBeGreaterThan(hoursResolve)

    expect(statementMatching(h.statements, /SELECT id\s+FROM reports/).values).toContainEqual([
      REPORT_ID,
    ])
    expect(statementMatching(h.statements, /SELECT id\s+FROM cleanups/).values).toContainEqual([
      CLEANUP_ID,
    ])
    expect(statementMatching(h.statements, /UPDATE volunteer_hours vh/).values).toContainEqual([
      HOURS_ID,
    ])
  })

  it("rebuilds the rollup from the ledger instead of adding to it", async () => {
    const h = harness(staleWorld())
    await pruneNonAuthoritativeJurisdictions(h.sql, { apply: true })

    const rollup = statementMatching(h.statements, /INSERT INTO user_jurisdiction_hours/)
    expect(rollup.sql).toMatch(/SUM\(vh\.hours\)/)
    expect(rollup.sql).toMatch(/voided_at IS NULL/)
    expect(rollup.sql).toMatch(/total_hours = EXCLUDED\.total_hours/)
    expect(rollup.sql).not.toMatch(/user_jurisdiction_hours\.total_hours \+/)
    expect(rollup.values).toContainEqual([USER_ID])
    expect(rollup.values).toContainEqual([NEW_GEOID])
  })

  it("locks the hours ledger then the rollup before touching either", async () => {
    const h = harness(staleWorld())
    await pruneNonAuthoritativeJurisdictions(h.sql, { apply: true })

    const lock = indexOf(
      h.statements,
      /LOCK TABLE volunteer_hours, user_jurisdiction_hours IN SHARE ROW EXCLUSIVE MODE/,
    )
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(lock).toBeLessThan(indexOf(h.statements, /UPDATE volunteer_hours\s+SET/))
  })
})

describe("refresh-boundaries: the prune needs --yes", () => {
  const script = readFileSync(
    fileURLToPath(new URL("../../scripts/refresh-boundaries.ts", import.meta.url)),
    "utf8",
  ).replace(/\s+/g, " ")

  it("delegates to the importable prune core and gates it on --yes", () => {
    expect(script).toContain("pruneNonAuthoritativeJurisdictions(")
    expect(script).toContain('includes("--yes")')
  })
})
