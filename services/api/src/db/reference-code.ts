/**
 * The one allocator for the immutable reference codes on reports and cleanups, shared by the live create
 * paths and the backfill scripts so a code minted by one can never collide with the other.
 *
 *   - reports: `{TYPECODE}-{JURCODE}-{NNNNNN}`  e.g. "DU-42-000001"
 *   - events : `EVENT-{JURCODE}-{NNNNNN}`       e.g. "EVENT-42-000001"
 *
 * The counter is per scope, so creates in different scopes never contend and same-scope creates
 * serialize on the counter row lock.
 *
 * LOCK-ORDER CONTRACT: callers MUST allocate as the FIRST statement of their create transaction. Taking
 * the counter-row lock before any report or cleanup row lock gives every create path the same
 * acquisition order, so two concurrent creates can never deadlock ABBA.
 */

import { REPORT_TYPE_CODE, type ReportType } from "@civfix/shared"
import type { Queryable } from "./client.js"
import {
  allocateNextSeqIn,
  jurisdictionCodeIn,
} from "../services/reference-code-repository.drizzle.js"

export const UNKNOWN_JURCODE = 0

export const EVENT_PREFIX = "EVENT"

const SEQ_DIGITS = 6

/** Falls back to UNKNOWN_JURCODE rather than failing, so a code is always mintable. */
export async function resolveJurisdictionCode(
  sql: Queryable,
  geoid: string | null,
): Promise<number> {
  if (geoid === null) return UNKNOWN_JURCODE
  const code = await jurisdictionCodeIn(sql, geoid)
  return code === null ? UNKNOWN_JURCODE : Number(code)
}

export function reportScopeKey(typeCode: string, jurCode: number): string {
  return `${typeCode}:${jurCode}`
}

export function eventScopeKey(jurCode: number): string {
  return `${EVENT_PREFIX}:${jurCode}`
}

export function formatReferenceCode(prefix: string, jurCode: number, seq: number): string {
  return `${prefix}-${jurCode}-${String(seq).padStart(SEQ_DIGITS, "0")}`
}

/** Falls back to the "other" code for an unrecognized type, so a code is always mintable. */
export function typeCodeFor(type: ReportType): string {
  return REPORT_TYPE_CODE[type] ?? REPORT_TYPE_CODE.other
}

/** Call this FIRST in the create transaction (see the lock-order contract above). */
export async function allocateReportReferenceCode(
  sql: Queryable,
  type: ReportType,
  jurCode: number = UNKNOWN_JURCODE,
): Promise<string> {
  const typeCode = typeCodeFor(type)
  const seq = await allocateNextSeqIn(sql, reportScopeKey(typeCode, jurCode))
  return formatReferenceCode(typeCode, jurCode, seq)
}

/** Call this FIRST in the create transaction (see the lock-order contract above). */
export async function allocateEventReferenceCode(
  sql: Queryable,
  jurCode: number = UNKNOWN_JURCODE,
): Promise<string> {
  const seq = await allocateNextSeqIn(sql, eventScopeKey(jurCode))
  return formatReferenceCode(EVENT_PREFIX, jurCode, seq)
}
