/**
 * Guard-free (no runIfMain) so it is safe to import anywhere; see ingest-jurisdictions-core.ts.
 *
 * Every code comes from the reference_counters allocator the live create paths use, so running this
 * alongside live traffic can never collide. Run it as a separate post-deploy script, never inside the
 * migration transaction: a long table scan there would block boot.
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

const LABEL = "reference-codes"

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

/** Run after backfillCleanupJurisdictions so each event's JURCODE is resolved. */
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
