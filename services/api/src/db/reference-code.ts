/**
 * Reference-code allocation (issue #56). The single, DRY home for minting the human-readable, IMMUTABLE
 * reference codes stamped on reports + cleanups — shared by BOTH the live create paths (report /
 * anon / cleanup repositories) AND the post-deploy backfill scripts, so a code minted by one can never
 * collide with the other.
 *
 * Shape (D1):
 *   - reports: `{TYPECODE}-{JURCODE}-{NNNNNN}`  e.g. "DU-42-000001"
 *   - events : `EVENT-{JURCODE}-{NNNNNN}`       e.g. "EVENT-42-000001"
 *   where TYPECODE is the shared REPORT_TYPE_CODE entry (M6 — imported, never re-hardcoded), JURCODE is
 *   jurisdictions.code (0 = unknown bucket, D5), and NNNNNN is a 6-digit zero-padded per-scope counter.
 *
 * Allocation (D4): allocateNextSeq runs ONE atomic upsert against reference_counters. The counter is
 * per scope_key ("{typecode}:{jurcode}" for reports, "EVENT:{jurcode}" for events), so concurrent
 * creates in different scopes never contend, and same-scope creates serialize on the row lock.
 *
 * LOCK-ORDER CONTRACT (D4): callers MUST invoke allocateNextSeq / allocateReferenceCode as the FIRST
 * statement inside their create transaction. Taking the counter-row lock before any report/cleanup row
 * lock gives every create path a consistent lock-acquisition order, so two concurrent creates can never
 * deadlock (no ABBA). The later agent wiring the live create paths is bound by this contract.
 *
 * Pure + dependency-free: the formatting/scope-key helpers are pure; the allocator takes the project's
 * `Queryable` tag (postgres.js Sql | TransactionSql) so it runs standalone OR inside a `sql.begin` tx.
 */

import { REPORT_TYPE_CODE, type ReportType } from "@civfix/shared"
import type { Queryable } from "./client.js"

/** JURCODE used when a report/event has no resolved jurisdiction (the "unknown" bucket, D5). */
export const UNKNOWN_JURCODE = 0

/** Fixed prefix for the EVENT (cleanup) reference-code family + counter scope. */
export const EVENT_PREFIX = "EVENT"

/**
 * Resolve a jurisdiction GEOID to its compact integer JURCODE (jurisdictions.code) for the reference-code
 * JURCODE segment. Returns UNKNOWN_JURCODE (0) when the geoid is null OR the row has no code on file (D5),
 * so a code is always mintable and an unmapped/unknown-code report lands in the shared "0" bucket. Run
 * pre-tx by the create paths (the geoid is already resolved before the create transaction).
 */
export async function resolveJurisdictionCode(
  sql: Queryable,
  geoid: string | null,
): Promise<number> {
  if (geoid === null) return UNKNOWN_JURCODE
  const rows = await sql<{ code: number | null }[]>`
    SELECT code FROM jurisdictions WHERE geoid = ${geoid} LIMIT 1
  `
  const code = rows[0]?.code
  return code === null || code === undefined ? UNKNOWN_JURCODE : Number(code)
}

/** reference_counters scope_key for a report: `"{typecode}:{jurcode}"`. */
export function reportScopeKey(typeCode: string, jurCode: number): string {
  return `${typeCode}:${jurCode}`
}

/** reference_counters scope_key for an event (cleanup): `"EVENT:{jurcode}"`. */
export function eventScopeKey(jurCode: number): string {
  return `${EVENT_PREFIX}:${jurCode}`
}

/** Zero-pad a sequence value to the 6-digit NNNNNN segment of a reference code. */
function pad6(seq: number): string {
  return String(seq).padStart(6, "0")
}

/**
 * Compose a reference code from its parts: `{PREFIX}-{JURCODE}-{NNNNNN}`. `prefix` is a report TYPECODE
 * (e.g. "DU") or the EVENT_PREFIX ("EVENT"); the seq is zero-padded to 6 digits.
 */
export function formatReferenceCode(prefix: string, jurCode: number, seq: number): string {
  return `${prefix}-${jurCode}-${pad6(seq)}`
}

/**
 * Resolve a report TYPECODE from a report `type` via the shared REPORT_TYPE_CODE map (M6). Falls back to
 * the "other" code if an unrecognized type ever reaches here, so a code is always mintable.
 */
export function typeCodeFor(type: ReportType): string {
  return REPORT_TYPE_CODE[type] ?? REPORT_TYPE_CODE.other
}

/**
 * Atomically allocate (and return) the NEXT value for `scopeKey` from reference_counters. The first
 * allocation for a scope inserts next_val = 1; every subsequent one increments and returns. Returns the
 * bigint as a JS number (counts stay far below 2^53).
 *
 * D4 lock order: call this FIRST in the create transaction — see the module header.
 */
export async function allocateNextSeq(sql: Queryable, scopeKey: string): Promise<number> {
  const rows = await sql<{ next_val: number }[]>`
    INSERT INTO reference_counters (scope_key, next_val)
    VALUES (${scopeKey}, 1)
    ON CONFLICT (scope_key) DO UPDATE
      SET next_val = reference_counters.next_val + 1
    RETURNING next_val
  `
  return Number(rows[0]!.next_val)
}

/**
 * Allocate the next reference code for a REPORT: derives the TYPECODE from the report `type` and the
 * scope from (typecode, jurCode), bumps that scope's counter, and formats the code. `jurCode` is
 * jurisdictions.code, or UNKNOWN_JURCODE (0) when the report has no resolved jurisdiction (D5).
 *
 * D4 lock order: call this FIRST in the create transaction.
 */
export async function allocateReportReferenceCode(
  sql: Queryable,
  type: ReportType,
  jurCode: number = UNKNOWN_JURCODE,
): Promise<string> {
  const typeCode = typeCodeFor(type)
  const seq = await allocateNextSeq(sql, reportScopeKey(typeCode, jurCode))
  return formatReferenceCode(typeCode, jurCode, seq)
}

/**
 * Allocate the next reference code for an EVENT (cleanup): bumps the `EVENT:{jurcode}` scope counter and
 * formats `EVENT-{jurcode}-{NNNNNN}`. `jurCode` is jurisdictions.code, or UNKNOWN_JURCODE (0) when the
 * event has no resolved jurisdiction.
 *
 * D4 lock order: call this FIRST in the create transaction.
 */
export async function allocateEventReferenceCode(
  sql: Queryable,
  jurCode: number = UNKNOWN_JURCODE,
): Promise<string> {
  const seq = await allocateNextSeq(sql, eventScopeKey(jurCode))
  return formatReferenceCode(EVENT_PREFIX, jurCode, seq)
}
