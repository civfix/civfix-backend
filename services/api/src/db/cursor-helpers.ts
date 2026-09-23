import type postgres from "postgres"
import type { Queryable } from "./client.js"

export const CURSOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(v: string): boolean {
  return CURSOR_UUID_RE.test(v)
}

export interface TimeCursor {
  at: Date
  id: string
}

export interface DecodedTimeCursor extends TimeCursor {
  instant: string
}

export const MIN_UUID = "00000000-0000-0000-0000-000000000000"
export const MAX_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff"

export const CURSOR_ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

export const CURSOR_MIN_MS = Date.UTC(1970, 0, 1)
export const CURSOR_MAX_MS = Date.UTC(2100, 0, 1)

const CURSOR_FRACTION_RE = /\.(\d{1,6})/

function parseCursorInstant(iso: string): { at: Date; instant: string } | null {
  if (!CURSOR_ISO_RE.test(iso)) return null
  const at = new Date(iso)
  const ms = at.getTime()
  if (!Number.isFinite(ms) || ms < CURSOR_MIN_MS || ms > CURSOR_MAX_MS) return null
  const micros = (CURSOR_FRACTION_RE.exec(iso)?.[1] ?? "").padEnd(6, "0").slice(3)
  return { at, instant: at.toISOString().replace(/Z$/, `${micros}Z`) }
}

export function parseTimeCursor(
  cursor: string | null | undefined,
  opts?: { requireUuid?: boolean; direction?: "asc" | "desc" },
): DecodedTimeCursor | null {
  if (cursor === null || cursor === undefined || cursor === "") return null
  const requireUuid = opts?.requireUuid ?? true
  const idx = cursor.indexOf("|")
  if (idx === 0) return null
  if (idx < 0) {
    const parsed = parseCursorInstant(cursor)
    if (parsed === null) return null
    return { ...parsed, id: opts?.direction === "asc" ? MIN_UUID : MAX_UUID }
  }
  const id = cursor.slice(idx + 1)
  const parsed = parseCursorInstant(cursor.slice(0, idx))
  if (parsed === null) return null
  if (requireUuid && !CURSOR_UUID_RE.test(id)) return null
  if (id.length === 0) return null
  return { ...parsed, id }
}

export function encodeTimeCursor(c: { at: Date | string; id: string }): string {
  return `${typeof c.at === "string" ? c.at : c.at.toISOString()}|${c.id}`
}

export function cursorInstantSql(sql: Queryable, column: postgres.Fragment): postgres.Fragment {
  return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
}

export function cursorAtSql(sql: Queryable, cursor: { instant: string }): postgres.Fragment {
  return sql`${cursor.instant}::text::timestamptz`
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
