/**
 * THE RULE FOR THIS FILE: **every read SELECTs an explicit column list; none of them selects
 * `snapshot`, and none of them uses `SELECT *`.**
 *
 * `service_hours_certificates.snapshot` is the exact rendered model. At the 1000-entry cap it is ~200 KB
 * of jsonb, which Postgres stores out of line in TOAST. A `SELECT *` (or any projection naming
 * `snapshot`) detoasts that blob on EVERY holder list read and on EVERY anonymous public verification
 * (the highest-traffic read in this feature, served to a school registrar who needs six scalars). The
 * column is written once and read back by nothing; `service-hours-certificates-pg.test.ts` greps this
 * source to keep it that way.
 *
 * The two unique indexes are surfaced as a typed `CertificateConflictError` rather than a leaked driver
 * error, because the service's recoveries are completely different: a `code` collision re-mints and
 * re-renders, while a `ledger_fingerprint` collision means another request won a double-tap race and the
 * winner's document must be returned.
 */

import type { Sql } from "../db/client.js"
import {
  CertificateConflictError,
  type CertificateHolder,
  type CertificateInsert,
  type CertificateRepository,
  type CertificateRow,
  type CertificateVerifyRow,
} from "./certificate-service.js"

const PG_UNIQUE_VIOLATION = "23505"

/** The partial `(user_id, ledger_fingerprint) WHERE revoked_at IS NULL` index (0064). */
const FINGERPRINT_INDEX = "service_hours_certificates_live_fp_uidx"
/** The `(code)` index (0064). */
const CODE_INDEX = "service_hours_certificates_code_uidx"

/**
 * postgres.js surfaces the violated index/constraint name on `constraint_name`. The `detail` fallback is
 * belt-and-braces for a driver that ever stops populating it: misclassifying a fingerprint conflict as a
 * code conflict would burn all five mint attempts and then 500 on a race the design says must succeed.
 */
function conflictKind(err: unknown): "code" | "fingerprint" | null {
  if (typeof err !== "object" || err === null) return null
  const e = err as { code?: unknown; constraint_name?: unknown; detail?: unknown }
  if (e.code !== PG_UNIQUE_VIOLATION) return null
  const constraint = typeof e.constraint_name === "string" ? e.constraint_name : ""
  const detail = typeof e.detail === "string" ? e.detail : ""
  if (constraint === FINGERPRINT_INDEX || detail.includes("ledger_fingerprint"))
    return "fingerprint"
  if (constraint === CODE_INDEX || detail.includes("(code)")) return "code"
  return null
}

/** The shape every projection below returns; `snapshot` is deliberately not among these columns. */
interface CertificateRowSelect {
  id: string
  user_id: string
  code: string
  locale: string
  holder_name: string
  holder_handle: string | null
  holder_verified: boolean
  total_hours: number
  entry_count: number
  period_start: Date | null
  period_end: Date | null
  ledger_fingerprint: string
  r2_key: string
  document_sha256: string
  byte_size: number
  issued_at: Date
  regenerated_at: Date | null
  revoked_at: Date | null
  revoked_reason: string | null
}

function toRow(r: CertificateRowSelect): CertificateRow {
  return {
    id: r.id,
    userId: r.user_id,
    code: r.code,
    locale: r.locale,
    holderName: r.holder_name,
    holderHandle: r.holder_handle,
    holderVerified: r.holder_verified,
    totalHours: r.total_hours,
    entryCount: r.entry_count,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    ledgerFingerprint: r.ledger_fingerprint,
    r2Key: r.r2_key,
    documentSha256: r.document_sha256,
    byteSize: r.byte_size,
    issuedAt: r.issued_at,
    regeneratedAt: r.regenerated_at,
    revokedAt: r.revoked_at,
    revokedReason: r.revoked_reason,
  }
}

export function makeDrizzleCertificateRepository(sql: Sql): CertificateRepository {
  return {
    async insert(row: CertificateInsert): Promise<CertificateRow> {
      try {
        const rows = await sql<CertificateRowSelect[]>`
          INSERT INTO service_hours_certificates (
            id, user_id, code, locale, holder_name, holder_handle, holder_verified,
            total_hours, entry_count, period_start, period_end, ledger_fingerprint,
            snapshot, r2_key, document_sha256, byte_size, issued_at
          )
          VALUES (
            ${row.id}, ${row.userId}, ${row.code}, ${row.locale}, ${row.holderName},
            ${row.holderHandle}, ${row.holderVerified},
            ${row.totalHours}, ${row.entryCount}, ${row.periodStart}, ${row.periodEnd},
            ${row.ledgerFingerprint},
            ${sql.json(row.snapshot as unknown as Parameters<typeof sql.json>[0])}, ${row.r2Key}, ${row.documentSha256},
            ${row.byteSize}, ${row.issuedAt}
          )
          RETURNING
            id, user_id, code, locale, holder_name, holder_handle, holder_verified,
            total_hours::float8 AS total_hours, entry_count, period_start, period_end,
            ledger_fingerprint, r2_key, document_sha256, byte_size, issued_at,
            regenerated_at, revoked_at, revoked_reason
        `
        return toRow(rows[0]!)
      } catch (err) {
        const kind = conflictKind(err)
        if (kind !== null) throw new CertificateConflictError(kind)
        throw err
      }
    },

    /**
     * The idempotency lookup, matching the partial index exactly (`revoked_at IS NULL`): a revoked row
     * must NOT be reused, which is what frees the slot for a fresh document over the same ledger.
     */
    async findLiveByFingerprint(
      userId: string,
      fingerprint: string,
    ): Promise<CertificateRow | null> {
      const rows = await sql<CertificateRowSelect[]>`
        SELECT
          id, user_id, code, locale, holder_name, holder_handle, holder_verified,
          total_hours::float8 AS total_hours, entry_count, period_start, period_end,
          ledger_fingerprint, r2_key, document_sha256, byte_size, issued_at,
          regenerated_at, revoked_at, revoked_reason
        FROM service_hours_certificates
        WHERE user_id = ${userId}
          AND ledger_fingerprint = ${fingerprint}
          AND revoked_at IS NULL
        LIMIT 1
      `
      const row = rows[0]
      return row === undefined ? null : toRow(row)
    },

    /** Newest first, on `service_hours_certificates_user_issued_idx`. Revoked rows are INCLUDED. */
    async listFor(userId: string): Promise<CertificateRow[]> {
      const rows = await sql<CertificateRowSelect[]>`
        SELECT
          id, user_id, code, locale, holder_name, holder_handle, holder_verified,
          total_hours::float8 AS total_hours, entry_count, period_start, period_end,
          ledger_fingerprint, r2_key, document_sha256, byte_size, issued_at,
          regenerated_at, revoked_at, revoked_reason
        FROM service_hours_certificates
        WHERE user_id = ${userId}
        ORDER BY issued_at DESC, id DESC
        LIMIT 200
      `
      return rows.map(toRow)
    },

    /**
     * The PUBLIC verification read. The join to `users` exists ONLY to surface the tombstone: filtering
     * `deleted_at IS NULL` out of the result would collapse "that account was closed" into "no such
     * code", which are different answers for the person holding the paper.
     */
    async findByCode(code: string): Promise<CertificateVerifyRow | null> {
      const rows = await sql<(CertificateRowSelect & { holder_deleted: boolean })[]>`
        SELECT
          c.id, c.user_id, c.code, c.locale, c.holder_name, c.holder_handle, c.holder_verified,
          c.total_hours::float8 AS total_hours, c.entry_count, c.period_start, c.period_end,
          c.ledger_fingerprint, c.r2_key, c.document_sha256, c.byte_size, c.issued_at,
          c.regenerated_at, c.revoked_at, c.revoked_reason,
          (u.deleted_at IS NOT NULL) AS holder_deleted
        FROM service_hours_certificates c
        JOIN users u ON u.id = c.user_id
        WHERE c.code = ${code}
        LIMIT 1
      `
      const row = rows[0]
      return row === undefined ? null : { ...toRow(row), holderDeleted: row.holder_deleted }
    },

    /**
     * `COALESCE` makes this idempotent: revoking an already-revoked code returns the row unchanged
     * (200, "still revoked") rather than the 404 a `WHERE revoked_at IS NULL` guard would produce on a
     * double tap. Null comes back only for an unknown code or someone else's; both 404 at the service.
     */
    async revoke(
      userId: string,
      code: string,
      reason: string,
      at: Date,
    ): Promise<CertificateRow | null> {
      const rows = await sql<CertificateRowSelect[]>`
        UPDATE service_hours_certificates
        SET revoked_at = COALESCE(revoked_at, ${at}),
            revoked_reason = COALESCE(revoked_reason, ${reason})
        WHERE user_id = ${userId} AND code = ${code}
        RETURNING
          id, user_id, code, locale, holder_name, holder_handle, holder_verified,
          total_hours::float8 AS total_hours, entry_count, period_start, period_end,
          ledger_fingerprint, r2_key, document_sha256, byte_size, issued_at,
          regenerated_at, revoked_at, revoked_reason
      `
      const row = rows[0]
      return row === undefined ? null : toRow(row)
    },

    async markRegenerated(args: {
      id: string
      documentSha256: string
      byteSize: number
      at: Date
    }): Promise<void> {
      await sql`
        UPDATE service_hours_certificates
        SET document_sha256 = ${args.documentSha256},
            byte_size = ${args.byteSize},
            regenerated_at = ${args.at}
        WHERE id = ${args.id}
      `
    },

    /** Holder identity frozen onto the document. A tombstoned account cannot issue. */
    async findHolder(userId: string): Promise<CertificateHolder | null> {
      const rows = await sql<{ display_name: string; handle: string | null; locale: string }[]>`
        SELECT
          u.display_name,
          u.handle,
          u.locale
        FROM users u
        WHERE u.id = ${userId} AND u.deleted_at IS NULL
        LIMIT 1
      `
      const row = rows[0]
      if (row === undefined) return null
      return {
        userId,
        displayName: row.display_name,
        handle: row.handle,
        locale: row.locale,
      }
    },
  }
}
