import { LegalDocumentTypeSchema, type LegalDocumentType } from "@civfix/contract"
import type { LegalBlock } from "@civfix/contract/legal"

/**
 * The types the API serves and the loader checks, in the order every list returns them. The table also
 * keeps rows of retired types (donations and the two organization documents), which are never read.
 */
export const SERVED_LEGAL_TYPES: readonly LegalDocumentType[] = LegalDocumentTypeSchema.options

/** One `legal_documents` row. `title`, `summary`, `material` and `blocks` are null on pre-§66 versions. */
export interface LegalDocumentRecord {
  type: LegalDocumentType
  version: string
  sha256: string
  effectiveAt: Date
  url: string
  title: string | null
  summary: string | null
  material: boolean | null
  blocks: LegalBlock[] | null
}

export type LegalVersionRecord = Omit<LegalDocumentRecord, "blocks">

export interface LegalDocumentsRepository {
  /** The newest version of each served type whose `effectiveAt` is at or before `now`. */
  current(now: Date): Promise<LegalDocumentRecord[]>
  find(type: LegalDocumentType, version: string): Promise<LegalDocumentRecord | null>
  /** Every version of the served types, newest first, without blocks. */
  listVersions(): Promise<LegalVersionRecord[]>
  /** Every version of the served types with its blocks, for the loader. */
  listAll(): Promise<LegalDocumentRecord[]>
  insert(records: readonly LegalDocumentRecord[]): Promise<void>
}
