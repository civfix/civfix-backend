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

// A legacy contact_emails address has no bounce column: the bounce handler leaves only a 'bounced'
// mail_events row on the jurisdiction's thread (or a bounced_at on a matching per-category row). Events
// older than the last contact save are ignored, the same scoping the directory's bounced flag uses, so
// re-entering a fixed address makes it usable again.
export function legacyContactEmailUsable(
  sql: Queryable,
  refs: { email: SqlFragment; geoid: SqlFragment; contactUpdatedAt: SqlFragment },
): SqlFragment {
  return sql`
    NOT EXISTS (
      SELECT 1 FROM jurisdiction_contacts bc
      WHERE bc.geoid = ${refs.geoid} AND bc.bounced_at IS NOT NULL
        AND lower(bc.email) = lower(${refs.email})
    )
    AND NOT EXISTS (
      SELECT 1 FROM mail_events me
      JOIN mail_threads mt ON mt.id = me.thread_id
      WHERE mt.jurisdiction_geoid = ${refs.geoid} AND me.type = 'bounced'
        AND lower(me.meta->>'failedRecipient') = lower(${refs.email})
        AND me.created_at > COALESCE(${refs.contactUpdatedAt}, '-infinity'::timestamptz)
    )
  `
}

// One definition of a routable contact for every reader that sends a packet or reports a report as
// routable, so a hard-bounced address stops receiving packets everywhere at once.
export function usableContactRowExpr(sql: Queryable, jcAlias: string): SqlFragment {
  const jc = sql(jcAlias)
  return sql`${jc}.email IS NOT NULL AND btrim(${jc}.email) <> '' AND ${jc}.bounced_at IS NULL`
}

export function firstUsableLegacyContactExpr(sql: Queryable, jAlias: string): SqlFragment {
  const j = sql(jAlias)
  return sql`(
    SELECT ulc.v FROM unnest(COALESCE(${j}.contact_emails, '{}'::text[])) WITH ORDINALITY AS ulc(v, ord)
    WHERE btrim(ulc.v) <> ''
      AND ${legacyContactEmailUsable(sql, {
        email: sql`ulc.v`,
        geoid: sql`${j}.geoid`,
        contactUpdatedAt: sql`${j}.contact_updated_at`,
      })}
    ORDER BY ulc.ord
    LIMIT 1
  )`
}

export function reportRoutableExpr(sql: Queryable, rAlias: string): SqlFragment {
  const r = sql(rAlias)
  return sql`(
    EXISTS (
      SELECT 1 FROM jurisdiction_contacts rrjc
      WHERE rrjc.geoid = ${r}.jurisdiction_geoid
        AND ${usableContactRowExpr(sql, "rrjc")}
        AND (rrjc.category IS NULL OR rrjc.category = ${r}.category)
    )
    OR EXISTS (
      SELECT 1 FROM jurisdictions rrj
      WHERE rrj.geoid = ${r}.jurisdiction_geoid
        AND ${firstUsableLegacyContactExpr(sql, "rrj")} IS NOT NULL
    )
  )`
}
