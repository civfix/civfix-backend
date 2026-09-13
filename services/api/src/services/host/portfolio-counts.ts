import type { Queryable, Sql } from "../../db/client.js"
import {
  HOSTED_EVENT_COUNTS_MAX,
  hostedEventCounts as registrationCounts,
} from "./registration-counts.js"

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

async function hoursByEvent(
  sql: Queryable,
  cleanupIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (cleanupIds.length === 0) return out
  const rows = await sql<{ cleanup_id: string; hours: number }[]>`
    SELECT vh.cleanup_id, COALESCE(sum(vh.hours), 0)::float8 AS hours
      FROM volunteer_hours vh
     WHERE vh.cleanup_id = ANY(${[...cleanupIds]}::uuid[])
       AND vh.source = 'event'
       AND vh.voided_at IS NULL
     GROUP BY vh.cleanup_id`
  for (const row of rows) out.set(row.cleanup_id, Number(row.hours))
  return out
}

export async function hostedEventCounts(
  sql: Queryable,
  cleanupIds: readonly string[],
): Promise<Map<string, HostedEventCounts>> {
  const out = new Map<string, HostedEventCounts>()
  if (cleanupIds.length === 0) return out
  const bounded = cleanupIds.slice(0, HOSTED_EVENT_COUNTS_MAX)
  const [rows, hours] = await Promise.all([
    registrationCounts(sql as Sql, bounded),
    hoursByEvent(sql, bounded),
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
