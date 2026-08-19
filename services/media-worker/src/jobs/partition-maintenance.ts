
import { ensureChatPartitionWindow, ensureDmPartitionWindow } from "@civfix/api/media-repo"
import type { Sql } from "@civfix/api/db"
import { resolveJobObs, type JobObsDeps } from "./obs.js"

export const PARTITION_MONTHS_AHEAD = 2

export interface PartitionMaintenanceDeps extends JobObsDeps {
  sql: Sql
  monthsAhead?: number
}

export interface PartitionMaintenanceResult {
  chat: string[]
  dm: string[]
}

export async function runPartitionMaintenance(
  deps: PartitionMaintenanceDeps,
): Promise<PartitionMaintenanceResult> {
  const { log, report, now } = resolveJobObs(deps)
  const at = now()
  const monthsAhead = deps.monthsAhead ?? PARTITION_MONTHS_AHEAD
  try {
    const chat = await ensureChatPartitionWindow(deps.sql, at, monthsAhead)
    const dm = await ensureDmPartitionWindow(deps.sql, at, monthsAhead)
    log("chat.partition.maintenance: ensured", { chat, dm })
    return { chat, dm }
  } catch (err) {
    report(err, { job: "chat.partition.maintenance" })
    log("chat.partition.maintenance: failed", { err: String(err) })
    throw err
  }
}
