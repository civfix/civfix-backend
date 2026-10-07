import type postgres from "postgres"

export interface CountRow {
  n: string
}

// Each read returns the pending query rather than its rows so the probe can cancel it on timeout.
export interface SystemHealthRepository {
  countJurisdictions(): postgres.PendingQuery<CountRow[]>
  countMailEventsLast7Days(): postgres.PendingQuery<CountRow[]>
}
