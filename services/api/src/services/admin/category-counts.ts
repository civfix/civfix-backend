/**
 * The per-category report-count aggregate shared by every "waiting reports by category" query: the
 * outreach digest (outreach-repository.drizzle.ts), the jurisdiction directory + its unmapped bucket
 * (jurisdiction-contacts-repository.drizzle.ts). All three used to hand-roll the identical seven
 * `COUNT(*) FILTER (WHERE category = '…')` columns plus a matching seven-key parse block, so adding a
 * ReportCategory took seven coordinated edits; everything here derives from ADMIN_CATEGORIES instead.
 *
 * The counts are cast to text in SQL on purpose: postgres.js surfaces int8 without a lossless numeric
 * parser, so every count in this codebase crosses the wire as text and is parsed back here.
 */

import type { Queryable } from "../../db/client.js"
import { ReportCategorySchema, type ReportCategory } from "@civfix/shared"
import type { SqlFragment } from "./sql-fragments.js"

/**
 * The canonical ReportCategory list in schema (display) order, derived from the shared zod enum so a new
 * category cannot be half-added. Iteration order is load-bearing for the digest's contact-preference
 * `array_position` ordering and for the directory's coverage label.
 */
export const ADMIN_CATEGORIES: readonly ReportCategory[] = ReportCategorySchema.options

/** The `cat_<category>` text columns as selected back from SQL. */
export type CategoryCountRow = Partial<Record<`cat_${ReportCategory}`, string | null>>

/**
 * The aggregate columns: one `COUNT(*) FILTER (…)::text AS cat_<category>` per ReportCategory, filtered on
 * `<alias>.category`. Belongs in a GROUP BY / LATERAL aggregate over `reports`; the caller owns the
 * waiting predicate (the statuses differ between the digest and the directory).
 */
export function categoryCountsFragment(sql: Queryable, alias: string): SqlFragment {
  return joinColumns(
    sql,
    ADMIN_CATEGORIES.map(
      (category) =>
        sql`COUNT(*) FILTER (WHERE ${sql(alias)}.category = ${category})::text AS ${sql(`cat_${category}`)}`,
    ),
  )
}

/**
 * The outer projection over an aggregate produced by categoryCountsFragment: `COALESCE(<alias>.cat_x, '0')
 * AS cat_x` per category, so a jurisdiction with no matching report still yields a parseable row.
 */
export function categoryCountsProjection(sql: Queryable, alias: string): SqlFragment {
  return joinColumns(
    sql,
    ADMIN_CATEGORIES.map(
      (category) =>
        sql`COALESCE(${sql(alias)}.${sql(`cat_${category}`)}, '0') AS ${sql(`cat_${category}`)}`,
    ),
  )
}

/** Parse a text count column; absent/malformed reads as 0 (a missing aggregate row means "none"). */
export function parseCount(value: string | null | undefined): number {
  const n = Number.parseInt(value ?? "0", 10)
  return Number.isNaN(n) ? 0 : n
}

/** Turn the `cat_*` columns into the sparse per-category map the records carry (zeros are omitted). */
export function parseCategoryCounts(
  row: CategoryCountRow | undefined,
): Partial<Record<ReportCategory, number>> {
  const counts: Partial<Record<ReportCategory, number>> = {}
  if (row === undefined) return counts
  for (const category of ADMIN_CATEGORIES) {
    const n = parseCount(row[`cat_${category}`])
    if (n > 0) counts[category] = n
  }
  return counts
}

/** Comma-join column fragments (no trailing comma for an empty list). */
function joinColumns(sql: Queryable, parts: SqlFragment[]): SqlFragment {
  let out = sql``
  let first = true
  for (const part of parts) {
    out = first ? part : sql`${out}, ${part}`
    first = false
  }
  return out
}
