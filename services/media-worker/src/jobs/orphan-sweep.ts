/**
 * orphan.sweep cron: reap never-attached media.
 *
 * A media_assets row is created at upload time with report_id NULL and only gains a report_id when a
 * report commits. A row that is STILL report_id NULL after the TTL (default 24h) is an orphan: the
 * client started an upload that never became a report. This sweep deletes the orphan's R2 objects
 * (source + processed + thumbnail, all derivable from r2_key) and then the row.
 *
 * Safety/idempotency: storage deletes are idempotent on R2 (deleting a missing key is a no-op), and the
 * row delete is by id. A partial run (objects deleted, row delete fails) simply retries next sweep. We
 * process a bounded batch per run (orphanSweepBatch) so a backlog drains over several runs without one
 * giant transaction. NEVER throws: a per-row error is logged and the sweep continues.
 *
 * This is the plan's section-11 orphan sweep.
 */

import type { Storage } from "@civfix/shared/interfaces"
import type { MediaWorkerRepo, OrphanRow } from "@civfix/api/media-repo"
import type { WorkerLimits } from "../config.js"

export interface OrphanSweepDeps {
  repo: MediaWorkerRepo
  storage: Storage
  limits: WorkerLimits
  /** Injectable clock (defaults to Date.now) for deterministic tests. */
  now?: () => Date
  log?: (line: string, extra?: Record<string, unknown>) => void
  report?: (err: unknown, context?: Record<string, unknown>) => void
}

export interface OrphanSweepResult {
  scanned: number
  deleted: number
  errors: number
}

/**
 * Keys to delete for an orphan: the source object (r2_key), the thumbnail the checks job writes, and any
 * LEGACY `processed/*` objects from before the worker switched to overwriting r2_key in place (it no
 * longer writes a separate processed object; older uploads may still have one). Deleting a missing key is
 * a no-op on R2, so listing the legacy keys is harmless cleanup.
 */
function derivedKeys(o: OrphanRow): string[] {
  const keys = [
    o.r2Key,
    `processed/${o.r2Key}.img`,
    `processed/${o.r2Key}.mp4`,
    `thumbs/${o.r2Key}.jpg`,
  ]
  if (o.thumbKey && !keys.includes(o.thumbKey)) keys.push(o.thumbKey)
  return keys
}

/**
 * Run one orphan sweep. Returns counts. Never throws; per-row failures are counted + logged + reported.
 */
export async function runOrphanSweep(deps: OrphanSweepDeps): Promise<OrphanSweepResult> {
  const log = deps.log ?? ((l: string, e?: Record<string, unknown>) => console.log(l, e ?? {}))
  const report = deps.report ?? (() => {})
  const now = (deps.now ?? (() => new Date()))()
  const cutoff = new Date(now.getTime() - deps.limits.orphanTtlMs)

  let orphans: OrphanRow[]
  try {
    orphans = await deps.repo.findOrphans(cutoff, deps.limits.orphanSweepBatch)
  } catch (err) {
    report(err, { job: "orphan.sweep", phase: "find" })
    log("orphan.sweep: find failed", { err: String(err) })
    return { scanned: 0, deleted: 0, errors: 1 }
  }

  let deleted = 0
  let errors = 0
  for (const o of orphans) {
    try {
      // Delete objects first (idempotent), then the row. If the row delete fails, the next run retries.
      for (const key of derivedKeys(o)) {
        await deps.storage.delete(key)
      }
      await deps.repo.deleteById(o.id)
      deleted++
    } catch (err) {
      errors++
      report(err, { job: "orphan.sweep", phase: "delete", mediaId: o.id })
      log("orphan.sweep: row failed", { mediaId: o.id, err: String(err) })
    }
  }

  log("orphan.sweep: done", {
    scanned: orphans.length,
    deleted,
    errors,
    cutoff: cutoff.toISOString(),
  })
  return { scanned: orphans.length, deleted, errors }
}
