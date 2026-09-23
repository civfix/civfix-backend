/**
 * Behavioural in-memory twin of the Drizzle `CertificateRepository`.
 *
 * It lives beside its Drizzle counterpart (the same placement as
 * `volunteer-hours-repository.memory.ts`) because the ONLY thing keeping the two honest is that they are
 * read side by side: `certificate-routes.test.ts` runs the whole route surface against this class with no
 * Docker, so any rule the SQL enforces and this class does not is invisible to CI until production.
 *
 * Mirrored deliberately:
 *   - BOTH unique indexes, as the typed `CertificateConflictError`: `(code)` and the PARTIAL
 *     `(user_id, ledger_fingerprint) WHERE revoked_at IS NULL`. The partial-ness is the point: revoking
 *     frees the slot so the holder can re-issue over the same ledger.
 *   - `revoke` is idempotent via a COALESCE-equivalent, and returns null for an unknown code OR another
 *     user's code, so the service's "404, never 403" rule is exercised here too.
 *   - `findByCode` reports a tombstoned holder rather than hiding the row.
 *   - reads hand back CLONES, so a test mutating a returned row cannot corrupt the store.
 *
 * `snapshot` is stored but never read back, exactly as in production.
 */

import { CertificateConflictError } from "./certificate-service.js"
import type {
  CertificateHolder,
  CertificateInsert,
  CertificateRepository,
  CertificateRow,
  CertificateVerifyRow,
} from "./certificate-repository.js"
import type { TranscriptModel } from "./certificate-model.js"

/** Mirrors the `users.locale` column default. */
const DEFAULT_HOLDER_LOCALE = "en"

/** What a test registers so `findHolder` can answer, mirroring the users read. */
export interface MemoryCertificateHolder {
  displayName: string
  handle?: string | null
  locale?: string
  /** `users.deleted_at IS NOT NULL`: cannot issue, and its live certificates verify as account_closed. */
  deleted?: boolean
}

interface StoredCertificate extends CertificateRow {
  snapshot: TranscriptModel
}

export class InMemoryCertificateRepository implements CertificateRepository {
  /** userId -> holder identity. A test that never registers one gets `findHolder` === null (a 404). */
  readonly holders = new Map<string, MemoryCertificateHolder>()
  private readonly rows = new Map<string, StoredCertificate>()

  setHolder(userId: string, holder: MemoryCertificateHolder): void {
    this.holders.set(userId, holder)
  }

  /** Test helper: every stored row, newest first. */
  all(): CertificateRow[] {
    return [...this.rows.values()]
      .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime())
      .map(clone)
  }

  insert(row: CertificateInsert): Promise<CertificateRow> {
    for (const existing of this.rows.values()) {
      if (existing.code === row.code) {
        return Promise.reject(new CertificateConflictError("code"))
      }
      // PARTIAL index: only a LIVE row occupies the (user, fingerprint) slot.
      if (
        existing.userId === row.userId &&
        existing.ledgerFingerprint === row.ledgerFingerprint &&
        existing.revokedAt === null
      ) {
        return Promise.reject(new CertificateConflictError("fingerprint"))
      }
    }
    const stored: StoredCertificate = {
      ...row,
      regeneratedAt: null,
      revokedAt: null,
      revokedReason: null,
    }
    this.rows.set(stored.id, stored)
    return Promise.resolve(clone(stored))
  }

  findLiveByFingerprint(userId: string, fingerprint: string): Promise<CertificateRow | null> {
    for (const row of this.rows.values()) {
      if (
        row.userId === userId &&
        row.ledgerFingerprint === fingerprint &&
        row.revokedAt === null
      ) {
        return Promise.resolve(clone(row))
      }
    }
    return Promise.resolve(null)
  }

  listFor(userId: string): Promise<CertificateRow[]> {
    const rows = [...this.rows.values()]
      .filter((row) => row.userId === userId)
      .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime())
      .map(clone)
    return Promise.resolve(rows)
  }

  findByCode(code: string): Promise<CertificateVerifyRow | null> {
    for (const row of this.rows.values()) {
      if (row.code === code) {
        const holder = this.holders.get(row.userId)
        return Promise.resolve({ ...clone(row), holderDeleted: holder?.deleted === true })
      }
    }
    return Promise.resolve(null)
  }

  revoke(userId: string, code: string, reason: string, at: Date): Promise<CertificateRow | null> {
    for (const row of this.rows.values()) {
      if (row.code !== code) continue
      // Another user's code is indistinguishable from an unknown one, on purpose.
      if (row.userId !== userId) return Promise.resolve(null)
      row.revokedAt = row.revokedAt ?? at
      row.revokedReason = row.revokedReason ?? reason
      return Promise.resolve(clone(row))
    }
    return Promise.resolve(null)
  }

  markRegenerated(args: {
    id: string
    documentSha256: string
    byteSize: number
    at: Date
  }): Promise<void> {
    const row = this.rows.get(args.id)
    if (row) {
      row.documentSha256 = args.documentSha256
      row.byteSize = args.byteSize
      row.regeneratedAt = args.at
    }
    return Promise.resolve()
  }

  findHolder(userId: string): Promise<CertificateHolder | null> {
    const holder = this.holders.get(userId)
    // A tombstoned account cannot issue, matching the Drizzle read's `deleted_at IS NULL` filter.
    if (!holder || holder.deleted === true) return Promise.resolve(null)
    return Promise.resolve({
      userId,
      displayName: holder.displayName,
      handle: holder.handle ?? null,
      locale: holder.locale ?? DEFAULT_HOLDER_LOCALE,
    })
  }
}

function clone(row: StoredCertificate): CertificateRow {
  return {
    id: row.id,
    userId: row.userId,
    code: row.code,
    locale: row.locale,
    holderName: row.holderName,
    holderHandle: row.holderHandle,
    holderVerified: row.holderVerified,
    totalHours: row.totalHours,
    entryCount: row.entryCount,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    ledgerFingerprint: row.ledgerFingerprint,
    r2Key: row.r2Key,
    documentSha256: row.documentSha256,
    byteSize: row.byteSize,
    issuedAt: row.issuedAt,
    regeneratedAt: row.regeneratedAt,
    revokedAt: row.revokedAt,
    revokedReason: row.revokedReason,
  }
}
