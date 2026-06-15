/**
 * Backfill CLI (Phase 5): re-resolve `reports.jurisdiction_geoid` for rows where it IS NULL.
 *
 * WHY THIS EXISTS. Jurisdiction resolution happens ONCE, at insert time — report-service.ts and
 * anon-service.ts call `resolveJurisdictionGeoid(lat, lng)` when the row is created and never again.
 * So any report inserted while the `jurisdictions` table was empty (or while coverage was incomplete)
 * was stamped with a NULL `jurisdiction_geoid` and stays NULL forever — those rows do NOT self-heal
 * when boundaries are later loaded. After an `ingest` run populates real boundaries, this CLI sweeps
 * the existing NULL rows and stamps each with the jurisdiction whose polygon now contains its point.
 *
 * ONE RANKING, NEVER DRIFTS. The UPDATE orders candidate polygons by the SAME shared constant the
 * write-time resolver uses — JURISDICTION_LAYER_RANK_CASE from src/db/sql/jurisdiction.ts — embedded
 * here via `sql.unsafe(...)` (the string is trusted, code-defined, never user input). A backfilled row
 * therefore resolves IDENTICALLY to how a fresh insert at the same point would resolve
 * (federal -> tribal -> place -> county -> state, most-specific wins, LIMIT 1).
 *
 * SCOPE — reports ONLY. Despite the task framing of "reports AND cleanups", the `cleanups` table has
 * NO `jurisdiction_geoid` column (see drizzle/0001_core.sql: cleanups is id/organizer/type/title/
 * description/geom/scheduled_at/status/bring/created_at — no jurisdiction FK), no schema field, and no
 * write-time resolver call. Backfilling cleanups is therefore impossible under Design A's
 * no-schema-change constraint; it is deferred to Design B (which would add a 0013 migration with
 * `cleanups.jurisdiction_geoid` plus a write-time resolver in cleanup-service, then a sibling sweep
 * here). Only `reports`, `gov_claims`, and `mail_threads` carry a jurisdiction_geoid today, and of
 * those only `reports` is point-geometry-resolvable.
 *
 * KEYSET-CURSOR LOOP & TERMINATION. We page over `reports.id` (the UUID primary key — total ordering,
 * always indexed, never reused) with a strictly-advancing cursor, BATCH_SIZE rows at a time:
 *   1. SELECT the next batch of NULL-jurisdiction report ids with `id > cursor`, ORDER BY id.
 *   2. UPDATE that batch in place, resolving each point against the jurisdictions table.
 *   3. Advance the cursor to the LAST id of the batch.
 * A row that resolves to NULL (its point falls outside every loaded boundary) KEEPS its NULL
 * jurisdiction_geoid, but because the cursor moved past its id it is never re-selected — so every row
 * is visited AT MOST ONCE and forward progress is guaranteed. The loop ends when a SELECT returns zero
 * rows. (Without the cursor, NULL-staying rows would be re-selected forever — the cursor is what makes
 * the "outside all coverage" case terminate.)
 *
 * IDEMPOTENT & CRASH-SAFE. Every statement is `WHERE jurisdiction_geoid IS NULL`, so already-resolved
 * rows are inert and re-running the CLI is safe. postgres-js auto-commits each tagged query, so each
 * batch's progress is durable independently — a crash mid-run loses only the in-flight batch, and a
 * re-run simply resumes over whatever is still NULL.
 *
 * Requires DATABASE_URL + live Postgres/PostGIS; not exercised by the offline unit suite (the keyset
 * loop is covered by the Testcontainers integration harness, which skips without Docker). The pure,
 * DB-free part of this change — the shared ranking constant — is unit-tested in jurisdiction-backfill.test.ts.
 */

import { fileURLToPath } from "node:url"
import type postgres from "postgres"
import type { Sql } from "./client.js"
import { makeDb } from "./client.js"
import { loadEnv } from "../env.js"
import { JURISDICTION_LAYER_RANK_CASE } from "./sql/jurisdiction.js"

/** A composable SQL fragment (postgres.js Fragment); what a `sql\`...\`` expression yields. */
type SqlFragment = postgres.Fragment

/**
 * How many reports to select + update per round-trip. Large enough to amortize the per-batch latency,
 * small enough to keep each UPDATE's spatial work (a GiST-indexed ST_Contains per row) bounded and the
 * transaction short.
 */
const BATCH_SIZE = 1000

/**
 * Re-resolve every `reports.jurisdiction_geoid` that is currently NULL, in keyset-cursor batches.
 * Returns a summary: `resolved` = rows that got a non-NULL geoid stamped, `stayedNull` = rows whose
 * point still falls outside all loaded coverage (left NULL on purpose).
 *
 * Factored out of `main()` (takes a raw `sql` tag, returns counts, logs progress) so the Testcontainers
 * integration harness can drive the exact same loop against a seeded database.
 *
 * @param sql raw postgres-js tag (e.g. dbHandle.sql). Geometry goes ONLY through this raw tag —
 *   ST_Contains against `reports.geom` (already geometry(Point, 4326)); never through Drizzle.
 */
export async function backfillReports(sql: Sql): Promise<{ resolved: number; stayedNull: number }> {
  let resolved = 0
  let stayedNull = 0
  // The keyset cursor: the last report id we have already paged past. NULL on the first iteration
  // (no lower bound). Strictly increases every batch, guaranteeing termination.
  let cursor: string | null = null

  for (;;) {
    // Strict lower bound for this page. Computed into an EXPLICITLY-TYPED fragment variable before the
    // query (the codebase convention for conditional WHERE clauses — see the `SqlFragment` annotations in
    // admin-report-repository.drizzle.ts) rather than inlined. Two things are load-bearing here:
    //   1. The explicit `: SqlFragment` annotation. Without it, the ternary `cursor === null ? sql`` :
    //      sql`AND id > ${cursor}`` references `sql` inside its own initializer, so TypeScript cannot
    //      resolve the generic and infers `cursorFilter` (and then `batch`, then `b`) as `any`
    //      (TS7022/TS7006). Pinning the type to `postgres.Fragment` breaks that self-reference.
    //   2. Lifting it out of the template avoids inlining a `sql`-returning ternary into the outer tag.
    // The first iteration has no lower bound (empty fragment).
    const cursorFilter: SqlFragment = cursor === null ? sql`` : sql`AND id > ${cursor}`
    // Next page of still-NULL report ids, strictly after the cursor, in id order. ORDER BY id makes
    // the scan deterministic and lets the cursor advance monotonically.
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
    // subquery picks the single best polygon per report using the SHARED ranking constant (embedded via
    // sql.unsafe — trusted, code-defined, identical to the write-time resolver). Rows whose point falls
    // outside every polygon match nothing in the LATERAL, so the UPDATE skips them (they stay NULL) and
    // they are simply absent from RETURNING — hence `updated.length` = rows that actually got a geoid.
    // The `r.id IN (...)` / `IS NULL` guards re-confirm the batch and keep the statement idempotent.
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
    // Advance past the whole batch — including the rows that stayed NULL — so they are never revisited.
    cursor = batch[batch.length - 1]!.id

    console.log(
      `backfill: batch of ${batch.length} (resolved ${updated.length}, still null ${batch.length - updated.length}); ` +
        `running total resolved=${resolved}, still-null=${stayedNull}`,
    )
  }

  return { resolved, stayedNull }
}

async function main(): Promise<void> {
  const env = loadEnv()
  const handle = makeDb(env.DATABASE_URL, { max: 1 })
  try {
    const { resolved, stayedNull } = await backfillReports(handle.sql)
    console.log(
      `backfill: done — ${resolved} reports resolved to a jurisdiction, ` +
        `${stayedNull} still null (point outside all loaded coverage)`,
    )
  } finally {
    await handle.close()
  }
}

// Run only when executed directly (tsx src/db/backfill-jurisdictions.ts), not when imported by the
// integration harness/tests.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error("backfill: failed")
    console.error(err)
    process.exit(1)
  })
}
