import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import postgres from "postgres"
import { withPg, type PgHarness } from "../helpers/pg.js"
import type { Sql } from "../../src/db/client.js"
import { makeDrizzleReportThreadsSource } from "../../src/services/threads-repository.drizzle.js"

const pg = await withPg()

interface PlanNode {
  "Node Type": string
  "Actual Loops"?: number
  "Relation Name"?: string
  Alias?: string
  Plans?: PlanNode[]
}

interface FlatNode {
  node: PlanNode
  belowLimit: boolean
}

function flatten(node: PlanNode, belowLimit: boolean, out: FlatNode[] = []): FlatNode[] {
  out.push({ node, belowLimit })
  const nextBelow = belowLimit || node["Node Type"] === "Limit"
  for (const child of node.Plans ?? []) flatten(child, nextBelow, out)
  return out
}

function isMessageProbe(node: PlanNode): boolean {
  return (node["Relation Name"] ?? "").startsWith("chat_messages") || node.Alias === "cm"
}

describe.skipIf(!pg)("threads inbox last-message LATERAL (integration)", () => {
  let h: PgHarness
  let captured: { query: string; params: unknown[] } | null = null
  let debugSql: Sql

  beforeAll(() => {
    h = pg as PgHarness
    debugSql = postgres(h.uri, {
      max: 1,
      onnotice: () => {},
      debug: (_conn: number, query: string, params: unknown[]) => {
        if (query.includes("report_chat_members")) captured = { query, params }
      },
    }) as unknown as Sql
  })

  afterAll(async () => {
    await debugSql.end()
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id
    `
    return u!.id
  }

  async function newReportRoom(member: string, index: number): Promise<void> {
    const [r] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, visibility, h3_cell)
      VALUES (
        ${randomUUID()}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'dump',
        'published', 'public', 'h0'
      )
      RETURNING id
    `
    const reportId = r!.id
    await h.sql`
      INSERT INTO report_chat_members (report_id, user_id, role, joined_at)
      VALUES (${reportId}, ${member}, 'member', now() - interval '1 day')
    `
    await h.sql`
      INSERT INTO chat_messages (report_id, sender_id, body, kind, created_at)
      VALUES (${reportId}, NULL, ${`msg ${index}`}, 'system', now() - make_interval(mins => ${index}))
    `
  }

  it("F027: the last-message body is fetched for PAGE rows only, above the LIMIT", async () => {
    const me = await newUser("Heavy Joiner")
    const rooms = 12
    for (let i = 0; i < rooms; i++) await newReportRoom(me, i)

    const limit = 3
    const rows = await makeDrizzleReportThreadsSource(debugSql).listReportThreadsFor(me, limit)
    expect(rows).toHaveLength(limit)

    expect(captured, "the inbox query was not captured").not.toBeNull()
    const plan = await h.sql.unsafe(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${captured!.query}`,
      captured!.params as never[],
    )
    const root = (plan[0] as unknown as { "QUERY PLAN": { Plan: PlanNode }[] })["QUERY PLAN"][0]!
      .Plan
    const probes = flatten(root, false).filter((f) => isMessageProbe(f.node))
    expect(probes.length).toBeGreaterThan(0)

    const abovePage = probes.filter((f) => !f.belowLimit)
    expect(abovePage.length, "no chat_messages probe runs on the LIMITed page").toBeGreaterThan(0)
    for (const probe of abovePage) {
      expect(probe.node["Actual Loops"] ?? 0).toBeLessThanOrEqual(limit)
    }
  })
})
