/**
 * Reserved @handle blocklist + the runtime jurisdiction-handle check.
 *
 * Two layers gate which @handles a user may take, on BOTH the write path (PUT /me/profile) and the
 * availability check (GET /me/handle-available):
 *   1) RESERVED_HANDLES - a static blocklist of system/role-impersonating names (admin, support, mod,
 *      official, ...). Matched case-insensitively (handles are citext); the comparison lowercases.
 *   2) every existing jurisdictions.handle - a citizen must not be able to register a @handle that
 *      collides with a city/jurisdiction handle (those are @mentionable in report discussions). This is
 *      checked at runtime against the live table via `handleCollidesWithJurisdiction`.
 *
 * Both layers report the same outcome: the handle is `reserved` (distinct from `taken` / `invalid`).
 */

import type { Sql } from "../db/client.js"

/**
 * Static reserved-handle blocklist (lowercase, base forms). System / role / route names a citizen must
 * not be able to impersonate. Matched case-insensitively against the (lowercased) submitted handle.
 */
export const RESERVED_HANDLES: readonly string[] = [
  "admin",
  "administrator",
  "civfix",
  "support",
  "help",
  "about",
  "settings",
  "me",
  "login",
  "logout",
  "register",
  "api",
  "city",
  "official",
  "mod",
  "moderator",
  "team",
  "staff",
  // The reviewer-OTP bypass account owns @reviewer; reserve it so no real user can take the handle
  // (and the bypass account's create() can never collide on the handle unique index).
  "reviewer",
  "root",
  "system",
  "null",
  "undefined",
]

/** Lowercased set for O(1) membership tests. */
const RESERVED_SET = new Set(RESERVED_HANDLES.map((h) => h.toLowerCase()))

/** True when `handle` is on the static reserved blocklist (case-insensitive). */
export function isReservedHandle(handle: string): boolean {
  return RESERVED_SET.has(handle.trim().toLowerCase())
}

/**
 * True when `handle` collides (case-insensitively) with an existing jurisdictions.handle. `handle` is
 * citext; the lower() comparison matches the partial-unique index jurisdictions_handle_lower_key
 * (0017_report_discussion.sql). A NULL-handle jurisdiction never matches.
 */
export async function handleCollidesWithJurisdiction(sql: Sql, handle: string): Promise<boolean> {
  const rows = await sql<{ one: number }[]>`
    SELECT 1 AS one
    FROM jurisdictions
    WHERE handle IS NOT NULL AND lower(handle) = lower(${handle})
    LIMIT 1
  `
  return rows.length > 0
}
