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

export const MIN_UUID = "00000000-0000-0000-0000-000000000000"
export const MAX_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff"

const CURSOR_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

// Postgres to_char pattern for a timestamptz rendered in UTC at full microsecond precision. A keyset
// cursor built from the millisecond Date that postgres.js returns sits below the row it came from.
export const TIME_CURSOR_SQL_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'

const CURSOR_MIN_MS = Date.UTC(1970, 0, 1)
const CURSOR_MAX_MS = Date.UTC(2100, 0, 1)

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

/**
 * A time cursor that also keeps the instant exactly as the cursor spelled it. Keyset queries bind
 * `atText`, never `at`: postgres.js serializes a Date param with toISOString(), which drops the
 * microseconds a timestamptz carries, so a Date-bound anchor skips (DESC) or repeats (ASC) every row
 * sharing the anchor's millisecond, including every row one transaction's now() stamped.
 */
export interface KeysetCursor extends TimeCursor {
  atText: string
}

const CURSOR_INSTANT_PARTS_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|([+-])(\d{2}):(\d{2}))$/

// Postgres refuses a timestamptz input whose UTC offset is past 15:59 (22009), while JS Date takes
// anything up to 23:59.
const MAX_CURSOR_OFFSET_MINUTES = 15 * 60 + 59
const MINUTE_MS = 60_000

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0")
}

/**
 * The cursor instant respelled in UTC from the parsed Date, keeping the input's fraction digits so a
 * microsecond anchor survives. Null when the text is not a real wall-clock time: JS Date rolls
 * impossible fields forward (Feb 30 becomes Mar 2, hour 24 the next day) where Postgres raises 22008,
 * so the text fields must match the Date they produced.
 */
function canonicalCursorInstant(text: string, at: Date): string | null {
  const parts = CURSOR_INSTANT_PARTS_RE.exec(text)
  if (parts === null) return null
  const [, year, month, day, hour, minute, second, fraction, sign, offsetH, offsetM] = parts
  let offsetMinutes = 0
  if (sign !== undefined) {
    const offsetMinutePart = Number(offsetM)
    if (offsetMinutePart > 59) return null
    offsetMinutes = (Number(offsetH) * 60 + offsetMinutePart) * (sign === "-" ? -1 : 1)
    if (Math.abs(offsetMinutes) > MAX_CURSOR_OFFSET_MINUTES) return null
  }
  const wall = new Date(at.getTime() + offsetMinutes * MINUTE_MS)
  if (
    wall.getUTCFullYear() !== Number(year) ||
    wall.getUTCMonth() + 1 !== Number(month) ||
    wall.getUTCDate() !== Number(day) ||
    wall.getUTCHours() !== Number(hour) ||
    wall.getUTCMinutes() !== Number(minute) ||
    wall.getUTCSeconds() !== Number(second)
  ) {
    return null
  }
  const date = `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
  const time = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`
  return `${date}T${time}${fraction !== undefined ? `.${fraction}` : ""}Z`
}

/**
 * parseTimeCursor, plus the instant as text for keysetPredicate to bind. The text is rebuilt from the
 * validated instant, never passed through: it reaches Postgres as `::timestamptz`, and a forged value
 * Postgres refuses would surface as a 500 instead of the first page. A legacy millisecond cursor
 * rebuilds to the same text and binds the instant it always meant.
 */
export function parseKeysetCursor(
  cursor: string | null | undefined,
  opts?: { requireUuid?: boolean; direction?: "asc" | "desc" },
): KeysetCursor | null {
  const parsed = parseTimeCursor(cursor, opts)
  if (parsed === null || cursor === null || cursor === undefined) return null
  const bar = cursor.indexOf("|")
  const atText = canonicalCursorInstant(bar < 0 ? cursor : cursor.slice(0, bar), parsed.at)
  if (atText === null) return null
  return { ...parsed, atText }
}

export function encodeKeysetCursor(atText: string, id: string): string {
  return `${atText}|${id}`
}

/**
 * The column's instant rendered by Postgres at microsecond precision, in the ISO shape the cursor
 * parser accepts. Select it next to the keyset column and encode the cursor from it (paginateKeyset).
 */
export function keysetInstant(sql: Queryable, column: postgres.Fragment): postgres.Fragment {
  return sql`to_char(${column} AT TIME ZONE 'UTC', ${TIME_CURSOR_SQL_FORMAT})`
}

/**
 * `(ts, id) < anchor` (or `>` for an ascending list), with the anchor instant cast from its text so the
 * comparison is exact. The bare column stays on the left so a (ts, id) index still serves the scan.
 */
export function keysetPredicate(
  sql: Queryable,
  ts: postgres.Fragment,
  id: postgres.Fragment,
  anchor: { atText: string; id: string },
  opts: { direction?: "asc" | "desc"; idType?: "uuid" | "text" } = {},
): postgres.Fragment {
  const anchorAt = sql`${anchor.atText}::timestamptz`
  const anchorId = opts.idType === "text" ? sql`${anchor.id}::text` : sql`${anchor.id}::uuid`
  return opts.direction === "asc"
    ? sql`(${ts}, ${id}) > (${anchorAt}, ${anchorId})`
    : sql`(${ts}, ${id}) < (${anchorAt}, ${anchorId})`
}

// `activity` must already be truncated to milliseconds, the precision of the Date cursor; the two clauses
// together are `(activity, id) < cursor`.
export function msKeysetFilter(
  sql: Queryable,
  activity: postgres.Fragment,
  id: postgres.Fragment,
  cursor: TimeCursor | null | undefined,
): postgres.Fragment {
  if (cursor === null || cursor === undefined) return sql``
  const msCeiling = new Date(cursor.at.getTime() + 1)
  return sql`
    AND ${activity} < ${msCeiling}
    AND (${activity} < ${cursor.at} OR ${id} < ${cursor.id}::uuid)
  `
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

/**
 * paginate() for rows that carry the keysetInstant text. A row whose instant is null yields no cursor,
 * matching paginate() for a missing Date.
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

export function isBeforeTimeCursor(atMs: number, id: string, anchor: TimeCursor | null): boolean {
  if (anchor === null) return true
  const anchorMs = anchor.at.getTime()
  return atMs < anchorMs || (atMs === anchorMs && id < anchor.id)
}

/**
 * Pages rows pre-sorted (at DESC, id DESC). An anchor row that has since left the list does not end
 * paging, unlike pageInMemoryById: the page continues from the anchor's instant.
 */
export function pageBeforeTimeCursor<T>(
  rows: readonly T[],
  anchor: TimeCursor | null,
  limit: number,
  keyOf: (row: T) => TimeCursor,
): { items: T[]; nextCursor: string | null } {
  return pageWith(
    rows.filter((row) => {
      const key = keyOf(row)
      return isBeforeTimeCursor(key.at.getTime(), key.id, anchor)
    }),
    limit,
    (last) => encodeTimeCursor(keyOf(last)),
  )
}
