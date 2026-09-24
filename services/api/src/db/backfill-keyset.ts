/**
 * TERMINATION: every loop pages with a strictly advancing cursor and advances past the whole batch,
 * including rows the batch left unchanged, so no row is visited twice and the loop ends on an empty page.
 * Each loop only selects rows whose target column IS NULL, so it is idempotent.
 *
 * `table` is a closed union of literal names, never user input, interpolated as a postgres.js identifier.
 *
 * Guard-free (no runIfMain) so bundled entries can import it; see ingest-jurisdictions-core.ts.
 */

import type postgres from "postgres"
import type { Queryable, Sql } from "./client.js"
import { TIME_CURSOR_SQL_FORMAT } from "./cursor-helpers.js"
import { UNKNOWN_JURCODE } from "./reference-code.js"
import { JURISDICTION_RESOLVE_ORDER_BY } from "./sql/jurisdiction.js"

type SqlFragment = postgres.Fragment

export type JurisdictionGeomTable = "reports" | "cleanups"

export type ReferenceCodeTable = "reports" | "cleanups"

/**
 * `stayedNull` counts points outside all loaded coverage, left NULL on purpose. `ids` narrows the pass
 * for a caller that must not touch rows it did not null itself.
 *
 * The polygon is picked with the same ordering constant the write-time resolver uses (a trusted,
 * code-defined string passed through `sql.unsafe`), so a backfilled row lands on exactly the jurisdiction
 * a fresh insert would have chosen.
 *
 * SHAPE: a CTE + join, not `UPDATE ... FROM LATERAL (... t.geom ...)`, because Postgres forbids a LATERAL
 * FROM-item from referencing the UPDATE target (42P10); inside the CTE's plain SELECT the correlation is
 * allowed.
 */
export async function resolveGeomJurisdictions(
  sql: Queryable,
  table: JurisdictionGeomTable,
  opts: { batchSize: number; label: string; ids?: readonly string[] },
): Promise<{ resolved: number; stayedNull: number }> {
  let resolved = 0
  let stayedNull = 0
  let cursor: string | null = null

  for (;;) {
    // The `: SqlFragment` annotation breaks the `sql` self-reference that would otherwise infer `any`.
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
    // Advance past the whole batch, including rows that stayed NULL, so they are never revisited.
    cursor = batch[batch.length - 1]!.id

    console.log(
      `${opts.label}: batch of ${batch.length} (resolved ${updated.length}, ` +
        `still null ${batch.length - updated.length}); running total resolved=${resolved}, ` +
        `still-null=${stayedNull}`,
    )
  }

  return { resolved, stayedNull }
}

export interface ReferenceCodeRow {
  id: string
  created_at: Date
  // The keyset bound. A millisecond Date bound sits below its own row, so a row that keeps failing at
  // the tail would be re-selected forever.
  cursor_at: string | null
  jur_code: number | null
}

/**
 * `spec.allocate` must use the shared reference_counters allocator the live create paths use, so a
 * backfill running alongside live traffic can never collide.
 *
 * Each row runs in its own transaction (allocate first, per the lock-order contract, then stamp), so a
 * failure can waste at most one counter value. A failed row is counted and logged, never fatal.
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
  let cursor: { at: string | null; id: string } | null = null
  const extraColumns: SqlFragment =
    spec.extraColumn === null ? sql`` : sql`, t.${sql(spec.extraColumn)}`

  for (;;) {
    const cursorFilter: SqlFragment =
      cursor === null
        ? sql``
        : sql`AND (t.created_at, t.id) > (${cursor.at}::timestamptz, ${cursor.id})`
    const batch = await sql<Row[]>`
      SELECT t.id, t.created_at,
        to_char(t.created_at AT TIME ZONE 'UTC', ${TIME_CURSOR_SQL_FORMAT}) AS cursor_at,
        j.code AS jur_code${extraColumns}
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
    cursor = { at: last.cursor_at, id: last.id }
    console.log(
      `${spec.label}: ${spec.table} batch of ${batch.length} (running stamped=${stamped}, failed=${failed})`,
    )
  }

  return { stamped, failed }
}
