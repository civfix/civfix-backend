/**
 * The joined-person projection shared by the admin reports and events surfaces (a report's reporter, an
 * event's organizer).
 *
 * Each surface keeps its own missing-person fallback because the domains differ: a report may be
 * anonymous (`id: null`, "Anonymous"), while a cleanup always has an organizer and a null there is data
 * corruption (`id: ""`, "Unknown"). Those strings are on the wire, so they stay caller-supplied.
 */

import { toRelAbs } from "./admin-format.js"

// Null at the call site means "no joined user" (an anonymous report), never "a user with empty fields".
export interface AdminPersonRecord {
  id: string
  name: string
  handle: string | null
  emailVerified: boolean
  hasOauth: boolean
  joinedAt: Date | null
}

/**
 * All nullable because the join is a LEFT JOIN. `id === null` is the authoritative "no person" test, since
 * a real `users.id` is never null.
 */
export interface AdminPersonColumns {
  id: string | null
  name: string | null
  handle: string | null
  emailVerified: boolean | null
  hasOauth: boolean | null
  joinedAt: Date | null
}

// `fallbackName` covers a user row whose `display_name` is null: the account exists, so this is not the
// anonymous case.
export function toPersonRecord(
  cols: AdminPersonColumns,
  fallbackName: string,
): AdminPersonRecord | null {
  if (cols.id === null) return null
  return {
    id: cols.id,
    name: cols.name ?? fallbackName,
    handle: cols.handle,
    emailVerified: cols.emailVerified ?? false,
    hasOauth: cols.hasOauth ?? false,
    joinedAt: cols.joinedAt,
  }
}

/**
 * `joined` is the absolute half of the timestamp pair: the design shows a join date, not "3 months ago".
 * Generic on the missing `id` alone so both contract shapes are met without a cast: the report DTO's
 * `reporter.id` is nullable, the event DTO's `organizer.id` is a plain string.
 */
export function toPersonDTO<TMissingId extends string | null>(
  record: AdminPersonRecord | null,
  ref: Date,
  missing: { id: TMissingId; name: string; handle: string },
): { id: string | TMissingId; name: string; handle: string; joined: string } {
  return {
    id: record?.id ?? missing.id,
    name: record?.name ?? missing.name,
    handle: record?.handle ?? missing.handle,
    joined: record?.joinedAt ? toRelAbs(record.joinedAt, ref).abs : "-",
  }
}
