/**
 * Shared composable-SQL helpers for the admin repos, beside like.ts (which owns the ESCAPING rule these
 * build on).
 *
 * Four admin repos each hand-rolled the same two shapes: an ILIKE-over-N-columns search predicate and the
 * reduce that folds a list of optional conditions into one WHERE tail. Duplicating the search shape is how
 * one copy loses its `ESCAPE '\\'` (or its escaping entirely) without any single file looking wrong — the
 * exact drift like.ts exists to prevent. One definition each, here.
 *
 * Columns are passed as FRAGMENTS, not strings: a column may be an expression (`u.handle::text`), which
 * identifier-escaping cannot express, and a caller-built fragment keeps the values parameterized.
 */

import type postgres from "postgres"
import type { Queryable } from "../../db/client.js"
import { likeContains } from "./like.js"

/** A composable SQL fragment (postgres.js Fragment); what a `sql\`...\`` expression yields. */
export type SqlFragment = postgres.Fragment

/**
 * Build `(col1 ILIKE %term% OR col2 ILIKE %term% OR ...<extraBranches>)` with the term escaped to match
 * LITERALLY (see like.ts). `extraBranches` carries the non-ILIKE alternatives a search may add — the
 * `OR r.id = $1::uuid` exact-id branch, or an EXISTS probe — already parenthesized by their builder.
 * Yields `(false)` when there is nothing to match on, so the caller's `AND (...)` stays valid SQL.
 */
export function ilikeAnyOf(
  sql: Queryable,
  columns: readonly SqlFragment[],
  term: string,
  extraBranches: readonly SqlFragment[] = [],
): SqlFragment {
  const like = likeContains(term)
  const branches: SqlFragment[] = [
    ...columns.map((col) => sql`${col} ILIKE ${like} ESCAPE '\\'`),
    ...extraBranches,
  ]
  const first = branches[0]
  if (first === undefined) return sql`(false)`
  const ored = branches.slice(1).reduce<SqlFragment>((acc, branch) => sql`${acc} OR ${branch}`, first)
  return sql`(${ored})`
}

/**
 * Concatenate condition fragments into one WHERE tail. Each fragment carries its OWN leading `AND ` (the
 * repos' convention, so the same fragment can also be interpolated directly into a query that has no
 * condition list) and an empty `sql\`\`` contributes nothing.
 */
export function andAll(sql: Queryable, conds: readonly SqlFragment[]): SqlFragment {
  return conds.reduce<SqlFragment>((acc, cond) => sql`${acc} ${cond}`, sql``)
}
