import type { FastifyBaseLogger } from "fastify"
import type { Sql } from "../../db/client.js"

export interface RetentionLaneResult {
  lane: string
  processed: number
}

export type RetentionLane = (sql: Sql, now: Date) => Promise<number>

interface RegisteredLane {
  name: string
  run: RetentionLane
}

const lanes: RegisteredLane[] = []

export function registerRetentionLane(name: string, run: RetentionLane): void {
  if (lanes.some((lane) => lane.name === name)) return
  lanes.push({ name, run })
}

export function registeredRetentionLanes(): readonly RegisteredLane[] {
  return lanes
}

export function resetRetentionLanesForTests(): void {
  lanes.length = 0
}

export async function runRetentionLanes(
  sql: Sql,
  now: Date,
  logger?: Pick<FastifyBaseLogger, "info" | "warn">,
): Promise<RetentionLaneResult[]> {
  const results: RetentionLaneResult[] = []
  for (const lane of lanes) {
    try {
      const processed = await lane.run(sql, now)
      results.push({ lane: lane.name, processed })
    } catch (err) {
      logger?.warn({ err, lane: lane.name }, "host retention: lane failed (other lanes continue)")
      results.push({ lane: lane.name, processed: 0 })
    }
  }
  logger?.info({ evt: "host.retention.done", results }, "host retention sweep complete")
  return results
}

export const RETENTION_BATCH_SIZE = 1000
export const RETENTION_MAX_PAGES = 50

export async function drainTable(
  page: (batchSize: number) => Promise<number>,
  batchSize = RETENTION_BATCH_SIZE,
  maxPages = RETENTION_MAX_PAGES,
): Promise<number> {
  let total = 0
  for (let i = 0; i < maxPages; i += 1) {
    const done = await page(batchSize)
    total += done
    if (done < batchSize) break
  }
  return total
}
