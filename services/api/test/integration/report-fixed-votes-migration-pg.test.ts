/**
 * drizzle/0198_report_fixed_votes.sql against a real database. The template every other file clones
 * already has 0198 applied, so this file first takes its own database back to 0195 (drops what 0198
 * adds), then applies the canonical file as the runner does (one transaction, simple-query mode), twice.
 */

import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"

const pg = await withPg()

const MIGRATION = fileURLToPath(
  new URL("../../drizzle/0198_report_fixed_votes.sql", import.meta.url),
)

describe.skipIf(!pg)("0198 report fixed votes migration (integration)", () => {
  let h: PgHarness
  let text: string

  beforeAll(async () => {
    h = pg as PgHarness
    text = await readFile(MIGRATION, "utf8")
  })

  afterAll(async () => {
    await h.teardown()
  })

  const apply = () => h.sql.begin((tx) => tx.unsafe(text))

  async function backTo0195(): Promise<void> {
    await h.sql`DROP INDEX IF EXISTS report_confirmations_report_created_idx`
    await h.sql`ALTER TABLE report_confirmations DROP COLUMN IF EXISTS kind`
    await h.sql`ALTER TABLE reports DROP COLUMN IF EXISTS fixed_count`
  }

  async function shape() {
    const columns = await h.sql`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name = 'report_confirmations'
             OR (table_name = 'reports' AND column_name IN ('confirm_count', 'fixed_count')))
      ORDER BY table_name, ordinal_position
    `
    const constraints = await h.sql`
      SELECT contype, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE conrelid = to_regclass('report_confirmations')
      ORDER BY contype, def
    `
    const indexes = await h.sql<{ tablename: string; indexdef: string }[]>`
      SELECT tablename, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename IN ('reports', 'report_confirmations')
      ORDER BY tablename, indexname
    `
    return { columns: [...columns], constraints: [...constraints], indexes: [...indexes] }
  }

  it("T27: existing rows become 'seen', a re-run changes nothing, and other kinds are rejected", async () => {
    await backTo0195()
    const [user] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES ('Voter', ${testHandle()}) RETURNING id
    `
    const [report] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, h3_cell, confirm_count)
      VALUES (gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.3, 34.1), 4326), 'device', 'trash', 'dump',
              'published', 'h0', 1)
      RETURNING id
    `
    await h.sql`
      INSERT INTO report_confirmations (report_id, user_id) VALUES (${report!.id}, ${user!.id})
    `
    const reportIndexesBefore = (await shape()).indexes.filter((i) => i.tablename === "reports")

    await apply()
    const after = await shape()

    expect(after.columns.map((c) => Object.values(c))).toEqual([
      ["report_confirmations", "report_id", "uuid", "NO", null],
      ["report_confirmations", "user_id", "uuid", "NO", null],
      ["report_confirmations", "created_at", "timestamp with time zone", "NO", "now()"],
      ["report_confirmations", "kind", "text", "NO", "'seen'::text"],
      ["reports", "confirm_count", "integer", "NO", "0"],
      ["reports", "fixed_count", "integer", "NO", "0"],
    ])
    expect(after.constraints).toContainEqual({
      contype: "c",
      def: "CHECK ((kind = ANY (ARRAY['seen'::text, 'fixed'::text])))",
    })
    expect(after.constraints).toContainEqual({
      contype: "p",
      def: "PRIMARY KEY (report_id, user_id)",
    })
    expect(after.indexes.map((i) => i.indexdef)).toContainEqual(
      expect.stringMatching(
        /ON public\.report_confirmations USING btree \(report_id, created_at DESC\)$/,
      ),
    )
    expect(after.indexes.filter((i) => i.tablename === "reports")).toEqual(reportIndexesBefore)

    const rows = await h.sql<{ kind: string }[]>`
      SELECT kind FROM report_confirmations WHERE report_id = ${report!.id}
    `
    expect(rows.map((r) => r.kind)).toEqual(["seen"])
    const [counts] = await h.sql<{ confirm_count: number; fixed_count: number }[]>`
      SELECT confirm_count, fixed_count FROM reports WHERE id = ${report!.id}
    `
    expect(counts).toEqual({ confirm_count: 1, fixed_count: 0 })

    await apply()
    expect(await shape()).toEqual(after)
    expect(
      (await h.sql`SELECT kind FROM report_confirmations WHERE report_id = ${report!.id}`).map(
        (r) => r.kind,
      ),
    ).toEqual(["seen"])

    await expect(
      h.sql`UPDATE report_confirmations SET kind = 'gone' WHERE report_id = ${report!.id}`,
    ).rejects.toMatchObject({ code: "23514" })
  })

  it("sets lock_timeout = '3s' before its first statement on reports", () => {
    const statements = text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s !== "")
    const timeout = statements.indexOf("SET LOCAL lock_timeout = '3s'")
    expect(timeout).toBeGreaterThanOrEqual(0)
    expect(statements.findIndex((s) => /\breports\b/.test(s))).toBeGreaterThan(timeout)
  })
})
