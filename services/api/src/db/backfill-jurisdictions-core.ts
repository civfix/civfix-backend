/**
 * Backfill CORE: the pure, side-effect-free `backfillReports` entry point (no `main()`, no CLI guard), so
 * other code can import it safely. The CLI (backfill-jurisdictions.ts) and the local refresh tool
 * (scripts/refresh-boundaries.ts) both call `backfillReports` after a fresh boundary load to heal NULL
 * `reports.jurisdiction_geoid` rows.
 *
 * WHY split from backfill-jurisdictions.ts: the CLI carries an `import.meta.url === argv[1]` run-as-main
 * guard, and tsup (`splitting: false`) would inline that guard into any bundled entry that imported it,
 * firing it at boot. Keeping the importable loop here, guard-free, prevents that. See
 * ingest-jurisdictions-core.ts for the full bundling rationale.
 *
 * ONE RANKING, NEVER DRIFTS: the keyset loop itself lives in ./backfill-keyset.ts, which orders candidate
 * polygons by the SAME shared constant the write-time resolver uses (JURISDICTION_RESOLVE_ORDER_BY from
 * src/db/sql/jurisdiction.ts) and is shared with the cleanups backfill. SCOPE here: reports ONLY.
 */

import { resolveGeomJurisdictions } from "./backfill-keyset.js"
import type { Sql } from "./client.js"

// Large enough to amortize per-batch latency, small enough to keep each UPDATE's spatial work
// (a GiST-indexed ST_Contains per row) bounded.
const BATCH_SIZE = 1000

/**
 * Re-resolve every `reports.jurisdiction_geoid` that is currently NULL, in keyset-cursor batches. Returns
 * `resolved` (rows that got a non-NULL geoid) and `stayedNull` (points still outside all loaded coverage,
 * left NULL on purpose). Idempotent. Geometry goes ONLY through the raw `sql` tag (ST_Contains against
 * reports.geom).
 */
export async function backfillReports(sql: Sql): Promise<{ resolved: number; stayedNull: number }> {
  return resolveGeomJurisdictions(sql, "reports", { batchSize: BATCH_SIZE, label: "backfill" })
}
