import type postgres from "postgres"
import type { Sql } from "../../db/client.js"

export interface CountRow {
  n: string
}

// Each read returns the pending query rather than its rows so the probe can cancel it on timeout.
export interface SystemHealthRepository {
  countJurisdictions(): postgres.PendingQuery<CountRow[]>
  countMailEventsLast7Days(): postgres.PendingQuery<CountRow[]>
}

export function makeDrizzleSystemHealthRepository(sql: Sql): SystemHealthRepository {
  return {
    countJurisdictions() {
      return sql<CountRow[]>`SELECT COUNT(*)::text AS n FROM jurisdictions`
    },

    countMailEventsLast7Days() {
      return sql<CountRow[]>`
        SELECT COUNT(*)::text AS n
        FROM mail_events
        WHERE created_at >= now() - make_interval(days => 7)
      `
    },
  }
}
