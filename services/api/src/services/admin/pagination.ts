import { encodeTimeCursor, parseKeysetCursor } from "../../db/cursor-helpers.js"

export {
  encodeKeysetCursor,
  keysetInstant,
  keysetPredicate,
  paginate,
  paginateKeyset,
} from "../../db/cursor-helpers.js"

export const ADMIN_DEFAULT_LIMIT = 25
/** Mirrors the shared AdminListQuery limit ceiling. */
const ADMIN_MAX_LIMIT = 100

export interface CursorAnchor {
  createdAt: Date
  id: string
}

/** Keeps the cursor's instant as text because that is what keysetPredicate binds. */
export interface KeysetAnchor extends CursorAnchor {
  atText: string
}

export function encodeCursor(anchor: CursorAnchor): string {
  return encodeTimeCursor({ at: anchor.createdAt, id: anchor.id })
}

/**
 * Repos whose keyset casts `${id}::uuid` pass requireUuidId=true so a forged non-UUID id degrades to "from
 * the start" rather than raising a Postgres 22P02 (a 500). Repos keyed on something else (activity's
 * synthetic composite ids) leave it false. A legacy timestamp-only cursor anchors at the max uuid for that
 * instant instead of erroring.
 */
export function decodeCursor(
  cursor: string | null | undefined,
  requireUuidId = false,
): KeysetAnchor | null {
  const parsed = parseKeysetCursor(cursor, { requireUuid: requireUuidId })
  if (parsed === null) return null
  return { createdAt: parsed.at, id: parsed.id, atText: parsed.atText }
}

/**
 * Offset paging serves the jurisdictions directory: static reference data browsed under an arbitrary sort
 * (population / reports / name), where keyset's drift-immunity buys nothing and a free choice of ORDER BY
 * is worth more. The cursor stays opaque so the wire `nextCursor` contract is unchanged.
 */
export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: Math.max(0, Math.floor(offset)) }), "utf8").toString(
    "base64url",
  )
}

/**
 * The cursor is opaque but not authenticated, so a caller can mint one carrying any integer, and an
 * unbounded OFFSET makes Postgres walk and discard that many rows per request. Mirrors clampOffset in
 * services/volunteer-hours-service.ts. The directory is in the low thousands of rows, so a legitimate
 * deep page is never near this.
 */
export const ADMIN_MAX_OFFSET = 100_000

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
 * Pages a pre-sorted list. `anchorOf` must return the row's real sort value (not a placeholder) so the
 * cursor has the same shape as the Drizzle impl's for the same page; the id alone drives the slice
 * position.
 *
 * `requireUuid` mirrors the Drizzle twin's decodeCursor flag: a fake whose production counterpart casts
 * the anchor to uuid must discard a non-uuid anchor the same way, or it silently accepts cursors prod
 * throws away. Fakes whose tests seed synthetic ids ("rep-1") leave it false.
 *
 * When the anchor row left the filtered set between pages (a discovery task whose contacts were just
 * saved, a removed report), paging ends rather than restarting from the top, which would loop the client
 * forever.
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

// The wire schema already coerces and caps; this clamp keeps a repo from ever receiving a 0, negative or
// huge LIMIT.
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return ADMIN_DEFAULT_LIMIT
  const n = Math.floor(limit)
  if (n < 1) return 1
  if (n > ADMIN_MAX_LIMIT) return ADMIN_MAX_LIMIT
  return n
}
