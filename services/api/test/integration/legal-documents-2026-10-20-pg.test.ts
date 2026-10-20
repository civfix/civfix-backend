/**
 * drizzle/0197_legal_documents_2026_10_20.sql against a real database. The template every file clones
 * has already run the whole chain, so this applies the canonical file a second time, as the runner does
 * (one transaction, simple-query mode), and reads what `legal_documents` holds afterwards.
 */

import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"

const pg = await withPg()

const MIGRATION = fileURLToPath(
  new URL("../../drizzle/0197_legal_documents_2026_10_20.sql", import.meta.url),
)

describe.skipIf(!pg)("0197 legal_documents 2026-10-20 seed (integration)", () => {
  const h = pg as PgHarness

  afterAll(async () => {
    await h.teardown()
  })

  it("T2: one row per (type, version) after a re-run, and the 2026-09-21 hashes untouched", async () => {
    const text = await readFile(MIGRATION, "utf8")
    await h.sql.begin((tx) => tx.unsafe(text))

    const rows = await h.sql<{ type: string; version: string; sha256: string }[]>`
      SELECT type, version, sha256 FROM legal_documents
      WHERE type IN ('terms', 'privacy') AND version IN ('2026-09-21', '2026-10-20')
      ORDER BY type, version
    `
    expect(rows.map((row) => `${row.type}@${row.version}`)).toEqual([
      "privacy@2026-09-21",
      "privacy@2026-10-20",
      "terms@2026-09-21",
      "terms@2026-10-20",
    ])
    expect(rows.find((row) => row.type === "terms" && row.version === "2026-09-21")?.sha256).toBe(
      "52fe3908a8d7aa4427239a7555a2d7b2346d7a2b9730dfb539ecd157f6195772",
    )
    expect(rows.find((row) => row.type === "privacy" && row.version === "2026-09-21")?.sha256).toBe(
      "e7bb3df8d1bae0ebf3dac45021beb1f260c3035f2bf3cabd0201e2586eb2f127",
    )
  })
})
