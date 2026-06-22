/**
 * Reference-code backfill CORE: the pure, side-effect-free keyset loops that stamp historical
 * reports + cleanups with reference codes (issue #56). No `main()`, no CLI guard, so this module is safe
 * to import from anywhere (the CLI shell backfill-reference-codes.ts imports it). See
 * ingest-jurisdictions-core.ts for the full tsup-bundling rationale behind the guard-free split.
 *
 * RACE-FREE BY DESIGN: every code is minted through the SAME reference_counters allocator
 * (allocateNextSeq) that the live create paths use, so a backfill running AFTER deploy — concurrently
 * with live traffic minting fresh codes — can never collide. Idempotent: each loop only touches rows
 * whose reference_code IS NULL, and a KEYSET CURSOR guarantees termination even for rows that stay NULL.
 *
 * H3: run this as a SEPARATE post-deploy script, NEVER inside the migration transaction (a long table
 * scan/rewrite would block boot).
 */

import type { ReportType } from "@civfix/shared"
import type postgres from "postgres"
import type { Sql } from "./client.js"
import {
  UNKNOWN_JURCODE,
  allocateReportReferenceCode,
  allocateEventReferenceCode,
} from "./reference-code.js"
import { JURISDICTION_LAYER_RANK_CASE } from "./sql/jurisdiction.js"

type SqlFragment = postgres.Fragment

const BATCH_SIZE = 500

/**
 * Backfill `reports.reference_code` for every report still NULL, oldest-first (created_at ASC, id ASC for
 * a stable tiebreak), in keyset-cursor batches. For each report: derive the TYPECODE from `reports.type`
 * (via the shared map inside allocateReportReferenceCode, M6), the JURCODE from the report's jurisdiction
 * (jurisdictions.code; UNKNOWN_JURCODE/0 when unresolved or the joined code is NULL), allocate the next
 * code from the shared counter, and UPDATE the row. Each row is allocated + updated independently so one
 * failure cannot abort the whole run. Returns how many rows were stamped.
 */
export async function backfillReportReferenceCodes(sql: Sql): Promise<{ stamped: number; failed: number }> {
  let stamped = 0
  let failed = 0
  // Keyset cursor over (created_at, id). Null on the first page (no lower bound).
  let cursor: { createdAt: string; id: string } | null = null

  for (;;) {
    const cursorFilter: SqlFragment =
      cursor === null
        ? sql``
        : sql`AND (r.created_at, r.id) > (${cursor.createdAt}, ${cursor.id})`
    const batch = await sql<
      { id: string; created_at: string; type: ReportType; jur_code: number | null }[]
    >`
      SELECT r.id, r.created_at, r.type, j.code AS jur_code
      FROM reports r
      LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
      WHERE r.reference_code IS NULL
        ${cursorFilter}
      ORDER BY r.created_at, r.id
      LIMIT ${BATCH_SIZE}
    `
    if (batch.length === 0) break

    for (const row of batch) {
      const jurCode = row.jur_code ?? UNKNOWN_JURCODE
      try {
        // Each row in its own tx: allocate (FIRST) + stamp commit together, so a mid-batch failure can't
        // leak a consumed counter value against an un-stamped row beyond that single row.
        await sql.begin(async (tx) => {
          const code = await allocateReportReferenceCode(tx, row.type, jurCode)
          await tx`UPDATE reports SET reference_code = ${code} WHERE id = ${row.id} AND reference_code IS NULL`
        })
        stamped += 1
      } catch (err) {
        failed += 1
        console.error(`reference-codes: report ${row.id} failed: ${(err as Error).message}`)
      }
    }

    const last = batch[batch.length - 1]!
    cursor = { createdAt: last.created_at, id: last.id }
    console.log(`reference-codes: reports batch of ${batch.length} (running stamped=${stamped}, failed=${failed})`)
  }

  return { stamped, failed }
}

/**
 * Resolve `cleanups.jurisdiction_geoid` for every cleanup still NULL, using the SAME point-in-polygon SQL
 * + ranking constant as the write-time resolver (resolveForPoint / JURISDICTION_LAYER_RANK_CASE), so the
 * EVENT JURCODE matches what a fresh create would assign. Keyset-batched over cleanups.id, idempotent
 * (only touches NULL rows). Returns how many got a non-NULL geoid. Geometry flows ONLY through the raw tag.
 */
export async function backfillCleanupJurisdictions(
  sql: Sql,
): Promise<{ resolved: number; stayedNull: number }> {
  let resolved = 0
  let stayedNull = 0
  let cursor: string | null = null

  for (;;) {
    const cursorFilter: SqlFragment = cursor === null ? sql`` : sql`AND id > ${cursor}`
    const batch = await sql<{ id: string }[]>`
      SELECT id
      FROM cleanups
      WHERE jurisdiction_geoid IS NULL
        ${cursorFilter}
      ORDER BY id
      LIMIT ${BATCH_SIZE}
    `
    if (batch.length === 0) break
    const batchIds = batch.map((b) => b.id)

    // Same correlated-subquery + ranking shape as backfill-jurisdictions-core (reports), against
    // cleanups.geom. Rows outside every polygon resolve to NULL and stay NULL (absent from RETURNING).
    const updated = await sql<{ id: string }[]>`
      WITH matches AS (
        SELECT
          c.id,
          (
            SELECT geoid
            FROM jurisdictions
            WHERE ST_Contains(geom, c.geom)
            ORDER BY ${sql.unsafe(JURISDICTION_LAYER_RANK_CASE)}
            LIMIT 1
          ) AS geoid
        FROM cleanups c
        WHERE c.jurisdiction_geoid IS NULL
          AND c.id IN ${sql(batchIds)}
      )
      UPDATE cleanups c
      SET jurisdiction_geoid = m.geoid
      FROM matches m
      WHERE c.id = m.id
        AND m.geoid IS NOT NULL
      RETURNING c.id
    `

    resolved += updated.length
    stayedNull += batch.length - updated.length
    cursor = batch[batch.length - 1]!.id
    console.log(
      `reference-codes: cleanup-jurisdiction batch of ${batch.length} (resolved ${updated.length}); ` +
        `running resolved=${resolved}, still-null=${stayedNull}`,
    )
  }

  return { resolved, stayedNull }
}

/**
 * Backfill `cleanups.reference_code` for every cleanup still NULL, oldest-first, in keyset-cursor batches.
 * JURCODE comes from the cleanup's jurisdiction (jurisdictions.code; UNKNOWN_JURCODE/0 when unresolved),
 * the code is allocated from the shared EVENT counter, and the row is stamped. Each row independent +
 * idempotent. Run AFTER backfillCleanupJurisdictions so the JURCODE is resolved. Returns how many stamped.
 */
export async function backfillCleanupReferenceCodes(
  sql: Sql,
): Promise<{ stamped: number; failed: number }> {
  let stamped = 0
  let failed = 0
  let cursor: { createdAt: string; id: string } | null = null

  for (;;) {
    const cursorFilter: SqlFragment =
      cursor === null
        ? sql``
        : sql`AND (c.created_at, c.id) > (${cursor.createdAt}, ${cursor.id})`
    const batch = await sql<{ id: string; created_at: string; jur_code: number | null }[]>`
      SELECT c.id, c.created_at, j.code AS jur_code
      FROM cleanups c
      LEFT JOIN jurisdictions j ON j.geoid = c.jurisdiction_geoid
      WHERE c.reference_code IS NULL
        ${cursorFilter}
      ORDER BY c.created_at, c.id
      LIMIT ${BATCH_SIZE}
    `
    if (batch.length === 0) break

    for (const row of batch) {
      const jurCode = row.jur_code ?? UNKNOWN_JURCODE
      try {
        await sql.begin(async (tx) => {
          const code = await allocateEventReferenceCode(tx, jurCode)
          await tx`UPDATE cleanups SET reference_code = ${code} WHERE id = ${row.id} AND reference_code IS NULL`
        })
        stamped += 1
      } catch (err) {
        failed += 1
        console.error(`reference-codes: cleanup ${row.id} failed: ${(err as Error).message}`)
      }
    }

    const last = batch[batch.length - 1]!
    cursor = { createdAt: last.created_at, id: last.id }
    console.log(`reference-codes: cleanups batch of ${batch.length} (running stamped=${stamped}, failed=${failed})`)
  }

  return { stamped, failed }
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
