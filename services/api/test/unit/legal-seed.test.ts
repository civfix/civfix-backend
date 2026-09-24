import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { LEGAL_DOCUMENTS } from "@civfix/shared/legal"
import { LEGAL_DOCUMENT_TYPE_VALUES } from "../../src/db/schema/types-legal.js"
import {
  assertConsentVersionsCurrent,
  currentLegalDocument,
  legalDocumentVersions,
} from "../../src/services/legal-service.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const DRIZZLE = join(HERE, "../../drizzle")

const SEED_MIGRATIONS = [
  "0151_legal_documents_consents.sql",
  "0171_legal_documents_2026_09_16.sql",
  "0172_legal_documents_2026_09_21.sql",
] as const

const RETIRED_TYPES = ["donations", "org_donation_agreement", "donation_disclosure"] as const

interface SeedRow {
  type: string
  version: string
  sha256: string
  effectiveAt: string
  url: string
}

function rowsIn(file: string): SeedRow[] {
  const sql = readFileSync(join(DRIZZLE, file), "utf8")
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
  expect(rows.length, `${file} should seed at least one legal_documents row`).toBeGreaterThan(0)
  return rows
}

function seededRows(): SeedRow[] {
  return SEED_MIGRATIONS.flatMap(rowsIn)
}

function latestByType(type: string): SeedRow | undefined {
  return seededRows()
    .filter((row) => row.type === type)
    .sort((a, b) => Date.parse(a.effectiveAt) - Date.parse(b.effectiveAt))
    .at(-1)
}

describe("legal_documents seed", () => {
  it("seeds the latest version of every current LEGAL_DOCUMENTS entry", () => {
    for (const document of LEGAL_DOCUMENTS) {
      const row = latestByType(document.type)
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

  it("keeps every superseded row, because consent_records points at it", () => {
    const seeded = seededRows()
    for (const row of rowsIn(SEED_MIGRATIONS[0])) {
      expect(
        seeded.filter((entry) => entry.type === row.type && entry.version === row.version),
      ).toHaveLength(1)
    }
    for (const type of RETIRED_TYPES) {
      expect(
        seeded.some((row) => row.type === type),
        `retired type ${type} must keep its seeded row`,
      ).toBe(true)
    }
  })

  it("never re-seeds a (type, version) pair with a different hash", () => {
    const byKey = new Map<string, string>()
    for (const row of seededRows()) {
      const key = `${row.type}@${row.version}`
      const seen = byKey.get(key)
      expect(
        seen === undefined || seen === row.sha256,
        `${key} seeded twice with differing sha256`,
      ).toBe(true)
      byKey.set(key, row.sha256)
    }
  })

  it("publishes a version forward, never by rewriting an older one", () => {
    for (const document of LEGAL_DOCUMENTS) {
      const versions = seededRows()
        .filter((row) => row.type === document.type)
        .map((row) => Date.parse(row.effectiveAt))
      for (const effectiveAt of versions) {
        expect(effectiveAt).toBeLessThanOrEqual(Date.parse(document.effectiveAt))
      }
    }
  })

  it("serves the current version of each document from GET /legal/versions", () => {
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
      expect(served.filter((entry) => entry.type === document.type)).toHaveLength(1)
    }
  })

  it("rejects a consent claiming a superseded version", () => {
    for (const document of LEGAL_DOCUMENTS) {
      const superseded = seededRows().find(
        (row) => row.type === document.type && row.version !== document.version,
      )
      if (!superseded) continue
      expect(currentLegalDocument(document.type).version).toBe(document.version)
      expect(() =>
        assertConsentVersionsCurrent([{ type: document.type, version: superseded.version }]),
      ).toThrow()
    }
  })

  it("uses a 64-hex sha256 for every document, so a consent record can pin the exact text", () => {
    for (const document of LEGAL_DOCUMENTS) {
      expect(document.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
    for (const row of seededRows()) {
      expect(row.sha256, `${row.type}@${row.version}`).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})
