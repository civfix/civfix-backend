// The admin reports and events surfaces share this one SQL definition of the joined person: a silent
// divergence would make one surface report `hasOauth: false` for every account, the provenance signal an
// operator reads before acting on a report.

import type { Queryable, SqlFragment } from "../../db/client.js"

/**
 * `alias` and `prefix` are interpolated as postgres.js identifiers (`sql(name)`), never as raw text.
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
