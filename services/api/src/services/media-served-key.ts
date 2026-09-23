import type postgres from "postgres"
import type { Queryable } from "../db/client.js"

type SqlFragment = postgres.Fragment

export type MediaAlias = "m" | "am" | "ma" | "a" | "lm" | "media_assets"

// Falls back to the uploaded original while the worker has not produced a served copy, so it is only
// for readers gated to the uploader that presign privately: a report's owner, and through
// uploaderServedKeyExpr the sender of a chat or DM attachment.
export function servedKeyExpr(sql: Queryable, alias: MediaAlias): SqlFragment {
  return sql`COALESCE(${sql(alias)}.served_key, CASE WHEN ${sql(alias)}.status = 'validating' THEN ${sql(alias)}.r2_key END)`
}

// Until the worker marks an asset ready, its r2_key holds the uploader's raw bytes: not re-encoded, EXIF
// GPS intact, unchecked. Every read shown to anyone but the uploader resolves only the ready served copy
// and yields no key otherwise, which the clients render as missing media.
export function publicServedKeyExpr(sql: Queryable, alias: MediaAlias): SqlFragment {
  return sql`CASE WHEN ${sql(alias)}.status = 'ready' THEN ${sql(alias)}.served_key END`
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

// A chat attachment is read by every room member, so the raw fallback is decided per row: the member who
// uploaded it sees their own photo at once, everyone else only the ready served copy. viewerUploader is
// null for a reader with no identity, which compares as unknown and so never matches.
export function uploaderServedKeyExpr(
  sql: Queryable,
  alias: MediaAlias,
  viewerUploader: string | null,
): SqlFragment {
  return sql`CASE WHEN ${sql(alias)}.uploader = ${viewerUploader} THEN ${servedKeyExpr(sql, alias)} ELSE ${publicServedKeyExpr(sql, alias)} END`
}

export function uploaderServableFilter(
  sql: Queryable,
  alias: MediaAlias,
  viewerUploader: string | null,
): SqlFragment {
  return sql`${servableMediaFilter(sql, alias)} AND (${sql(alias)}.status = 'ready' OR ${sql(alias)}.uploader = ${viewerUploader})`
}
