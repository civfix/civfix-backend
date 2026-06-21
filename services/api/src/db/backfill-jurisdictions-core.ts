/**
 * Backfill CORE: the pure, side-effect-free `backfillReports` keyset loop (no `main()`, no CLI guard), so
 * runtime code can import it safely. The on-box `jurisdiction.refresh` cron
 * (services/admin/boundary-refresh-jobs.ts) calls `backfillReports` after a fresh boundary load to heal
 * NULL `reports.jurisdiction_geoid` rows.
 *
 * WHY split from backfill-jurisdictions.ts: tsup builds with `splitting: false`, so importing the CLI
 * would inline its `if (import.meta.url === argv[1]) main()` guard into the API bundle, where esbuild
 * rewrites `import.meta.url` to the API entry — firing the guard at API boot and running the backfill
 * CLI's `main()` unbidden. Keeping the importable loop here, guard-free, prevents that. See
 * ingest-jurisdictions-core.ts for the full bundling rationale.
 *
 * ONE RANKING, NEVER DRIFTS: the UPDATE orders candidate polygons by the SAME shared constant the
 * write-time resolver uses — JURISDICTION_LAYER_RANK_CASE from src/db/sql/jurisdiction.ts. SCOPE: reports
 * ONLY (cleanups have no jurisdiction_geoid column). KEYSET CURSOR over reports.id guarantees termination
 * even for rows that stay NULL (point outside all coverage). Idempotent (`WHERE jurisdiction_geoid IS NULL`).
 */

import type postgres from "postgres"
import type { Sql } from "./client.js"
import { JURISDICTION_LAYER_RANK_CASE } from "./sql/jurisdiction.js"

/** A composable SQL fragment (postgres.js Fragment); what a `sql\`...\`` expression yields. */
type SqlFragment = postgres.Fragment

/**
 * How many reports to select + update per round-trip. Large enough to amortize per-batch latency, small
 * enough to keep each UPDATE's spatial work (a GiST-indexed ST_Contains per row) bounded.
 */
const BATCH_SIZE = 1000

/**
 * Re-resolve every `reports.jurisdiction_geoid` that is currently NULL, in keyset-cursor batches. Returns
 * `resolved` (rows that got a non-NULL geoid) and `stayedNull` (points still outside all loaded coverage,
 * left NULL on purpose). Geometry goes ONLY through the raw `sql` tag (ST_Contains against reports.geom).
 */
export async function backfillReports(sql: Sql): Promise<{ resolved: number; stayedNull: number }> {
  let resolved = 0
  let stayedNull = 0
  // The keyset cursor: the last report id already paged past. NULL on the first iteration (no lower
  // bound). Strictly increases every batch, guaranteeing termination.
  let cursor: string | null = null

  for (;;) {
    // Strict lower bound for this page, lifted into an explicitly-typed fragment (the codebase convention;
    // the `: SqlFragment` annotation breaks the `sql` self-reference that would otherwise infer `any`).
    const cursorFilter: SqlFragment = cursor === null ? sql`` : sql`AND id > ${cursor}`
    const batch = await sql<{ id: string }[]>`
      SELECT id
      FROM reports
      WHERE jurisdiction_geoid IS NULL
        ${cursorFilter}
      ORDER BY id
      LIMIT ${BATCH_SIZE}
    `
    if (batch.length === 0) break

    const batchIds = batch.map((b) => b.id)

    // Resolve each report point to its most-specific containing jurisdiction and stamp it. The LATERAL
    // subquery picks the single best polygon using the SHARED ranking constant (sql.unsafe — trusted,
    // code-defined, identical to the write-time resolver). Rows outside every polygon match nothing → stay
    // NULL → absent from RETURNING. The IN(...) / IS NULL guards keep the statement idempotent.
    const updated = await sql<{ id: string }[]>`
      UPDATE reports r
      SET jurisdiction_geoid = j.geoid
      FROM LATERAL (
        SELECT geoid
        FROM jurisdictions
        WHERE ST_Contains(geom, r.geom)
        ORDER BY ${sql.unsafe(JURISDICTION_LAYER_RANK_CASE)}
        LIMIT 1
      ) j
      WHERE r.jurisdiction_geoid IS NULL
        AND r.id IN ${sql(batchIds)}
      RETURNING r.id
    `

    resolved += updated.length
    stayedNull += batch.length - updated.length
    // Advance past the whole batch — including rows that stayed NULL — so they are never revisited.
    cursor = batch[batch.length - 1]!.id

    console.log(
      `backfill: batch of ${batch.length} (resolved ${updated.length}, still null ${batch.length - updated.length}); ` +
        `running total resolved=${resolved}, still-null=${stayedNull}`,
    )
  }

  return { resolved, stayedNull }
}
