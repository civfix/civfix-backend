/**
 * Shared cursor/pagination helpers for the admin (Phase 2) list endpoints.
 *
 * Phase 1 keyset cursors are encoded inline per-repository as "<iso>|<id>" (see
 * report-repository.drizzle.ts parseMyReportsCursor). There is no centralized helper, so this module
 * provides ONE for the many admin list routers wave 2 will write, keeping the cursor format consistent
 * across domains. The shared @civfix/shared exports (PaginationQuerySchema, CursorSchema, pageResponse)
 * remain the WIRE contract; these helpers are the server-side encode/decode + limit clamp around them.
 *
 * Cursor format: "<createdAtIso>|<id>" - the same created_at DESC, id-tiebreak keyset Phase 1 uses, so
 * a row-value comparison `(created_at, id) < (anchorCreatedAt, anchorId)` pages newest-first stably. A
 * malformed cursor decodes to null (treated as "from the start") rather than throwing, matching Phase 1.
 */

/** Default page size when the request omits `limit`. */
export const ADMIN_DEFAULT_LIMIT = 25
/** Hard cap on page size (mirrors the shared AdminListQuery limit ceiling). */
export const ADMIN_MAX_LIMIT = 100

/** A decoded keyset cursor anchor: page rows ordered by (createdAt DESC, id DESC) strictly before this. */
export interface CursorAnchor {
  createdAt: Date
  id: string
}

/** Encode a keyset anchor into the opaque "<iso>|<id>" cursor string. */
export function encodeCursor(anchor: CursorAnchor): string {
  return `${anchor.createdAt.toISOString()}|${anchor.id}`
}

/**
 * Decode a "<iso>|<id>" cursor into its anchor, or null when absent/malformed. A legacy timestamp-only
 * cursor (no "|id") is tolerated by anchoring at the maximum uuid for that instant, mirroring the Phase
 * 1 fallback so an older client cursor degrades to created_at-only paging rather than erroring.
 */
export function decodeCursor(cursor: string | null | undefined): CursorAnchor | null {
  if (cursor === null || cursor === undefined || cursor === "") return null
  const idx = cursor.indexOf("|")
  if (idx < 0) {
    const at = new Date(cursor)
    if (Number.isNaN(at.getTime())) return null
    return { createdAt: at, id: "ffffffff-ffff-ffff-ffff-ffffffffffff" }
  }
  const iso = cursor.slice(0, idx)
  const id = cursor.slice(idx + 1)
  const at = new Date(iso)
  if (Number.isNaN(at.getTime()) || id.length === 0) return null
  return { createdAt: at, id }
}

/**
 * Clamp a requested page limit into [1, ADMIN_MAX_LIMIT], defaulting to ADMIN_DEFAULT_LIMIT when
 * undefined/invalid. The shared AdminListQuerySchema already coerces + caps on the wire; this is the
 * defensive server-side clamp so a repo never receives a 0 / negative / huge LIMIT.
 */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return ADMIN_DEFAULT_LIMIT
  const n = Math.floor(limit)
  if (n < 1) return 1
  if (n > ADMIN_MAX_LIMIT) return ADMIN_MAX_LIMIT
  return n
}

/**
 * Given the rows fetched with `limit + 1`, split off the extra row used as the has-more probe and
 * derive { items, nextCursor }. `pick` extracts the keyset anchor from a row. When fewer than `limit`
 * rows came back there is no next page (nextCursor = null). Keeps every admin list endpoint's
 * "fetch one extra to know if there is a next page" logic identical.
 */
export function paginate<T>(
  rows: readonly T[],
  limit: number,
  pick: (row: T) => CursorAnchor,
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) {
    return { items: [...rows], nextCursor: null }
  }
  const items = rows.slice(0, limit)
  const last = items[items.length - 1]
  // items is non-empty here (rows.length > limit >= 1), so `last` is defined.
  const nextCursor = last !== undefined ? encodeCursor(pick(last)) : null
  return { items, nextCursor }
}
