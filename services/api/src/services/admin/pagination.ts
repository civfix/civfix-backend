/**
 * Admin (Phase 2) list-endpoint pagination helpers — thin aliases over the shared cursor primitives in
 * db/cursor-helpers.ts. The admin layer keeps its own limit defaults + a {createdAt,id}-shaped anchor
 * (the admin repos read/write that shape); the cursor encode/decode itself is the one shared core.
 *
 * The shared @civfix/shared exports (PaginationQuerySchema, CursorSchema, pageResponse) remain the WIRE
 * contract; these are the server-side encode/decode + limit clamp around them.
 */

import {
  CURSOR_UUID_RE,
  encodeTimeCursor,
  parseTimeCursor,
} from "../../db/cursor-helpers.js"

export { CURSOR_UUID_RE, paginate } from "../../db/cursor-helpers.js"

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
  return encodeTimeCursor({ at: anchor.createdAt, id: anchor.id })
}

/**
 * Decode a "<iso>|<id>" cursor into its anchor, or null when absent/malformed. Repos that cast
 * `${id}::uuid` pass requireUuidId=true so a non-UUID id degrades to "from the start" (null) rather than
 * raising a Postgres 22P02 -> 500. Non-uuid-keyed repos (geoid: discovery, jurisdiction-contacts) and the
 * in-memory test fakes leave it false. A legacy timestamp-only cursor anchors at the max uuid for that
 * instant (created_at-only paging) instead of erroring.
 */
export function decodeCursor(
  cursor: string | null | undefined,
  requireUuidId = false,
): CursorAnchor | null {
  const parsed = parseTimeCursor(cursor, { requireUuid: requireUuidId })
  if (parsed === null) return null
  return { createdAt: parsed.at, id: parsed.id }
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
