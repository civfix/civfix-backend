import { encodeTimeCursor, parseKeysetCursor, type TimeCursor } from "../../db/cursor-helpers.js"
import { clampPageLimit } from "../../lib/page-limit.js"

export const ADMIN_DEFAULT_LIMIT = 25
/** Mirrors the shared AdminListQuery limit ceiling. */
const ADMIN_MAX_LIMIT = 100

/**
 * Pages a pre-sorted list. `anchorOf` must return the row's real sort value (not a placeholder) so the
 * cursor has the same shape as the Drizzle impl's for the same page; the id alone drives the slice
 * position.
 *
 * `requireUuid` mirrors the Drizzle twin's parseKeysetCursor requireUuid: a fake whose production
 * counterpart casts the anchor to uuid must discard a non-uuid anchor the same way, or it silently
 * accepts cursors prod throws away. Fakes whose tests seed synthetic ids ("rep-1") leave it false.
 *
 * When the anchor row left the filtered set between pages (a discovery task whose contacts were just
 * saved, a removed report), paging ends rather than restarting from the top, which would loop the client
 * forever.
 */
export function pageInMemoryById<T>(
  rows: readonly T[],
  cursor: string | null | undefined,
  limit: number | undefined,
  anchorOf: (row: T) => TimeCursor,
  requireUuid = false,
): { records: T[]; nextCursor: string | null } {
  const lim = clampLimit(limit)
  const anchor = parseKeysetCursor(cursor, { requireUuid })
  let start = 0
  if (anchor !== null) {
    const idx = rows.findIndex((row) => anchorOf(row).id === anchor.id)
    start = idx >= 0 ? idx + 1 : rows.length
  }
  const slice = rows.slice(start, start + lim + 1)
  if (slice.length <= lim) return { records: slice, nextCursor: null }
  const records = slice.slice(0, lim)
  const last = records[records.length - 1]
  return { records, nextCursor: last !== undefined ? encodeTimeCursor(anchorOf(last)) : null }
}

export function clampLimit(limit: number | undefined): number {
  return clampPageLimit(limit, ADMIN_DEFAULT_LIMIT, ADMIN_MAX_LIMIT)
}
