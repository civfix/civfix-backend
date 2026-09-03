/**
 * The SQL half of C1: which media_assets key a read path may hand to a client.
 *
 * `r2_key` is the UPLOAD key — the one the client holds a presigned PUT for, valid for its full TTL even
 * after the worker has vetted the bytes. `served_key` is the worker-owned key the PROCESSED bytes were
 * published to, which nothing outside the media.checks job can write. So:
 *
 *   status = 'ready'   -> serve served_key, and NOTHING when it is NULL (a pre-migration row whose
 *                         served-key backfill has not run yet; treated exactly like a not-ready asset).
 *   status <> 'ready'  -> serve r2_key. These are pre-publication owner previews of the caller's own
 *                         in-flight upload, which is by definition the caller's own bytes.
 *
 * ONE definition for every read path (report media, map/search pins, post attachments, chat/DM
 * attachments, avatars, admin + moderation surfaces): a site that hand-rolls `m.r2_key` again
 * re-opens the overwrite.
 */

import type postgres from "postgres"
import type { Queryable } from "../db/client.js"

type SqlFragment = postgres.Fragment

/** Table aliases the media read paths use. A closed union: never an identifier from input. */
export type MediaAlias = "m" | "am" | "ma" | "a" | "media_assets"

/** The key a client may be given for this row, or NULL when the row has nothing servable. */
export function servedKeyExpr(sql: Queryable, alias: MediaAlias): SqlFragment {
  return sql`COALESCE(${sql(alias)}.served_key, CASE WHEN ${sql(alias)}.status <> 'ready' THEN ${sql(alias)}.r2_key END)`
}

/** True when this row has bytes a client may be pointed at (the filter twin of servedKeyExpr). */
export function servableMediaFilter(sql: Queryable, alias: MediaAlias): SqlFragment {
  return sql`(${sql(alias)}.status <> 'ready' OR ${sql(alias)}.served_key IS NOT NULL)`
}
