/**
 * Shared keyset-cursor batch loops for the offline backfill CLIs.
 *
 * Two shapes were copy-pasted four times across backfill-jurisdictions-core.ts and
 * backfill-reference-codes-core.ts — the geom -> jurisdiction_geoid resolver (reports, cleanups) and the
 * reference-code stamper (reports, cleanups) — differing only in the table name, batch size and log label.
 * They live here once so termination, cursor advance and idempotency semantics have a single home.
 *
 * KEYSET CURSOR & TERMINATION: every loop pages with a STRICTLY advancing cursor and advances past the
 * WHOLE batch, including rows the batch left unchanged, so no row is visited twice and the loop ends when a
 * page comes back empty. Each loop is idempotent — it only selects rows whose target column IS NULL.
 *
 * `table` is a closed union of module-literal names (never user input), interpolated as a postgres.js
 * identifier (`sql(table)`) — the same house rule as makeMentionRepo / chat-reply-hydration. Geometry flows
 * ONLY through the raw `sql` tag, never Drizzle.
 *
 * No `main()` and no run-as-CLI guard here, so bundled entries can import this module freely (see
 * ingest-jurisdictions-core.ts for the tsup-bundling rationale behind the guard-free cores).
 */

import type postgres from "postgres"
import type { Queryable, Sql } from "./client.js"
import { UNKNOWN_JURCODE } from "./reference-code.js"
import { JURISDICTION_RESOLVE_ORDER_BY } from "./sql/jurisdiction.js"

type SqlFragment = postgres.Fragment

/** Tables carrying a `geom` + `jurisdiction_geoid` pair the spatial resolver can fill in. */
export type JurisdictionGeomTable = "reports" | "cleanups"

/** Tables carrying a `reference_code` + `jurisdiction_geoid` pair. */
export type ReferenceCodeTable = "reports" | "cleanups"

/**
 * Re-resolve every NULL `<table>.jurisdiction_geoid` from the row's own `geom`, in keyset-cursor batches
 * over the id. Returns `resolved` (rows that got a non-NULL geoid) and `stayedNull` (points outside all
 * loaded coverage, left NULL on purpose). `ids` narrows the pass to those rows, for a caller that must not
 * touch rows it did not null itself.
 *
 * The candidate polygon is picked with the SHARED ordering constant the write-time resolver uses
 * (JURISDICTION_RESOLVE_ORDER_BY via `sql.unsafe` — a trusted, code-defined string, never user input), so a
 * backfilled row lands on exactly the jurisdiction a fresh insert would have chosen.
 *
 * SHAPE: a CTE + join, NOT `UPDATE <table> t ... FROM LATERAL (... t.geom ...)`: Postgres forbids a LATERAL
 * FROM-item from referencing the UPDATE target table (42P10). Inside the CTE's plain SELECT the correlation
 * IS allowed. Rows outside every polygon resolve to a NULL geoid, are filtered by `m.geoid IS NOT NULL` ->
 * stay NULL -> absent from RETURNING. The IN(...) / IS NULL guards keep the statement idempotent.
 */
export async function resolveGeomJurisdictions(
  sql: Queryable,
  table: JurisdictionGeomTable,
  opts: { batchSize: number; label: string; ids?: readonly string[] },
): Promise<{ resolved: number; stayedNull: number }> {
  let resolved = 0
  let stayedNull = 0
  // The keyset cursor: the last id already paged past. NULL on the first iteration (no lower bound).
  let cursor: string | null = null

  for (;;) {
    // Strict lower bound for this page, lifted into an explicitly-typed fragment (the codebase convention;
    // the `: SqlFragment` annotation breaks the `sql` self-reference that would otherwise infer `any`).
    const cursorFilter: SqlFragment = cursor === null ? sql`` : sql`AND id > ${cursor}`
    const idFilter: SqlFragment =
      opts.ids === undefined ? sql`` : sql`AND id = ANY(${opts.ids as string[]}::uuid[])`
    const batch = await sql<{ id: string }[]>`
      SELECT id
      FROM ${sql(table)}
      WHERE jurisdiction_geoid IS NULL
        ${cursorFilter}
        ${idFilter}
      ORDER BY id
      LIMIT ${opts.batchSize}
    `
    if (batch.length === 0) break

    const batchIds = batch.map((b) => b.id)
    const updated = await sql<{ id: string }[]>`
      WITH matches AS (
        SELECT
          t.id,
          (
            SELECT geoid
            FROM jurisdictions
            WHERE ST_Contains(geom, t.geom)
            ORDER BY ${sql.unsafe(JURISDICTION_RESOLVE_ORDER_BY)}
            LIMIT 1
          ) AS geoid
        FROM ${sql(table)} t
        WHERE t.jurisdiction_geoid IS NULL
          AND t.id IN ${sql(batchIds)}
      )
      UPDATE ${sql(table)} t
      SET jurisdiction_geoid = m.geoid
      FROM matches m
      WHERE t.id = m.id
        AND m.geoid IS NOT NULL
      RETURNING t.id
    `

    resolved += updated.length
    stayedNull += batch.length - updated.length
    // Advance past the whole batch — including rows that stayed NULL — so they are never revisited.
    cursor = batch[batch.length - 1]!.id

    console.log(
      `${opts.label}: batch of ${batch.length} (resolved ${updated.length}, ` +
        `still null ${batch.length - updated.length}); running total resolved=${resolved}, ` +
        `still-null=${stayedNull}`,
    )
  }

  return { resolved, stayedNull }
}

/** The columns every reference-code loop selects; `Row` adds whatever else its allocator needs. */
export interface ReferenceCodeRow {
  id: string
  /** timestamptz — postgres.js returns a Date, and the driver serializes it back for the cursor bound. */
  created_at: Date
  /** jurisdictions.code joined through jurisdiction_geoid; NULL when unresolved or the row has no code. */
  jur_code: number | null
}

/**
 * Stamp `<table>.reference_code` for every row still NULL, oldest-first (created_at ASC, id ASC for a
 * stable tiebreak), in keyset-cursor batches. For each row the JURCODE comes from the joined
 * jurisdictions.code (UNKNOWN_JURCODE/0 when unresolved), `spec.allocate` mints the code from the SHARED
 * reference_counters allocator — the same one the live create paths use, so a backfill running concurrently
 * with live traffic can never collide — and the row is stamped. Returns how many rows were stamped.
 *
 * Each row runs in its OWN transaction: allocate (FIRST, per the reference-code lock-order contract) +
 * stamp commit together, so a mid-batch failure cannot leak a consumed counter value against an un-stamped
 * row beyond that single row. A failed row is counted and logged, never fatal.
 *
 * `spec.extraColumn` is the one extra column the allocator needs (reports: `type`); NULL selects none.
 */
export async function stampReferenceCodes<Row extends ReferenceCodeRow>(
  sql: Sql,
  spec: {
    table: ReferenceCodeTable
    batchSize: number
    label: string
    extraColumn: "type" | null
    allocate: (tx: Queryable, row: Row, jurCode: number) => Promise<string>
  },
): Promise<{ stamped: number; failed: number }> {
  let stamped = 0
  let failed = 0
  // Keyset cursor over (created_at, id). NULL on the first page (no lower bound).
  let cursor: { createdAt: Date; id: string } | null = null
  const extraColumns: SqlFragment =
    spec.extraColumn === null ? sql`` : sql`, t.${sql(spec.extraColumn)}`

  for (;;) {
    const cursorFilter: SqlFragment =
      cursor === null ? sql`` : sql`AND (t.created_at, t.id) > (${cursor.createdAt}, ${cursor.id})`
    const batch = await sql<Row[]>`
      SELECT t.id, t.created_at, j.code AS jur_code${extraColumns}
      FROM ${sql(spec.table)} t
      LEFT JOIN jurisdictions j ON j.geoid = t.jurisdiction_geoid
      WHERE t.reference_code IS NULL
        ${cursorFilter}
      ORDER BY t.created_at, t.id
      LIMIT ${spec.batchSize}
    `
    if (batch.length === 0) break

    for (const row of batch) {
      const jurCode = row.jur_code ?? UNKNOWN_JURCODE
      try {
        await sql.begin(async (tx) => {
          const code = await spec.allocate(tx, row, jurCode)
          await tx`
            UPDATE ${tx(spec.table)}
            SET reference_code = ${code}
            WHERE id = ${row.id} AND reference_code IS NULL
          `
        })
        stamped += 1
      } catch (err) {
        failed += 1
        console.error(`${spec.label}: ${spec.table} ${row.id} failed: ${(err as Error).message}`)
      }
    }

    const last = batch[batch.length - 1]!
    cursor = { createdAt: last.created_at, id: last.id }
    console.log(
      `${spec.label}: ${spec.table} batch of ${batch.length} (running stamped=${stamped}, failed=${failed})`,
    )
  }

  return { stamped, failed }
}
