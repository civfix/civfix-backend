import type { Queryable, Sql } from "../../db/client.js"
import {
  HOSTED_EVENT_COUNTS_MAX,
  hostedEventCounts as registrationCounts,
} from "./registration-counts.js"
import { eventHoursByCleanup } from "./host-portfolio-repository.drizzle.js"

export interface HostedEventCounts {
  registered: number
  checkedIn: number
  waitlisted: number
  hoursCredited: number
}

export const ZERO_HOSTED_EVENT_COUNTS: HostedEventCounts = Object.freeze({
  registered: 0,
  checkedIn: 0,
  waitlisted: 0,
  hoursCredited: 0,
})

export async function hostedEventCounts(
  sql: Queryable,
  cleanupIds: readonly string[],
): Promise<Map<string, HostedEventCounts>> {
  const out = new Map<string, HostedEventCounts>()
  if (cleanupIds.length === 0) return out
  const bounded = cleanupIds.slice(0, HOSTED_EVENT_COUNTS_MAX)
  const [rows, hours] = await Promise.all([
    registrationCounts(sql as Sql, bounded),
    eventHoursByCleanup(sql, bounded),
  ])
  for (const [cleanupId, counts] of rows) {
    out.set(cleanupId, {
      registered: counts.registeredCount,
      checkedIn: counts.checkedInCount,
      waitlisted: counts.waitlistCount,
      hoursCredited: hours.get(cleanupId) ?? 0,
    })
  }
  return out
}
