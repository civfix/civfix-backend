/**
 * Reference-code backfill CORE: the pure, side-effect-free entry points that stamp historical
 * reports + cleanups with reference codes (issue #56). No `main()`, no CLI guard, so this module is safe
 * to import from anywhere (the CLI shell backfill-reference-codes.ts imports it). See
 * ingest-jurisdictions-core.ts for the full tsup-bundling rationale behind the guard-free split.
 *
 * RACE-FREE BY DESIGN: every code is minted through the SAME reference_counters allocator
 * (allocateNextSeq) that the live create paths use, so a backfill running AFTER deploy — concurrently
 * with live traffic minting fresh codes — can never collide. Idempotent: each loop only touches rows
 * whose reference_code IS NULL, and a KEYSET CURSOR guarantees termination even for rows that stay NULL.
 * The loops themselves live in ./backfill-keyset.ts (shared with the reports jurisdiction backfill).
 *
 * H3: run this as a SEPARATE post-deploy script, NEVER inside the migration transaction (a long table
 * scan/rewrite would block boot).
 */

import type { ReportType } from "@civfix/shared"
import {
  resolveGeomJurisdictions,
  stampReferenceCodes,
  type ReferenceCodeRow,
} from "./backfill-keyset.js"
import type { Queryable, Sql } from "./client.js"
import { allocateReportReferenceCode, allocateEventReferenceCode } from "./reference-code.js"

const BATCH_SIZE = 500

/** Log prefix shared by every step of this backfill (matches the CLI shell's messages). */
const LABEL = "reference-codes"

/**
 * Backfill `reports.reference_code` for every report still NULL, oldest-first (created_at ASC, id ASC for
 * a stable tiebreak), in keyset-cursor batches. The TYPECODE comes from `reports.type` (via the shared map
 * inside allocateReportReferenceCode, M6) and the JURCODE from the report's jurisdiction
 * (jurisdictions.code; UNKNOWN_JURCODE/0 when unresolved or the joined code is NULL). Returns how many rows
 * were stamped.
 */
export async function backfillReportReferenceCodes(
  sql: Sql,
): Promise<{ stamped: number; failed: number }> {
  return stampReferenceCodes<ReferenceCodeRow & { type: ReportType }>(sql, {
    table: "reports",
    batchSize: BATCH_SIZE,
    label: LABEL,
    extraColumn: "type",
    allocate: (tx, row, jurCode) => allocateReportReferenceCode(tx, row.type, jurCode),
  })
}

/**
 * Resolve `cleanups.jurisdiction_geoid` for every cleanup still NULL, using the SAME point-in-polygon SQL
 * + ordering constant as the write-time resolver (resolveForPoint / JURISDICTION_RESOLVE_ORDER_BY), so the
 * EVENT JURCODE matches what a fresh create would assign. Keyset-batched over cleanups.id, idempotent
 * (only touches NULL rows). Returns how many got a non-NULL geoid. Geometry flows ONLY through the raw tag.
 */
export async function backfillCleanupJurisdictions(
  sql: Queryable,
  opts: { ids?: readonly string[] } = {},
): Promise<{ resolved: number; stayedNull: number }> {
  return resolveGeomJurisdictions(sql, "cleanups", {
    batchSize: BATCH_SIZE,
    label: `${LABEL}: cleanup-jurisdiction`,
    ...opts,
  })
}

/**
 * Backfill `cleanups.reference_code` for every cleanup still NULL, oldest-first, in keyset-cursor batches.
 * JURCODE comes from the cleanup's jurisdiction (jurisdictions.code; UNKNOWN_JURCODE/0 when unresolved),
 * the code is allocated from the shared EVENT counter, and the row is stamped. Run AFTER
 * backfillCleanupJurisdictions so the JURCODE is resolved. Returns how many stamped.
 */
export async function backfillCleanupReferenceCodes(
  sql: Sql,
): Promise<{ stamped: number; failed: number }> {
  return stampReferenceCodes<ReferenceCodeRow>(sql, {
    table: "cleanups",
    batchSize: BATCH_SIZE,
    label: LABEL,
    extraColumn: null,
    allocate: (tx, _row, jurCode) => allocateEventReferenceCode(tx, jurCode),
  })
}

/**
 * Run the full reference-code backfill in the correct order: stamp report codes, resolve cleanup
 * jurisdictions, then stamp event codes. All steps are idempotent + safe to re-run.
 */
export async function backfillReferenceCodes(sql: Sql): Promise<{
  reports: { stamped: number; failed: number }
  cleanupJurisdictions: { resolved: number; stayedNull: number }
  cleanups: { stamped: number; failed: number }
}> {
  const reports = await backfillReportReferenceCodes(sql)
  const cleanupJurisdictions = await backfillCleanupJurisdictions(sql)
  const cleanups = await backfillCleanupReferenceCodes(sql)
  return { reports, cleanupJurisdictions, cleanups }
}
