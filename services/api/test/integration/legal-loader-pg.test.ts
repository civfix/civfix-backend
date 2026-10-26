import { afterAll, describe, expect, it } from "vitest"
import { applyMigrations } from "../../src/db/migrate.js"
import { loadLegalDocuments } from "../../src/services/legal-loader.js"
import { makeLegalDocumentsRepository } from "../../src/services/legal-documents-repository.drizzle.js"
import { withPg } from "../helpers/pg.js"
import { NEW_BLOCKS, NEW_TERMS, PRE_EPIC, keyOf } from "../helpers/legal-fixtures.js"

const pg = await withPg()

const MIGRATE_ADVISORY_LOCK_KEY = 4747120626

// The retired rows 0151 seeded, which no contract entry describes.
const RETIRED_SEED = [
  ["donations", "461190ba108e771ff6a3c89cec0b5451bf5d05ff89e33231ff4c5493e0723544", "donations"],
  [
    "org_donation_agreement",
    "9b6592f3d5218c4a275577e6ab56ee5d08cd15e0c59b562800f537c21567149e",
    "org-donation-agreement",
  ],
  [
    "donation_disclosure",
    "d5f86995dd134183128d16526d50a4676c09e25dc3ea5d8eb9c6f9dcdfd2fa10",
    "donation-disclosure",
  ],
].map(([type, sha256, slug]) => ({
  type: type as string,
  version: "2026-09-06",
  sha256: sha256 as string,
  effectiveAt: "2026-09-06T00:00:00.000Z",
  url: `https://civfix.org/legal/${slug as string}`,
}))

interface Row {
  type: string
  version: string
  sha256: string
  effective_at: Date
  url: string
  title: string | null
  summary: string | null
  material: boolean | null
  blocks: unknown
  created_at: Date
}

afterAll(async () => {
  await pg?.teardown()
})

describe.skipIf(!pg)("legal documents migration and loader (Postgres)", () => {
  const sql = pg!.sql

  async function allRows(): Promise<Row[]> {
    return sql<Row[]>`SELECT * FROM legal_documents ORDER BY type, version`
  }

  it("T8: adds the four nullable columns and leaves every seeded row as seeded", async () => {
    const columns = await sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'legal_documents' AND column_name IN ('title', 'summary', 'material', 'blocks')
      ORDER BY column_name
    `
    expect(columns).toEqual([
      { column_name: "blocks", data_type: "jsonb", is_nullable: "YES" },
      { column_name: "material", data_type: "boolean", is_nullable: "YES" },
      { column_name: "summary", data_type: "text", is_nullable: "YES" },
      { column_name: "title", data_type: "text", is_nullable: "YES" },
    ])

    const rows = await allRows()
    const seeded = [...PRE_EPIC, ...RETIRED_SEED]
    expect(rows).toHaveLength(13)
    for (const entry of seeded) {
      const row = rows.find((r) => r.type === entry.type && r.version === entry.version)
      expect(row, keyOf(entry)).toBeDefined()
      expect(row).toMatchObject({
        sha256: entry.sha256,
        url: entry.url,
        title: null,
        summary: null,
        material: null,
        blocks: null,
      })
      expect(row?.effective_at.getTime()).toBe(Date.parse(entry.effectiveAt))
    }
  })

  it("T9: a second run applies nothing and changes no row", async () => {
    const before = await allRows()

    expect(await applyMigrations(sql)).toEqual([])
    expect(await allRows()).toEqual(before)
  })

  it("T10: a hand-edited row stops the run, and the migration lock is released", async () => {
    await sql`
      UPDATE legal_documents SET url = 'https://example.org'
      WHERE type = 'terms' AND version = '2026-09-21'
    `

    const err = await applyMigrations(sql).then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain("terms")
    expect((err as Error).message).toContain("2026-09-21")
    expect((err as Error).message).toContain("url")

    const held = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND ((classid::bigint << 32) | objid::bigint) = ${MIGRATE_ADVISORY_LOCK_KEY}::bigint
    `
    expect(held[0]?.n).toBe(0)

    await sql`
      UPDATE legal_documents SET url = 'https://civfix.org/legal/terms'
      WHERE type = 'terms' AND version = '2026-09-21'
    `
    expect(await applyMigrations(sql)).toEqual([])
  })

  it("T11: loads a new-style version with its blocks through jsonb, once", async () => {
    const repo = makeLegalDocumentsRepository(sql)
    const versions = [...PRE_EPIC, NEW_TERMS]
    const texts = { [keyOf(NEW_TERMS)]: NEW_BLOCKS }

    await loadLegalDocuments(repo, versions, texts)

    const [row] = await sql<Row[]>`
      SELECT * FROM legal_documents WHERE type = 'terms' AND version = ${NEW_TERMS.version}
    `
    expect(row?.blocks).toEqual(NEW_BLOCKS)
    expect(row?.material).toBe(false)
    expect(await loadLegalDocuments(repo, versions, texts)).toEqual([])
  })
})
