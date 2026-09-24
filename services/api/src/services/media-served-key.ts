import type postgres from "postgres"
import type { Queryable } from "../db/client.js"

type SqlFragment = postgres.Fragment

export type MediaAlias = "m" | "am" | "ma" | "a" | "media_assets"

export function servedKeyExpr(sql: Queryable, alias: MediaAlias): SqlFragment {
  return sql`COALESCE(${sql(alias)}.served_key, CASE WHEN ${sql(alias)}.status = 'validating' THEN ${sql(alias)}.r2_key END)`
}

export function servableMediaFilter(sql: Queryable, alias: MediaAlias): SqlFragment {
  return sql`(${sql(alias)}.status = 'validating' OR (${sql(alias)}.status = 'ready' AND ${sql(alias)}.served_key IS NOT NULL))`
}

export function moderationMediaKeyExpr(sql: Queryable, alias: MediaAlias): SqlFragment {
  return sql`COALESCE(${sql(alias)}.served_key, CASE WHEN ${sql(alias)}.status <> 'ready' THEN ${sql(alias)}.r2_key END)`
}

export function moderationMediaFilter(sql: Queryable, alias: MediaAlias): SqlFragment {
  return sql`(${sql(alias)}.status <> 'ready' OR ${sql(alias)}.served_key IS NOT NULL)`
}
