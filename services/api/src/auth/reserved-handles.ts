/**
 * Two layers gate which @handles a user may take, on both the write path (PUT /me/profile) and the
 * availability check (GET /me/handle-available), and both report `reserved` (distinct from `taken` and
 * `invalid`):
 *   1) RESERVED_HANDLES, system and role names a citizen must not impersonate;
 *   2) every existing jurisdictions.handle, checked live, because jurisdiction handles are @mentionable in
 *      report discussions.
 */

import type { Sql } from "../db/client.js"
import { TOMBSTONE_HANDLE_RE } from "./stores.js"

const RESERVED_HANDLES: readonly string[] = [
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

const RESERVED_SET = new Set(RESERVED_HANDLES.map((h) => h.toLowerCase()))

export function isReservedHandle(handle: string): boolean {
  const h = handle.trim().toLowerCase()
  return RESERVED_SET.has(h) || TOMBSTONE_HANDLE_RE.test(h)
}

/**
 * The lower() comparison matches the partial-unique index jurisdictions_handle_lower_key
 * (0017_report_discussion.sql).
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
