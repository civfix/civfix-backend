/**
 * Admin (Phase 2) list-endpoint pagination helpers — thin aliases over the shared cursor primitives in
 * db/cursor-helpers.ts. The admin layer keeps its own limit defaults + a {createdAt,id}-shaped anchor
 * (the admin repos read/write that shape); the cursor encode/decode itself is the one shared core.
 *
 * The shared @civfix/shared exports (PaginationQuerySchema, CursorSchema, pageResponse) remain the WIRE
 * contract; these are the server-side encode/decode + limit clamp around them.
 */

import type { Queryable } from "../../db/client.js"
import { encodeTimeCursor, pageWith, parseTimeCursor } from "../../db/cursor-helpers.js"
import type { SqlFragment } from "./sql-fragments.js"

export { paginate } from "../../db/cursor-helpers.js"

/** Default page size when the request omits `limit`. */
export const ADMIN_DEFAULT_LIMIT = 25
/** Hard cap on page size (mirrors the shared AdminListQuery limit ceiling). */
export const ADMIN_MAX_LIMIT = 100

/** A decoded keyset cursor anchor: page rows ordered by (createdAt DESC, id DESC) strictly before this. */
export interface CursorAnchor {
  createdAt: Date
  id: string
}

/**
 * A decoded anchor that also keeps the cursor's instant as TEXT. The Drizzle keysets bind `atText`, never
 * `createdAt`: postgres-js serializes a Date param with toISOString(), which drops the microseconds a
 * timestamptz column carries, so a Date-bound anchor skips (DESC) or repeats (ASC) every row sharing the
 * anchor's millisecond, including all rows written by one transaction's now().
 */
export interface KeysetAnchor extends CursorAnchor {
  atText: string
}

/** Encode a keyset anchor into the opaque "<iso>|<id>" cursor string. */
export function encodeCursor(anchor: CursorAnchor): string {
  return encodeTimeCursor({ at: anchor.createdAt, id: anchor.id })
}

/**
 * Decode a "<iso>|<id>" cursor into its anchor, or null when absent/malformed. Repos whose keyset casts
 * `${id}::uuid` pass requireUuidId=true so a forged non-UUID id degrades to "from the start" (null) rather
 * than raising a Postgres 22P02 -> 500: reports, users, events, discovery, moderation, mail, inbound,
 * gov-claims and audit all do. Repos keyed on something else (activity's synthetic composite ids) leave it
 * false. A legacy timestamp-only cursor anchors at the max uuid for that instant (created_at-only paging)
 * instead of erroring.
 */
export function decodeCursor(
  cursor: string | null | undefined,
  requireUuidId = false,
): KeysetAnchor | null {
  const parsed = parseTimeCursor(cursor, { requireUuid: requireUuidId })
  if (parsed === null || cursor === null || cursor === undefined) return null
  const bar = cursor.indexOf("|")
  const atText = bar < 0 ? cursor : cursor.slice(0, bar)
  return { createdAt: parsed.at, id: parsed.id, atText }
}

/** Encode a keyset cursor from the full-precision instant text a query selected via keysetInstant. */
export function encodeKeysetCursor(atText: string, id: string): string {
  return `${atText}|${id}`
}

/**
 * The column's instant rendered by Postgres at microsecond precision, in the same ISO shape the cursor
 * parser accepts. Select it next to the keyset column and encode the cursor from it (paginateKeyset).
 */
export function keysetInstant(sql: Queryable, column: SqlFragment): SqlFragment {
  return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
}

/**
 * `(ts, id) < anchor` (or `>` for an ascending list), with the anchor instant cast from its full-precision
 * text so the comparison is exact. The bare column stays on the left so its (created_at, id) index still
 * serves the scan. A legacy millisecond cursor still parses and pages exactly as it did before.
 */
export function keysetPredicate(
  sql: Queryable,
  ts: SqlFragment,
  id: SqlFragment,
  anchor: KeysetAnchor,
  opts: { direction?: "asc" | "desc"; idType?: "uuid" | "text" } = {},
): SqlFragment {
  const anchorAt = sql`${anchor.atText}::timestamptz`
  const anchorId = opts.idType === "text" ? sql`${anchor.id}::text` : sql`${anchor.id}::uuid`
  return opts.direction === "asc"
    ? sql`(${ts}, ${id}) > (${anchorAt}, ${anchorId})`
    : sql`(${ts}, ${id}) < (${anchorAt}, ${anchorId})`
}

/**
 * paginate() for rows that carry the keysetInstant text. A row whose instant is null yields no cursor,
 * matching paginate() for a null Date.
 */
export function paginateKeyset<T>(
  rows: readonly T[],
  limit: number,
  pick: (row: T) => { atText: string | null; id: string },
): { items: T[]; nextCursor: string | null } {
  return pageWith(rows, limit, (last) => {
    const anchor = pick(last)
    return anchor.atText !== null ? encodeKeysetCursor(anchor.atText, anchor.id) : null
  })
}

/**
 * Encode an offset-pagination cursor (opaque base64url of the NEXT row offset). Offset paging is used by
 * the jurisdictions directory specifically: the table is static reference data browsed/searched under an
 * arbitrary sort (population / reports / name), where keyset's drift-immunity buys nothing and a free
 * choice of ORDER BY is worth more. The cursor stays an opaque string so the wire `nextCursor` contract
 * (and the typed client's infinite-scroll loop) is unchanged.
 */
export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: Math.max(0, Math.floor(offset)) }), "utf8").toString(
    "base64url",
  )
}

/**
 * Hard ceiling on a decoded offset (L22). The cursor is opaque but NOT authenticated, so a caller can
 * mint one carrying any integer; an unbounded OFFSET makes Postgres walk and discard that many rows per
 * request. Mirrors clampOffset in services/volunteer-hours-service.ts. The directory it serves is static
 * reference data in the low thousands, so a legitimate deep page is never near this.
 */
export const ADMIN_MAX_OFFSET = 100_000

/**
 * Decode an offset cursor to its row offset; absent/malformed -> 0 (start from the top). Clamped at BOTH
 * ends: [0, ADMIN_MAX_OFFSET].
 */
export function decodeOffsetCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown }
    const o = typeof parsed.o === "number" && Number.isFinite(parsed.o) ? Math.floor(parsed.o) : 0
    return Math.min(Math.max(0, o), ADMIN_MAX_OFFSET)
  } catch {
    return 0
  }
}

/**
 * Page a PRE-SORTED in-memory list by the shared "<iso>|<id>" cursor: find the anchor row by id, then take
 * a one-extra-row probe. `anchorOf` returns the {createdAt,id} the cursor encodes — encoding the row's REAL
 * sort value (not a placeholder) so the opaque cursor has the same shape as the Drizzle impl for the same page.
 * The id alone drives the slice position; the cursor's createdAt is informational here.
 *
 * THE one implementation for every in-memory admin repo (six hand-rolled copies of
 * decode -> findIndex -> slice(limit+1) -> encode drifted apart before this existed).
 *
 * `requireUuid` mirrors the Drizzle twin's decodeCursor flag: a fake whose production counterpart casts the
 * anchor to uuid must DISCARD a non-uuid anchor the same way, or the offline twin silently accepts cursors
 * prod throws away. Fakes whose tests seed synthetic row ids ("rep-1") leave it false — for those the
 * strictness is a prod hardening against a forged cursor, not an observable behavior the fake must copy.
 *
 * ANCHOR MISS: when the anchor row is no longer in the list (it left the filtered set between pages — a
 * discovery task whose contacts were just saved, a report that was removed), paging ENDS rather than
 * restarting from the top, which would loop the client forever.
 */
export function pageInMemoryById<T>(
  rows: readonly T[],
  cursor: string | null | undefined,
  limit: number | undefined,
  anchorOf: (row: T) => CursorAnchor,
  requireUuid = false,
): { records: T[]; nextCursor: string | null } {
  const lim = clampLimit(limit)
  const anchor = decodeCursor(cursor, requireUuid)
  let start = 0
  if (anchor !== null) {
    const idx = rows.findIndex((row) => anchorOf(row).id === anchor.id)
    start = idx >= 0 ? idx + 1 : rows.length
  }
  const slice = rows.slice(start, start + lim + 1)
  if (slice.length <= lim) return { records: slice, nextCursor: null }
  const records = slice.slice(0, lim)
  const last = records[records.length - 1]
  return { records, nextCursor: last !== undefined ? encodeCursor(anchorOf(last)) : null }
}

/**
 * Clamp a requested page limit into [1, ADMIN_MAX_LIMIT], defaulting to ADMIN_DEFAULT_LIMIT when
 * undefined/invalid. The wire schema already coerces + caps; this is the defensive server-side clamp so a
 * repo never receives a 0 / negative / huge LIMIT.
 */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return ADMIN_DEFAULT_LIMIT
  const n = Math.floor(limit)
  if (n < 1) return 1
  if (n > ADMIN_MAX_LIMIT) return ADMIN_MAX_LIMIT
  return n
}
