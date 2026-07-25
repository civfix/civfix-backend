// Single home for keyset/cursor primitives shared across the persistence layer. Cursors are a DB
// concern, not an admin one, so they live here; admin/pagination.ts re-exports the relevant bits.
//
// The keyset format is "<anchor>|<id>" where the id participates in a row-value comparison and is cast
// `${id}::uuid` downstream by callers. A non-UUID id would raise a Postgres 22P02 -> unhandled 500, so a
// malformed cursor degrades to "from the start" (null) rather than throwing — every parser below treats
// absent/malformed input as null.

export const CURSOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(v: string): boolean {
  return CURSOR_UUID_RE.test(v)
}

export interface TimeCursor {
  at: Date
  id: string
}

// Parses an "<iso>|<id>" time cursor. With requireUuid (the default) a non-UUID id degrades to null.
// A legacy timestamp-only cursor (no "|id", from an older client) anchors at the max uuid for that
// instant so the row-value comparison degrades to created_at-only paging rather than 500ing.
export function parseTimeCursor(
  cursor: string | null | undefined,
  opts?: { requireUuid?: boolean },
): TimeCursor | null {
  if (cursor === null || cursor === undefined || cursor === "") return null
  const requireUuid = opts?.requireUuid ?? true
  // `|` cannot appear in an ISO timestamp or a UUID, so the first delimiter is the separator.
  const idx = cursor.indexOf("|")
  if (idx < 0) {
    const at = new Date(cursor)
    if (Number.isNaN(at.getTime())) return null
    return { at, id: "ffffffff-ffff-ffff-ffff-ffffffffffff" }
  }
  if (idx === 0) return null
  const iso = cursor.slice(0, idx)
  const id = cursor.slice(idx + 1)
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  if (requireUuid && !CURSOR_UUID_RE.test(id)) return null
  if (id.length === 0) return null
  return { at, id }
}

export function encodeTimeCursor(c: TimeCursor): string {
  return `${c.at.toISOString()}|${c.id}`
}

export interface NameCursor {
  name: string
  id: string
}

// Splits on the LAST "|" because a name may itself contain "|" — the id (a UUID) is the suffix. This
// delimiter position differs from parseTimeCursor (first "|") on purpose; do not collapse them.
export function parseNameCursor(cursor: string | null | undefined): NameCursor | null {
  if (cursor === null || cursor === undefined || cursor === "") return null
  const idx = cursor.lastIndexOf("|")
  if (idx < 0) return null
  const name = cursor.slice(0, idx)
  const id = cursor.slice(idx + 1)
  if (!CURSOR_UUID_RE.test(id)) return null
  return { name, id }
}

export function encodeNameCursor(c: NameCursor): string {
  return `${c.name}|${c.id}`
}

export interface NearCursor {
  dist: number
  id: string
}

export function parseNearCursor(cursor: string | null | undefined): NearCursor | null {
  if (cursor === null || cursor === undefined || cursor === "") return null
  const idx = cursor.indexOf("|")
  if (idx <= 0) return null
  const dist = Number(cursor.slice(0, idx))
  const id = cursor.slice(idx + 1)
  if (!Number.isFinite(dist) || !CURSOR_UUID_RE.test(id)) return null
  return { dist, id }
}

export function encodeNearCursor(c: NearCursor): string {
  return `${c.dist}|${c.id}`
}

/**
 * THE keyset page split: given rows fetched with `limit + 1`, drop the has-more probe row and derive
 * { items, nextCursor }. `encode` builds the cursor from the LAST EMITTED row and may return null when
 * that row cannot anchor a keyset (so the page simply ends).
 *
 * M-pagination: every repository that pages a keyset must go through this (or `paginate` below) rather
 * than re-deriving hasMore/slice/last — six repos each hand-rolled it with subtly different encoders,
 * which is how a page could advertise a cursor its own WHERE clause could not consume. The encoder is a
 * parameter precisely because the anchor differs per surface (time / display name / distance / offset).
 */
export function pageWith<T>(
  rows: readonly T[],
  limit: number,
  encode: (last: T) => string | null,
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) {
    return { items: [...rows], nextCursor: null }
  }
  const items = rows.slice(0, limit)
  const last = items[items.length - 1]
  if (last === undefined) return { items, nextCursor: null }
  return { items, nextCursor: encode(last) }
}

// The time-cursor specialization of `pageWith`. `pick` extracts the keyset anchor (an `at` or `createdAt`
// Date + id) from the last emitted row.
export function paginate<T>(
  rows: readonly T[],
  limit: number,
  pick: (row: T) => { at?: Date; createdAt?: Date; id: string },
): { items: T[]; nextCursor: string | null } {
  return pageWith(rows, limit, (last) => {
    const anchor = pick(last)
    const at = anchor.at ?? anchor.createdAt
    return at !== undefined ? encodeTimeCursor({ at, id: anchor.id }) : null
  })
}
