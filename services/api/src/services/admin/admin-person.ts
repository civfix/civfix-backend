/**
 * The joined-PERSON projection shared by the admin reports and events surfaces: a report's reporter and an
 * event's organizer are the same thing (a `users` row reached through a LEFT JOIN) rendered into the same
 * four-field DTO, and they were built by two independent copies of the same three steps.
 *
 * The copy that actually mattered is the SQL one: six column expressions including a correlated
 * `EXISTS (SELECT 1 FROM oauth_identities …)` probe, duplicated verbatim apart from the alias prefix. A
 * divergence there is invisible per file — one surface would just quietly report `hasOauth: false` for
 * every account, which is the account-provenance signal an operator reads before acting on a report.
 *
 * The two surfaces keep their own MISSING-person fallbacks, because the domains genuinely differ: a report
 * may be anonymous (no user row at all -> `id: null`, "Anonymous"), while a cleanup always has an organizer
 * and a null there is data corruption, not a supported state (-> `id: ""`, "Unknown"). Those strings are on
 * the wire, so they stay caller-supplied rather than being unified into one default here.
 */

import type { Queryable } from "../../db/client.js"
import { toRelAbs } from "./admin-format.js"
import type { SqlFragment } from "./sql-fragments.js"

/**
 * A person joined onto an admin row (a report's reporter, an event's organizer), as the repo resolves it.
 * Null at the call site means "no joined user" (an anonymous report), never "a user with empty fields".
 */
export interface AdminPersonRecord {
  id: string
  name: string
  handle: string | null
  emailVerified: boolean
  hasOauth: boolean
  joinedAt: Date | null
}

/**
 * The six values personSelect emits, read back off the row. ALL nullable: the join is a LEFT JOIN, so a
 * row with no person yields null for every one of them (`id === null` is the authoritative "no person"
 * test — a real `users.id` is never null).
 */
export interface AdminPersonColumns {
  id: string | null
  name: string | null
  handle: string | null
  emailVerified: boolean | null
  hasOauth: boolean | null
  joinedAt: Date | null
}

/**
 * The person columns for one row select: `<alias>.<col> AS <prefix>_<col>` over a LEFT-JOINed `users`
 * alias, in the order AdminPersonColumns reads them. `alias` and `prefix` are interpolated as postgres.js
 * IDENTIFIERS (`sql(name)`), never as raw text.
 *
 * `has_oauth` is a correlated EXISTS rather than a join so it cannot fan the row out when an account holds
 * several oauth identities.
 */
export function personSelect(sql: Queryable, alias: string, prefix: string): SqlFragment {
  const u = sql(alias)
  return sql`
    ${u}.id AS ${sql(`${prefix}_id`)},
    ${u}.display_name AS ${sql(`${prefix}_name`)},
    ${u}.handle AS ${sql(`${prefix}_handle`)},
    ${u}.email_verified AS ${sql(`${prefix}_email_verified`)},
    EXISTS (SELECT 1 FROM oauth_identities oi WHERE oi.user_id = ${u}.id) AS ${sql(`${prefix}_has_oauth`)},
    ${u}.created_at AS ${sql(`${prefix}_joined`)}
  `
}

/**
 * Project the selected columns into the record, or null when no person joined. `fallbackName` covers a user
 * row whose `display_name` is null (the account exists, so this is NOT the anonymous case) — each surface
 * passes its own noun.
 */
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
 * Project the record into the wire shape both surfaces render: `{ id, name, handle, joined }`, where
 * `joined` is the ABSOLUTE half of the timestamp pair (the design shows a join date, not "3 months ago").
 *
 * `missing` supplies the no-person values. It is generic on `id` alone so both contract shapes are met
 * without a cast: the report DTO's `reporter.id` is nullable and passes `null`, the event DTO's
 * `organizer.id` is a plain string and passes `""`.
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
