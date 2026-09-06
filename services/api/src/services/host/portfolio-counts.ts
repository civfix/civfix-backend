import type { Queryable, Sql } from "../../db/client.js"
import { hostedEventCounts as registrationCounts } from "./registration-counts.js"

export interface HostedEventCounts {
  registered: number
  checkedIn: number
  waitlisted: number
}

export const ZERO_HOSTED_EVENT_COUNTS: HostedEventCounts = Object.freeze({
  registered: 0,
  checkedIn: 0,
  waitlisted: 0,
})

export async function hostedEventCounts(
  sql: Queryable,
  cleanupIds: readonly string[],
): Promise<Map<string, HostedEventCounts>> {
  const out = new Map<string, HostedEventCounts>()
  if (cleanupIds.length === 0) return out
  const rows = await registrationCounts(sql as Sql, cleanupIds)
  for (const [cleanupId, counts] of rows) {
    out.set(cleanupId, {
      registered: counts.registeredCount,
      checkedIn: counts.checkedInCount,
      waitlisted: counts.waitlistCount,
    })
  }
  return out
}
