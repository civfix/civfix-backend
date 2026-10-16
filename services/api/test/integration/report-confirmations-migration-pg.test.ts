/**
 * drizzle/0194_report_confirmations.sql against a real database. The template every other file clones
 * already has 0194 applied, so this file first takes its own database back to 0193 (drops what 0194
 * adds), then applies the canonical file as the runner does (one transaction, simple-query mode), twice.
 */

import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import postgres from "postgres"
import { withPg, type PgHarness } from "../helpers/pg.js"

const pg = await withPg()

const MIGRATION = fileURLToPath(
  new URL("../../drizzle/0194_report_confirmations.sql", import.meta.url),
)

describe.skipIf(!pg)("0194 report_confirmations migration (integration)", () => {
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

  async function backTo0193(): Promise<void> {
    await h.sql`DROP TABLE IF EXISTS report_confirmations`
    await h.sql`ALTER TABLE reports DROP COLUMN IF EXISTS confirm_count`
  }

  async function shape() {
    const columns = await h.sql`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name = 'report_confirmations' OR (table_name = 'reports' AND column_name = 'confirm_count'))
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

  it("T41: applies on a database at 0193, exactly as D3 specifies, and re-applies as a no-op", async () => {
    await backTo0193()
    const [existing] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, h3_cell)
      VALUES (gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.3, 34.1), 4326), 'device', 'trash', 'dump',
              'published', 'h0')
      RETURNING id
    `
    const reportIndexesBefore = (await shape()).indexes

    await apply()
    const after = await shape()

    const idTypes = await h.sql<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'id' AND table_name IN ('reports', 'users')
    `
    expect(idTypes.map((c) => c.data_type)).toEqual(["uuid", "uuid"])
    expect(after.columns.map((c) => Object.values(c))).toEqual([
      ["report_confirmations", "report_id", "uuid", "NO", null],
      ["report_confirmations", "user_id", "uuid", "NO", null],
      ["report_confirmations", "created_at", "timestamp with time zone", "NO", "now()"],
      ["reports", "confirm_count", "integer", "NO", "0"],
    ])
    expect(after.constraints).toEqual([
      { contype: "f", def: "FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE" },
      { contype: "f", def: "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE" },
      { contype: "p", def: "PRIMARY KEY (report_id, user_id)" },
    ])
    expect(after.indexes.map((i) => i.indexdef)).toContainEqual(
      expect.stringMatching(/ON public\.report_confirmations USING btree \(user_id, created_at\)$/),
    )
    expect(after.indexes.filter((i) => i.tablename === "reports")).toEqual(
      reportIndexesBefore.filter((i) => i.tablename === "reports"),
    )
    const [row] = await h.sql<{ confirm_count: number }[]>`
      SELECT confirm_count FROM reports WHERE id = ${existing!.id}
    `
    expect(row?.confirm_count).toBe(0)

    await apply()
    expect(await shape()).toEqual(after)
  })

  it("T41: sets lock_timeout = '3s' before its first statement on reports", () => {
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

  it("fails fast instead of queueing behind a long reader of reports", async () => {
    await backTo0193()
    const reader = postgres(h.uri, { max: 1, onnotice: () => {} })
    try {
      const held = reader.begin(async (tx) => {
        await tx`SELECT 1 FROM reports LIMIT 1`
        await new Promise((resolve) => setTimeout(resolve, 6000))
      })
      await new Promise((resolve) => setTimeout(resolve, 200))
      const started = Date.now()
      await expect(apply()).rejects.toMatchObject({ code: "55P03" })
      expect(Date.now() - started).toBeLessThan(5000)
      await held
    } finally {
      await reader.end({ timeout: 5 })
    }
    await apply()
  }, 15_000)
})
