
export const CURSOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(v: string): boolean {
  return CURSOR_UUID_RE.test(v)
}

export interface TimeCursor {
  at: Date
  id: string
}

export const MIN_UUID = "00000000-0000-0000-0000-000000000000"
export const MAX_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff"

// Every cursor this module hands out is `Date.toISOString()`, so the reader accepts exactly that shape.
// `new Date(...)` on its own parses far more (`-271821-04-20T00:00:00Z`, `"Wed"`, bare years), and a
// forged cursor then reaches Postgres as an out-of-range timestamptz and 500s instead of 400-ing here.
export const CURSOR_ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

// Postgres timestamptz spans far wider, but no civfix cursor can honestly sit outside this window.
export const CURSOR_MIN_MS = Date.UTC(1970, 0, 1)
export const CURSOR_MAX_MS = Date.UTC(2100, 0, 1)

function parseCursorInstant(iso: string): Date | null {
  if (!CURSOR_ISO_RE.test(iso)) return null
  const at = new Date(iso)
  const ms = at.getTime()
  if (!Number.isFinite(ms) || ms < CURSOR_MIN_MS || ms > CURSOR_MAX_MS) return null
  return at
}

export function parseTimeCursor(
  cursor: string | null | undefined,
  opts?: { requireUuid?: boolean; direction?: "asc" | "desc" },
): TimeCursor | null {
  if (cursor === null || cursor === undefined || cursor === "") return null
  const requireUuid = opts?.requireUuid ?? true
  const idx = cursor.indexOf("|")
  if (idx === 0) return null
  if (idx < 0) {
    const at = parseCursorInstant(cursor)
    if (at === null) return null
    return { at, id: opts?.direction === "asc" ? MIN_UUID : MAX_UUID }
  }
  const id = cursor.slice(idx + 1)
  const at = parseCursorInstant(cursor.slice(0, idx))
  if (at === null) return null
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
