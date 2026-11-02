import type { LegalAcceptAction, LegalDocumentType } from "@civfix/contract"
import {
  SERVED_LEGAL_TYPES,
  type LegalVersionRecord,
} from "../../src/services/legal-documents-repository.js"
import type {
  AcceptanceCounts,
  LegalAcceptanceRepository,
  LegalAcceptanceTx,
  LegalConsentSurface,
  NewConsentRecord,
  VersionConsent,
} from "../../src/services/legal-acceptance-repository.js"
import type { InMemoryLegalDocumentsRepository } from "./legal-documents-repository.memory.js"

/** One `consent_records` row of an account. */
export interface StoredConsentRecord {
  userId: string
  type: LegalDocumentType
  version: string
  sha256: string
  action: LegalAcceptAction
  surface: LegalConsentSurface
  acceptedAt: Date
}

function served(type: string): number {
  return (SERVED_LEGAL_TYPES as readonly string[]).indexOf(type)
}

// Same order as the SQL: type order, then oldest first, a later same-day version being the longer string.
function oldestFirst(a: LegalVersionRecord, b: LegalVersionRecord): number {
  return (
    served(a.type) - served(b.type) ||
    a.effectiveAt.getTime() - b.effectiveAt.getTime() ||
    a.version.length - b.version.length ||
    (a.version < b.version ? -1 : a.version > b.version ? 1 : 0)
  )
}

function latest(records: readonly StoredConsentRecord[]): Date | null {
  let at: Date | null = null
  for (const record of records) if (at === null || record.acceptedAt > at) at = record.acceptedAt
  return at
}

export class InMemoryLegalAcceptanceRepository implements LegalAcceptanceRepository {
  readonly records: StoredConsentRecord[] = []
  /** Account id to `deleted_at`, for the admin counts. */
  readonly accounts = new Map<string, Date | null>()

  constructor(private readonly documents: InMemoryLegalDocumentsRepository) {}

  async versionsFor(userId: string, now: Date): Promise<VersionConsent[]> {
    const versions = (await this.documents.listVersions())
      .filter((version) => version.effectiveAt.getTime() <= now.getTime())
      .sort(oldestFirst)
    return versions.map((version) => {
      const mine = this.records.filter(
        (r) => r.userId === userId && r.type === version.type && r.version === version.version,
      )
      return {
        ...version,
        acceptedAt: latest(mine.filter((r) => r.action === "accepted")),
        acknowledgedAt: latest(mine.filter((r) => r.action === "acknowledged")),
      }
    })
  }

  withUserLock<T>(_userId: string, fn: (tx: LegalAcceptanceTx) => Promise<T>): Promise<T> {
    return fn({
      versionsFor: (userId, now) => this.versionsFor(userId, now),
      insert: (userId, records, at) => this.insert(userId, records, at),
    })
  }

  acceptanceCounts(
    versions: readonly { type: LegalDocumentType; version: string }[],
  ): Promise<AcceptanceCounts> {
    const active = (userId: string): boolean => this.accounts.get(userId) === null
    const accepted = new Map(
      versions.map((v) => {
        const users = new Set(
          this.records
            .filter(
              (r) =>
                r.type === v.type &&
                r.version === v.version &&
                r.action === "accepted" &&
                active(r.userId),
            )
            .map((r) => r.userId),
        )
        return [`${v.type}@${v.version}`, users.size] as const
      }),
    )
    const activeAccounts = [...this.accounts.values()].filter((deletedAt) => deletedAt === null)
    return Promise.resolve({ accepted, activeAccounts: activeAccounts.length })
  }

  private insert(userId: string, records: readonly NewConsentRecord[], at: Date): Promise<void> {
    for (const record of records) this.records.push({ ...record, userId, acceptedAt: at })
    return Promise.resolve()
  }
}
