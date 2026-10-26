import type { LegalDocumentType } from "@civfix/contract"
import type { LegalBlock } from "@civfix/contract/legal"
import type { Sql } from "../db/client.js"
import {
  SERVED_LEGAL_TYPES,
  type LegalDocumentRecord,
  type LegalDocumentsRepository,
  type LegalVersionRecord,
} from "./legal-documents-repository.js"

interface VersionRow {
  type: LegalDocumentType
  version: string
  sha256: string
  effective_at: Date
  url: string
  title: string | null
  summary: string | null
  material: boolean | null
}

interface DocumentRow extends VersionRow {
  blocks: LegalBlock[] | null
}

function toVersion(row: VersionRow): LegalVersionRecord {
  return {
    type: row.type,
    version: row.version,
    sha256: row.sha256,
    effectiveAt: row.effective_at,
    url: row.url,
    title: row.title,
    summary: row.summary,
    material: row.material,
  }
}

function toRecord(row: DocumentRow): LegalDocumentRecord {
  return { ...toVersion(row), blocks: row.blocks }
}

export function makeLegalDocumentsRepository(sql: Sql): LegalDocumentsRepository {
  const types = SERVED_LEGAL_TYPES as LegalDocumentType[]

  return {
    async current(now: Date): Promise<LegalDocumentRecord[]> {
      // A second version written the same day is `-2`, `-3`, ...: the longer version string is the later
      // one, so `-10` still sorts after `-9`.
      const rows = await sql<DocumentRow[]>`
        SELECT d.type, d.version, d.sha256, d.effective_at, d.url, d.title, d.summary, d.material, d.blocks
        FROM (
          SELECT DISTINCT ON (type)
                 type, version, sha256, effective_at, url, title, summary, material, blocks
          FROM legal_documents
          WHERE type = ANY(${types}::text[]) AND effective_at <= ${now}
          ORDER BY type, effective_at DESC, length(version) DESC, version DESC
        ) d
        ORDER BY array_position(${types}::text[], d.type)
      `
      return rows.map(toRecord)
    },

    async find(type: LegalDocumentType, version: string): Promise<LegalDocumentRecord | null> {
      const rows = await sql<DocumentRow[]>`
        SELECT type, version, sha256, effective_at, url, title, summary, material, blocks
        FROM legal_documents
        WHERE type = ${type} AND version = ${version}
      `
      const row = rows[0]
      return row === undefined ? null : toRecord(row)
    },

    async listVersions(): Promise<LegalVersionRecord[]> {
      const rows = await sql<VersionRow[]>`
        SELECT type, version, sha256, effective_at, url, title, summary, material
        FROM legal_documents
        WHERE type = ANY(${types}::text[])
        ORDER BY effective_at DESC, array_position(${types}::text[], type),
                 length(version) DESC, version DESC
      `
      return rows.map(toVersion)
    },

    async listAll(): Promise<LegalDocumentRecord[]> {
      const rows = await sql<DocumentRow[]>`
        SELECT type, version, sha256, effective_at, url, title, summary, material, blocks
        FROM legal_documents
        WHERE type = ANY(${types}::text[])
      `
      return rows.map(toRecord)
    },

    async insert(records: readonly LegalDocumentRecord[]): Promise<void> {
      for (const record of records) {
        await sql`
          INSERT INTO legal_documents
            (type, version, sha256, effective_at, url, title, summary, material, blocks)
          VALUES (
            ${record.type}, ${record.version}, ${record.sha256}, ${record.effectiveAt}, ${record.url},
            ${record.title}, ${record.summary}, ${record.material},
            ${record.blocks === null ? null : sql.json(record.blocks)}
          )
        `
      }
    },
  }
}
