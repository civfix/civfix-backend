import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { LEGAL_DOCUMENTS } from "@civfix/shared/legal"
import { LEGAL_DOCUMENT_TYPE_VALUES } from "../../src/db/schema/types-legal.js"
import { legalDocumentVersions } from "../../src/services/legal-service.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATION = join(HERE, "../../drizzle/0151_legal_documents_consents.sql")

interface SeedRow {
  type: string
  version: string
  sha256: string
  effectiveAt: string
  url: string
}

function seededRows(): SeedRow[] {
  const sql = readFileSync(MIGRATION, "utf8")
  const insert = sql.slice(sql.indexOf("INSERT INTO legal_documents"))
  const values = insert.slice(0, insert.indexOf("ON CONFLICT"))
  const rows: SeedRow[] = []
  const rowRe = /\(\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)'\s*\)/g
  for (const match of values.matchAll(rowRe)) {
    rows.push({
      type: match[1] as string,
      version: match[2] as string,
      sha256: match[3] as string,
      effectiveAt: match[4] as string,
      url: match[5] as string,
    })
  }
  return rows
}

describe("legal_documents seed", () => {
  it("seeds every current LEGAL_DOCUMENTS entry", () => {
    const seeded = seededRows()
    for (const document of LEGAL_DOCUMENTS) {
      const row = seeded.find((entry) => entry.type === document.type)
      expect(row, `missing seed row for ${document.type}`).toBeDefined()
      expect(row?.version).toBe(document.version)
      expect(row?.sha256).toBe(document.sha256)
      expect(new Date(row?.effectiveAt ?? "").toISOString()).toBe(
        new Date(document.effectiveAt).toISOString(),
      )
      expect(row?.url).toBe(document.url)
    }
  })

  it("covers every LegalDocumentType the schema mirror knows about", () => {
    const seededTypes = seededRows().map((row) => row.type)
    const missing = LEGAL_DOCUMENT_TYPE_VALUES.filter((type) => !seededTypes.includes(type))
    expect(missing).toEqual([])
  })

  it("serves the same set from GET /legal/versions", () => {
    const served = legalDocumentVersions()
    expect(served).toHaveLength(LEGAL_DOCUMENTS.length)
    for (const document of LEGAL_DOCUMENTS) {
      expect(served).toContainEqual({
        type: document.type,
        version: document.version,
        sha256: document.sha256,
        effectiveAt: document.effectiveAt,
        url: document.url,
      })
    }
  })

  it("uses a 64-hex sha256 for every document, so a consent record can pin the exact text", () => {
    for (const document of LEGAL_DOCUMENTS) {
      expect(document.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})
