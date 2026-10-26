import type { LegalAcceptAction, LegalDocumentType } from "@civfix/contract"
import type { Queryable, Sql } from "../db/client.js"
import { SERVED_LEGAL_TYPES } from "./legal-documents-repository.js"
import type {
  AcceptanceCounts,
  LegalAcceptanceRepository,
  LegalAcceptanceTx,
  NewConsentRecord,
  VersionConsent,
} from "./legal-acceptance-repository.js"

interface VersionConsentRow {
  type: LegalDocumentType
  version: string
  sha256: string
  effective_at: Date
  url: string
  title: string | null
  summary: string | null
  material: boolean | null
  accepted_at: Date | null
  acknowledged_at: Date | null
}

const ACCEPTED: LegalAcceptAction = "accepted"
const ACKNOWLEDGED: LegalAcceptAction = "acknowledged"

async function versionsFor(sql: Queryable, userId: string, now: Date): Promise<VersionConsent[]> {
  const types = SERVED_LEGAL_TYPES as LegalDocumentType[]
  // Oldest first within a type, in the order `current` picks the newest: a later same-day version is the
  // longer string.
  const rows = await sql<VersionConsentRow[]>`
    SELECT d.type, d.version, d.sha256, d.effective_at, d.url, d.title, d.summary, d.material,
           max(r.accepted_at) FILTER (WHERE r.action = ${ACCEPTED}) AS accepted_at,
           max(r.accepted_at) FILTER (WHERE r.action = ${ACKNOWLEDGED}) AS acknowledged_at
    FROM legal_documents d
    LEFT JOIN consent_records r
      ON r.subject_kind = 'user' AND r.user_id = ${userId}
     AND r.document_type = d.type AND r.document_version = d.version
    WHERE d.type = ANY(${types}::text[]) AND d.effective_at <= ${now}
    GROUP BY d.type, d.version
    ORDER BY array_position(${types}::text[], d.type), d.effective_at, length(d.version), d.version
  `
  return rows.map((row) => ({
    type: row.type,
    version: row.version,
    sha256: row.sha256,
    effectiveAt: row.effective_at,
    url: row.url,
    title: row.title,
    summary: row.summary,
    material: row.material,
    acceptedAt: row.accepted_at,
    acknowledgedAt: row.acknowledged_at,
  }))
}

/** Writes an account's consent records; event registration calls it inside its own transaction. */
export async function insertConsentRecords(
  sql: Queryable,
  userId: string,
  records: readonly NewConsentRecord[],
  at: Date,
): Promise<void> {
  if (records.length === 0) return
  const rows = records.map((record) => ({
    subject_kind: "user",
    user_id: userId,
    document_type: record.type,
    document_version: record.version,
    document_sha256: record.sha256,
    action: record.action,
    surface: record.surface,
    accepted_at: at,
  }))
  await sql`
    INSERT INTO consent_records ${sql(
      rows,
      "subject_kind",
      "user_id",
      "document_type",
      "document_version",
      "document_sha256",
      "action",
      "surface",
      "accepted_at",
    )}
  `
}

function transactional(tx: Queryable): LegalAcceptanceTx {
  return {
    versionsFor: (userId, now) => versionsFor(tx, userId, now),
    insert: (userId, records, at) => insertConsentRecords(tx, userId, records, at),
  }
}

export function makeLegalAcceptanceRepository(sql: Sql): LegalAcceptanceRepository {
  return {
    versionsFor: (userId, now) => versionsFor(sql, userId, now),

    withUserLock<T>(userId: string, fn: (tx: LegalAcceptanceTx) => Promise<T>): Promise<T> {
      return sql.begin(async (tx) => {
        // Serializes one person's acceptances, so "skip what is recorded" and "sign-up only before any
        // record" read what a concurrent request committed. An advisory lock, not FOR UPDATE on `users`.
        await tx`SELECT pg_advisory_xact_lock(hashtext('legal_accept:' || ${userId}))`
        return fn(transactional(tx))
      }) as Promise<T>
    },

    async acceptanceCounts(versions): Promise<AcceptanceCounts> {
      const rows = await sql<
        { type: LegalDocumentType; version: string; accepted: number; active_accounts: number }[]
      >`
        SELECT v.type, v.version, count(DISTINCT u.id)::int AS accepted,
               (SELECT count(*)::int FROM users WHERE deleted_at IS NULL) AS active_accounts
        FROM unnest(${versions.map((v) => v.type)}::text[], ${versions.map((v) => v.version)}::text[])
             AS v(type, version)
        LEFT JOIN consent_records r
          ON r.subject_kind = 'user' AND r.action = ${ACCEPTED}
         AND r.document_type = v.type AND r.document_version = v.version
        LEFT JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
        GROUP BY v.type, v.version
      `
      return {
        accepted: new Map(rows.map((row) => [`${row.type}@${row.version}`, row.accepted])),
        activeAccounts: rows[0]?.active_accounts ?? 0,
      }
    },
  }
}
