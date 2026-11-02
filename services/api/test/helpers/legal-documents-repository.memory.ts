import type { LegalDocumentType } from "@civfix/contract"
import {
  SERVED_LEGAL_TYPES,
  type LegalDocumentRecord,
  type LegalDocumentsRepository,
  type LegalVersionRecord,
} from "../../src/services/legal-documents-repository.js"

/** A stored row: `type` may be a retired one, which the repository never returns. */
export interface StoredLegalDocument extends Omit<LegalDocumentRecord, "type"> {
  type: string
  createdAt: Date
}

function isServed(
  row: StoredLegalDocument,
): row is StoredLegalDocument & { type: LegalDocumentType } {
  return (SERVED_LEGAL_TYPES as readonly string[]).includes(row.type)
}

// Same order as the SQL: newest effectiveAt first, then type order, then the later same-day version.
function newestFirst(a: StoredLegalDocument, b: StoredLegalDocument): number {
  return (
    b.effectiveAt.getTime() - a.effectiveAt.getTime() ||
    (SERVED_LEGAL_TYPES as readonly string[]).indexOf(a.type) -
      (SERVED_LEGAL_TYPES as readonly string[]).indexOf(b.type) ||
    b.version.length - a.version.length ||
    (a.version < b.version ? 1 : a.version > b.version ? -1 : 0)
  )
}

function toRecord(row: StoredLegalDocument & { type: LegalDocumentType }): LegalDocumentRecord {
  const { createdAt: _createdAt, ...record } = row
  return structuredClone(record)
}

function toVersion(row: StoredLegalDocument & { type: LegalDocumentType }): LegalVersionRecord {
  const { blocks: _blocks, ...version } = toRecord(row)
  return version
}

export class InMemoryLegalDocumentsRepository implements LegalDocumentsRepository {
  readonly rows: StoredLegalDocument[]
  readonly inserted: LegalDocumentRecord[][] = []

  constructor(
    rows: readonly StoredLegalDocument[] = [],
    private readonly now: () => Date = () => new Date(),
  ) {
    this.rows = rows.map((row) => structuredClone(row))
  }

  current(now: Date): Promise<LegalDocumentRecord[]> {
    const inEffect = this.served()
      .filter((row) => row.effectiveAt.getTime() <= now.getTime())
      .sort(newestFirst)
    const current = SERVED_LEGAL_TYPES.flatMap((type) => {
      const row = inEffect.find((candidate) => candidate.type === type)
      return row === undefined ? [] : [toRecord(row)]
    })
    return Promise.resolve(current)
  }

  find(type: LegalDocumentType, version: string): Promise<LegalDocumentRecord | null> {
    const row = this.served().find((r) => r.type === type && r.version === version)
    return Promise.resolve(row === undefined ? null : toRecord(row))
  }

  listVersions(): Promise<LegalVersionRecord[]> {
    return Promise.resolve(this.served().sort(newestFirst).map(toVersion))
  }

  listAll(): Promise<LegalDocumentRecord[]> {
    return Promise.resolve(this.served().map(toRecord))
  }

  insert(records: readonly LegalDocumentRecord[]): Promise<void> {
    for (const record of records) {
      if (this.rows.some((row) => row.type === record.type && row.version === record.version)) {
        return Promise.reject(new Error(`duplicate key ${record.type}@${record.version}`))
      }
    }
    this.inserted.push(records.map((record) => structuredClone(record)))
    const createdAt = this.now()
    for (const record of records) this.rows.push({ ...structuredClone(record), createdAt })
    return Promise.resolve()
  }

  private served(): (StoredLegalDocument & { type: LegalDocumentType })[] {
    return this.rows.filter(isServed)
  }
}
