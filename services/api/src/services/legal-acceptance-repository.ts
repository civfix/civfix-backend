import type { LegalAcceptAction, LegalDocumentType } from "@civfix/contract"
import type { LegalVersionRecord } from "./legal-documents-repository.js"

/** Where an account's acceptance was given: the `consent_records.surface` values this epic writes. */
export type LegalConsentSurface = "signup" | "prompt" | "notice" | "event_registration"

/** A served version in effect, with the latest time the person accepted and acknowledged it, if ever. */
export interface VersionConsent extends LegalVersionRecord {
  acceptedAt: Date | null
  acknowledgedAt: Date | null
}

export interface LegalDocumentRef {
  type: LegalDocumentType
  version: string
  sha256: string
}

export interface NewConsentRecord extends LegalDocumentRef {
  action: LegalAcceptAction
  surface: LegalConsentSurface
}

export interface AcceptanceCounts {
  /** Distinct active accounts with an `accepted` row, keyed `type@version`. */
  accepted: Map<string, number>
  activeAccounts: number
}

/** What a caller may read and write while it holds a person's acceptance lock. */
export interface LegalAcceptanceTx {
  /**
   * Every served version in effect at `now`, per type in the served order and oldest first within a type,
   * each with the person's own records of it.
   */
  versionsFor(userId: string, now: Date): Promise<VersionConsent[]>
  insert(userId: string, records: readonly NewConsentRecord[], at: Date): Promise<void>
}

export interface LegalAcceptanceRepository extends Pick<LegalAcceptanceTx, "versionsFor"> {
  /** Runs `fn` in one transaction, serialized against every other acceptance by the same person. */
  withUserLock<T>(userId: string, fn: (tx: LegalAcceptanceTx) => Promise<T>): Promise<T>
  acceptanceCounts(
    versions: readonly { type: LegalDocumentType; version: string }[],
  ): Promise<AcceptanceCounts>
}
