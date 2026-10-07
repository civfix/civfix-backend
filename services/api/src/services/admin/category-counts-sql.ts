// Counts are cast to text on purpose; category-counts.ts explains why and parses them back.

import type { Queryable, SqlFragment } from "../../db/client.js"
import { ADMIN_CATEGORIES } from "./category-counts.js"

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

function joinColumns(sql: Queryable, parts: SqlFragment[]): SqlFragment {
  const [first, ...rest] = parts
  if (first === undefined) return sql``
  return rest.reduce<SqlFragment>((acc, part) => sql`${acc}, ${part}`, first)
}
