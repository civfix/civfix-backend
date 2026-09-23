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
 * src/db/sql/jurisdiction.ts) and is shared with the cleanups backfill. SCOPE here: the reports backfill,
 * plus the refresh tool's non-authoritative prune, which lives here so it can be tested without running
 * that script's `main()`.
 */

import { resolveGeomJurisdictions } from "./backfill-keyset.js"
import { backfillCleanupJurisdictions } from "./backfill-reference-codes-core.js"
import type { Queryable, Sql } from "./client.js"

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

export const PRUNE_AFFECTED_TABLES = [
  "reports",
  "cleanups",
  "volunteer_hours",
  "gov_claims",
  "mail_threads",
  "user_jurisdiction_hours",
  "jurisdiction_contacts",
  "outreach_state",
  "jurisdiction_discovery_tasks",
  "jurisdictions",
] as const

export type PruneAffectedTable = (typeof PRUNE_AFFECTED_TABLES)[number]

export interface NonAuthoritativePrune {
  staleGeoids: string[]
  affected: Record<PruneAffectedTable, number>
  applied: boolean
  reresolved: { reports: number; cleanups: number; volunteerHours: number; rollups: number } | null
}

function noneAffected(): Record<PruneAffectedTable, number> {
  return Object.fromEntries(PRUNE_AFFECTED_TABLES.map((t) => [t, 0])) as Record<
    PruneAffectedTable,
    number
  >
}

/**
 * Drops the dev seed's federal/tribal jurisdictions (geoids outside the PAD-US / AIANNH namespaces)
 * and every pointer into them. With `apply: false` it only counts what would change. When applied,
 * the SAME transaction re-resolves exactly the reports, cleanups and volunteer_hours rows it nulled
 * against the remaining boundaries and rebuilds the hours rollup for the pairs they land on, so a
 * failure part-way leaves nothing half-pruned. gov_claims and mail_threads have no geometry to
 * re-derive from and stay NULL.
 */
export async function pruneNonAuthoritativeJurisdictions(
  sql: Sql,
  opts: { apply: boolean },
): Promise<NonAuthoritativePrune> {
  return await sql.begin(async (tx) => {
    const stale = await tx<{ geoid: string }[]>`
      SELECT geoid FROM jurisdictions
      WHERE (layer = 'federal' AND geoid NOT LIKE 'PADUS-%')
         OR (layer = 'tribal'  AND geoid NOT LIKE 'AIANNH-%')
    `
    const staleGeoids = stale.map((s) => s.geoid)
    if (staleGeoids.length === 0) {
      return { staleGeoids, affected: noneAffected(), applied: false, reresolved: null }
    }
    const affected = await countPruneImpact(tx, staleGeoids)
    if (!opts.apply) return { staleGeoids, affected, applied: false, reresolved: null }

    // Same lock order as 0065 and logEventHours (ledger, then rollup): the rollup rebuild below
    // overwrites totals, so a concurrent delta landing between its SUM and its write would be lost.
    await tx`LOCK TABLE volunteer_hours, user_jurisdiction_hours IN SHARE ROW EXCLUSIVE MODE`
    const reports = await tx<{ id: string }[]>`
      UPDATE reports SET jurisdiction_geoid = NULL
      WHERE jurisdiction_geoid IN ${tx(staleGeoids)}
      RETURNING id
    `
    const cleanups = await tx<{ id: string }[]>`
      UPDATE cleanups SET jurisdiction_geoid = NULL
      WHERE jurisdiction_geoid IN ${tx(staleGeoids)}
      RETURNING id
    `
    const hours = await tx<{ id: string }[]>`
      UPDATE volunteer_hours SET jurisdiction_geoid = NULL
      WHERE jurisdiction_geoid IN ${tx(staleGeoids)}
      RETURNING id
    `
    await tx`UPDATE gov_claims      SET jurisdiction_geoid = NULL WHERE jurisdiction_geoid IN ${tx(staleGeoids)}`
    await tx`UPDATE mail_threads    SET jurisdiction_geoid = NULL WHERE jurisdiction_geoid IN ${tx(staleGeoids)}`
    await tx`DELETE FROM user_jurisdiction_hours     WHERE jurisdiction_geoid IN ${tx(staleGeoids)}`
    await tx`DELETE FROM jurisdiction_contacts       WHERE geoid IN ${tx(staleGeoids)}`
    await tx`DELETE FROM outreach_state              WHERE geoid IN ${tx(staleGeoids)}`
    await tx`DELETE FROM jurisdiction_discovery_tasks WHERE geoid IN ${tx(staleGeoids)}`
    await tx`DELETE FROM jurisdictions               WHERE geoid IN ${tx(staleGeoids)}`

    const reportsResolved =
      reports.length === 0
        ? 0
        : (
            await resolveGeomJurisdictions(tx, "reports", {
              batchSize: BATCH_SIZE,
              label: "prune: report-jurisdiction",
              ids: reports.map((r) => r.id),
            })
          ).resolved
    const cleanupsResolved =
      cleanups.length === 0
        ? 0
        : (await backfillCleanupJurisdictions(tx, { ids: cleanups.map((c) => c.id) })).resolved
    const hoursRepair = await reresolveVolunteerHours(
      tx,
      hours.map((h) => h.id),
    )
    return {
      staleGeoids,
      affected,
      applied: true,
      reresolved: {
        reports: reportsResolved,
        cleanups: cleanupsResolved,
        volunteerHours: hoursRepair.resolved,
        rollups: hoursRepair.rollups,
      },
    }
  })
}

async function countPruneImpact(
  tx: Queryable,
  staleGeoids: string[],
): Promise<Record<PruneAffectedTable, number>> {
  const rows = await tx<Record<PruneAffectedTable, number>[]>`
    SELECT
      (SELECT count(*)::int FROM reports WHERE jurisdiction_geoid IN ${tx(staleGeoids)}) AS reports,
      (SELECT count(*)::int FROM cleanups WHERE jurisdiction_geoid IN ${tx(staleGeoids)}) AS cleanups,
      (SELECT count(*)::int FROM volunteer_hours WHERE jurisdiction_geoid IN ${tx(staleGeoids)}) AS volunteer_hours,
      (SELECT count(*)::int FROM gov_claims WHERE jurisdiction_geoid IN ${tx(staleGeoids)}) AS gov_claims,
      (SELECT count(*)::int FROM mail_threads WHERE jurisdiction_geoid IN ${tx(staleGeoids)}) AS mail_threads,
      (SELECT count(*)::int FROM user_jurisdiction_hours WHERE jurisdiction_geoid IN ${tx(staleGeoids)})
        AS user_jurisdiction_hours,
      (SELECT count(*)::int FROM jurisdiction_contacts WHERE geoid IN ${tx(staleGeoids)})
        AS jurisdiction_contacts,
      (SELECT count(*)::int FROM outreach_state WHERE geoid IN ${tx(staleGeoids)}) AS outreach_state,
      (SELECT count(*)::int FROM jurisdiction_discovery_tasks WHERE geoid IN ${tx(staleGeoids)})
        AS jurisdiction_discovery_tasks,
      (SELECT count(*)::int FROM jurisdictions WHERE geoid IN ${tx(staleGeoids)}) AS jurisdictions
  `
  return rows[0] ?? noneAffected()
}

/**
 * A volunteer_hours row carries the jurisdiction of the cleanup (or report) it credits, so it is
 * re-derived from that link, never from geometry of its own; an unlinked row stays NULL. Each
 * (user, jurisdiction) rollup it lands on is then recomputed from the ledger rather than adjusted,
 * which is what keeps it equal to the sum of its non-voided rows.
 */
async function reresolveVolunteerHours(
  tx: Queryable,
  hourIds: string[],
): Promise<{ resolved: number; rollups: number }> {
  if (hourIds.length === 0) return { resolved: 0, rollups: 0 }
  const resolved = await tx<{ user_id: string; jurisdiction_geoid: string; voided: boolean }[]>`
    UPDATE volunteer_hours vh
    SET jurisdiction_geoid = src.geoid
    FROM (
      SELECT h.id, COALESCE(c.jurisdiction_geoid, r.jurisdiction_geoid) AS geoid
      FROM volunteer_hours h
      LEFT JOIN cleanups c ON c.id = h.cleanup_id
      LEFT JOIN reports r ON r.id = h.report_id
      WHERE h.id = ANY(${hourIds}::uuid[])
    ) src
    WHERE vh.id = src.id
      AND vh.jurisdiction_geoid IS NULL
      AND src.geoid IS NOT NULL
    RETURNING vh.user_id, vh.jurisdiction_geoid, (vh.voided_at IS NOT NULL) AS voided
  `
  const pairs = new Map<string, { userId: string; geoid: string }>()
  for (const row of resolved) {
    if (row.voided) continue
    pairs.set(`${row.user_id}|${row.jurisdiction_geoid}`, {
      userId: row.user_id,
      geoid: row.jurisdiction_geoid,
    })
  }
  if (pairs.size === 0) return { resolved: resolved.length, rollups: 0 }
  const userIds = [...pairs.values()].map((p) => p.userId)
  const geoids = [...pairs.values()].map((p) => p.geoid)
  const rebuilt = await tx<{ user_id: string }[]>`
    INSERT INTO user_jurisdiction_hours (user_id, jurisdiction_geoid, total_hours)
    SELECT vh.user_id, vh.jurisdiction_geoid, SUM(vh.hours)
    FROM volunteer_hours vh
    JOIN unnest(${userIds}::uuid[], ${geoids}::text[]) AS p(user_id, geoid)
      ON vh.user_id = p.user_id AND vh.jurisdiction_geoid = p.geoid
    WHERE vh.voided_at IS NULL
    GROUP BY vh.user_id, vh.jurisdiction_geoid
    ON CONFLICT (user_id, jurisdiction_geoid)
    DO UPDATE SET total_hours = EXCLUDED.total_hours
    RETURNING user_id
  `
  return { resolved: resolved.length, rollups: rebuilt.length }
}
