// The counts are cast to text in SQL on purpose: postgres.js surfaces int8 without a lossless numeric
// parser, so every count in this codebase crosses the wire as text and is parsed back here.

import type { Queryable } from "../../db/client.js"
import { ReportCategorySchema, type ReportCategory } from "@civfix/shared"
import type { SqlFragment } from "./sql-fragments.js"

/**
 * Derived from the shared zod enum so a new category cannot be half-added. Iteration order is
 * load-bearing for the digest's contact-preference `array_position` ordering and the directory's coverage
 * label.
 */
export const ADMIN_CATEGORIES: readonly ReportCategory[] = ReportCategorySchema.options

export type CategoryCountRow = Partial<Record<`cat_${ReportCategory}`, string | null>>

// The caller owns the waiting predicate: the statuses differ between the digest and the directory.
export function categoryCountsFragment(sql: Queryable, alias: string): SqlFragment {
  return joinColumns(
    sql,
    ADMIN_CATEGORIES.map(
      (category) =>
        sql`COUNT(*) FILTER (WHERE ${sql(alias)}.category = ${category})::text AS ${sql(`cat_${category}`)}`,
    ),
  )
}

// COALESCE so a jurisdiction with no matching report still yields a parseable row.
export function categoryCountsProjection(sql: Queryable, alias: string): SqlFragment {
  return joinColumns(
    sql,
    ADMIN_CATEGORIES.map(
      (category) =>
        sql`COALESCE(${sql(alias)}.${sql(`cat_${category}`)}, '0') AS ${sql(`cat_${category}`)}`,
    ),
  )
}

// A missing aggregate row means "none", so absent or malformed reads as 0.
export function parseCount(value: string | null | undefined): number {
  const n = Number.parseInt(value ?? "0", 10)
  return Number.isNaN(n) ? 0 : n
}

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

function joinColumns(sql: Queryable, parts: SqlFragment[]): SqlFragment {
  const [first, ...rest] = parts
  if (first === undefined) return sql``
  return rest.reduce<SqlFragment>((acc, part) => sql`${acc}, ${part}`, first)
}
