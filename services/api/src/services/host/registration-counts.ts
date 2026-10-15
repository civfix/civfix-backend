import type { Sql } from "../../db/client.js"
import { makeDrizzleHostRegistrationRepository } from "./registration-repository.drizzle.js"
import type { HostedEventCounts } from "./registration-repository.js"

export type { HostedEventCounts }

export const HOSTED_EVENT_COUNTS_MAX = 50

export async function hostedEventCounts(
  sql: Sql,
  cleanupIds: readonly string[],
): Promise<Map<string, HostedEventCounts>> {
  if (cleanupIds.length === 0) return new Map()
  const bounded = cleanupIds.slice(0, HOSTED_EVENT_COUNTS_MAX)
  return makeDrizzleHostRegistrationRepository(sql).hostedEventCounts(bounded)
}
