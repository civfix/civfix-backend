import type postgres from "postgres"
import type { Queryable } from "../../db/client.js"
import { likeContains } from "./like.js"

export type SqlFragment = postgres.Fragment

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
  const ored = branches
    .slice(1)
    .reduce<SqlFragment>((acc, branch) => sql`${acc} OR ${branch}`, first)
  return sql`(${ored})`
}

export function andAll(sql: Queryable, conds: readonly SqlFragment[]): SqlFragment {
  return conds.reduce<SqlFragment>((acc, cond) => sql`${acc} ${cond}`, sql``)
}

export function jurisdictionHasAnyContactExpr(sql: Queryable, jAlias: string): SqlFragment {
  const j = sql(jAlias)
  return sql`(
    EXISTS (
      SELECT 1 FROM unnest(COALESCE(${j}.contact_emails, '{}'::text[])) AS jhce(v)
      WHERE btrim(jhce.v) <> ''
    )
    OR EXISTS (
      SELECT 1 FROM jurisdiction_contacts jhc
      WHERE jhc.geoid = ${j}.geoid AND jhc.email IS NOT NULL AND btrim(jhc.email) <> ''
    )
  )`
}

export function reportRoutableExpr(sql: Queryable, rAlias: string): SqlFragment {
  const r = sql(rAlias)
  return sql`(
    EXISTS (
      SELECT 1 FROM jurisdictions rrj
      WHERE rrj.geoid = ${r}.jurisdiction_geoid
        AND EXISTS (
          SELECT 1 FROM unnest(COALESCE(rrj.contact_emails, '{}'::text[])) AS rrje(v)
          WHERE btrim(rrje.v) <> ''
        )
    )
    OR EXISTS (
      SELECT 1 FROM jurisdiction_contacts rrjc
      WHERE rrjc.geoid = ${r}.jurisdiction_geoid
        AND rrjc.email IS NOT NULL AND btrim(rrjc.email) <> ''
        AND (rrjc.category IS NULL OR rrjc.category = ${r}.category)
    )
  )`
}
