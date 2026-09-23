import type { TranscriptModel } from "./certificate-model.js"

/** The holder identity frozen onto the document, read from `users`. */
export interface CertificateHolder {
  userId: string
  displayName: string
  handle: string | null
  /** `users.locale`; the default when the request does not pin one. */
  locale: string
}

/**
 * `snapshot` is DELIBERATELY ABSENT. At 1000 entries the jsonb is ~200 KB and lives out of line in TOAST;
 * a read path that selects it detoasts on every list and every public verification. Every repo query
 * therefore names its columns explicitly (never `SELECT *`) and none of them names `snapshot`;
 * `service-hours-certificates-pg.test.ts` greps the repo source to keep it that way.
 */
export interface CertificateRow {
  id: string
  userId: string
  code: string
  locale: string
  holderName: string
  holderHandle: string | null
  holderVerified: boolean
  totalHours: number
  entryCount: number
  periodStart: Date | null
  periodEnd: Date | null
  ledgerFingerprint: string
  r2Key: string
  documentSha256: string
  byteSize: number
  issuedAt: Date
  regeneratedAt: Date | null
  revokedAt: Date | null
  revokedReason: string | null
}

/**
 * The verification read. `holderDeleted` mirrors `users.deleted_at IS NOT NULL` from the join: the
 * projection cannot simply filter tombstoned holders out, because "no such code" and "that account was
 * closed" are materially different answers for the person holding the paper.
 */
export interface CertificateVerifyRow extends CertificateRow {
  holderDeleted: boolean
}

export interface CertificateInsert {
  id: string
  userId: string
  code: string
  locale: string
  holderName: string
  holderHandle: string | null
  holderVerified: boolean
  totalHours: number
  entryCount: number
  periodStart: Date | null
  periodEnd: Date | null
  ledgerFingerprint: string
  /** The exact rendered model, stored so the object is re-renderable. Written once, never read back. */
  snapshot: TranscriptModel
  r2Key: string
  documentSha256: string
  byteSize: number
  issuedAt: Date
}

export interface CertificateRepository {
  /**
   * @throws CertificateConflictError("code") on `service_hours_certificates_code_uidx`
   * @throws CertificateConflictError("fingerprint") on the partial
   *         `(user_id, ledger_fingerprint) WHERE revoked_at IS NULL` index
   */
  insert(row: CertificateInsert): Promise<CertificateRow>
  findLiveByFingerprint(userId: string, fingerprint: string): Promise<CertificateRow | null>
  listFor(userId: string): Promise<CertificateRow[]>
  /** Joins `users` so a tombstoned holder is DISTINGUISHABLE from an unknown code. */
  findByCode(code: string): Promise<CertificateVerifyRow | null>
  /**
   * Idempotent: returns the row whether or not it was already revoked, and null only when the code does
   * not exist OR does not belong to `userId`: the service turns that null into a 404, never a 403, so
   * the endpoint is not an existence oracle over someone else's codes.
   */
  revoke(userId: string, code: string, reason: string, at: Date): Promise<CertificateRow | null>
  /** The operator-error path: the row survived, its object did not, and it was re-rendered. */
  markRegenerated(args: {
    id: string
    documentSha256: string
    byteSize: number
    at: Date
  }): Promise<void>
  findHolder(userId: string): Promise<CertificateHolder | null>
}
