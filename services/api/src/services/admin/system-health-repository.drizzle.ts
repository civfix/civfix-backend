import type { Sql } from "../../db/client.js"
import type { CountRow, SystemHealthRepository } from "./system-health-repository.js"

export function makeDrizzleSystemHealthRepository(sql: Sql): SystemHealthRepository {
  return {
    countJurisdictions() {
      return sql<CountRow[]>`SELECT COUNT(*)::text AS n FROM jurisdictions`
    },

    countSentMailLast7Days() {
      return sql<CountRow[]>`
        SELECT COUNT(*)::text AS n
        FROM mail_events
        WHERE type = 'sent' AND created_at >= now() - make_interval(days => 7)
      `
    },
  }
}
