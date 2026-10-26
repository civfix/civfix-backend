import { afterAll, describe, expect, it } from "vitest"
import { LEGAL_DOCUMENTS } from "@civfix/contract/legal"
import { LEGAL_TEXTS } from "@civfix/contract/legal-texts"
import { withPg } from "../helpers/pg.js"

// The migration runner loads every contract version into legal_documents (DECISIONS §66), so after the
// harness's migrate the table must hold the contract exactly.

const pg = await withPg()

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
}

afterAll(async () => {
  await pg?.teardown()
})

describe.skipIf(!pg)("legal_documents after migrate + load", () => {
  it("T26: holds every contract version with matching fields, and nothing more of the served types", async () => {
    const rows = await pg!.sql<Row[]>`
      SELECT type, version, sha256, effective_at, url, title, summary, material, blocks
      FROM legal_documents
      WHERE type IN ('terms', 'privacy', 'cookies', 'subprocessors')
    `

    expect(rows).toHaveLength(LEGAL_DOCUMENTS.length)
    for (const entry of LEGAL_DOCUMENTS) {
      const key = `${entry.type}@${entry.version}`
      const matches = rows.filter((r) => r.type === entry.type && r.version === entry.version)
      expect(matches, key).toHaveLength(1)
      const row = matches[0] as Row
      expect(row.sha256, key).toBe(entry.sha256)
      expect(row.effective_at.getTime(), key).toBe(Date.parse(entry.effectiveAt))
      expect(row.url, key).toBe(entry.url)
      expect(row.title, key).toBe(entry.title ?? null)
      expect(row.summary, key).toBe(entry.summary ?? null)
      expect(row.material, key).toBe(entry.material ?? null)
      expect(row.blocks, key).toEqual(LEGAL_TEXTS[key] ?? null)
    }
  })
})
