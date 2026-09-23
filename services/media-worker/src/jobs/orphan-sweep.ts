import type { Storage } from "@civfix/shared/interfaces"
import type { LeakedObjectRow, MediaWorkerRepo, OrphanRow } from "@civfix/api/media-repo"
import type { WorkerLimits } from "../config.js"
import { drainPages } from "./drain.js"
import { resolveJobObs, type JobObsDeps, type JobLogFn, type JobReportFn } from "./obs.js"
import { R2_PUT_TTL_SEC } from "@civfix/api/adapters/storage"
import { servedKey, thumbnailKey } from "./media-keys.js"
import { mapWithLimit } from "@civfix/api/concurrency"
import { MS_PER_SECOND } from "@civfix/api/time"
import { ORPHAN_SWEEP_JOB } from "@civfix/api/queue-names"

const ORPHAN_CONCURRENCY = 8
const LEGACY_PROCESSED_SUFFIXES = [".img", ".mp4"]

export const LEAK_RETRY_MAX_ATTEMPTS = 5

const LEAK_RETRY_LIMIT = 200

export interface OrphanSweepDeps extends JobObsDeps {
  repo: MediaWorkerRepo
  storage: Storage
  limits: WorkerLimits
}

export interface OrphanSweepResult {
  scanned: number
  deleted: number
  adoptedLegacyServedKeys: number
  boundMeanwhile: number
  errors: number
  leaked: number
  retried: number
  reclaimed: number
}

function derivedKeys(o: OrphanRow): string[] {
  const served = servedKey(o.r2Key)
  const keys = [
    o.r2Key,
    served,
    ...LEGACY_PROCESSED_SUFFIXES.map((suffix) => `${served}${suffix}`),
    thumbnailKey(o.r2Key),
  ]
  if (o.servedKey && !keys.includes(o.servedKey)) keys.push(o.servedKey)
  if (o.thumbKey && !keys.includes(o.thumbKey)) keys.push(o.thumbKey)
  return keys
}

export async function runOrphanSweep(deps: OrphanSweepDeps): Promise<OrphanSweepResult> {
  const { log, report, now: clock } = resolveJobObs(deps)
  const cutoff = new Date(clock().getTime() - deps.limits.orphanTtlMs)

  let deleted = 0
  let errors = 0
  let scanned = 0
  let leaked = 0
  let boundMeanwhile = 0

  const retry = await retryTombstonedLeaks(deps, log, report)
  errors += retry.errors

  const adoptedLegacyServedKeys = await adoptLegacyServedKeys(deps, log, report)

  try {
    await drainPages(
      (limit) => deps.repo.findOrphans(cutoff, limit),
      async (orphans) => {
        scanned += orphans.length
        await sweepPage(orphans, cutoff, deps, {
          onDeleted: () => deleted++,
          onBoundMeanwhile: () => boundMeanwhile++,
          onError: (err, id) => {
            errors++
            report(err, { job: ORPHAN_SWEEP_JOB, phase: "delete", mediaId: id })
            log("orphan.sweep: row failed", { mediaId: id, err: String(err) })
          },
          onLeak: (keys, id) => {
            leaked += keys.length
            errors++
            report(
              new Error(
                `orphan.sweep leaked ${keys.length} R2 object(s) (row already deleted, tombstoned for retry)`,
              ),
              { job: ORPHAN_SWEEP_JOB, phase: "object-delete", mediaId: id, keys },
            )
          },
        })
      },
      { pageSize: deps.limits.orphanSweepBatch, maxPages: deps.limits.orphanSweepMaxPages },
    )
  } catch (err) {
    report(err, { job: ORPHAN_SWEEP_JOB, phase: "find" })
    log("orphan.sweep: find failed", { err: String(err) })
    errors++
  }

  log("orphan.sweep: done", {
    scanned,
    deleted,
    adoptedLegacyServedKeys,
    boundMeanwhile,
    errors,
    leaked,
    retried: retry.retried,
    reclaimed: retry.reclaimed,
    cutoff: cutoff.toISOString(),
  })
  return {
    scanned,
    deleted,
    adoptedLegacyServedKeys,
    boundMeanwhile,
    errors,
    leaked,
    retried: retry.retried,
    reclaimed: retry.reclaimed,
  }
}

async function retryTombstonedLeaks(
  deps: OrphanSweepDeps,
  log: JobLogFn,
  report: JobReportFn,
): Promise<{ retried: number; reclaimed: number; errors: number }> {
  const { repo } = deps
  const clear = repo.clearLeakedObject?.bind(repo)
  if (!repo.listLeakedObjects || !clear) return { retried: 0, reclaimed: 0, errors: 0 }

  let rows: LeakedObjectRow[]
  try {
    rows = await repo.listLeakedObjects(LEAK_RETRY_LIMIT, LEAK_RETRY_MAX_ATTEMPTS)
  } catch (err) {
    report(err, { job: ORPHAN_SWEEP_JOB, phase: "leak-list" })
    log("orphan.sweep: tombstone list failed", { err: String(err) })
    return { retried: 0, reclaimed: 0, errors: 1 }
  }
  if (rows.length === 0) return { retried: 0, reclaimed: 0, errors: 0 }

  let retried = 0
  let reclaimed = 0
  let errors = 0
  await mapWithLimit(rows, ORPHAN_CONCURRENCY, async (row) => {
    retried++
    try {
      await deps.storage.delete(row.r2Key)
      await clear(row.r2Key)
      reclaimed++
    } catch (err) {
      errors++
      await recordLeakRetryFailure(row, err, repo, log, report)
    }
  })
  return { retried, reclaimed, errors }
}

async function recordLeakRetryFailure(
  row: LeakedObjectRow,
  err: unknown,
  repo: MediaWorkerRepo,
  log: JobLogFn,
  report: JobReportFn,
): Promise<void> {
  const attempts = row.attempts + 1
  await repo
    .recordLeakedObjects?.({ mediaId: row.mediaId, keys: [row.r2Key], error: String(err) })
    .catch((bumpErr: unknown) =>
      log("orphan.sweep: tombstone bump failed", { key: row.r2Key, err: String(bumpErr) }),
    )
  log("orphan.sweep: tombstoned object delete failed again", {
    key: row.r2Key,
    attempts,
    err: String(err),
  })
  if (attempts >= LEAK_RETRY_MAX_ATTEMPTS) {
    report(new Error(`orphan.sweep gave up on a leaked R2 object after ${attempts} attempts`), {
      job: ORPHAN_SWEEP_JOB,
      phase: "leak-retry",
      key: row.r2Key,
      mediaId: row.mediaId,
    })
  }
}

let legacyServedKeyAdoptionDrained = false

export function resetLegacyServedKeyAdoption(): void {
  legacyServedKeyAdoptionDrained = false
}

async function adoptLegacyServedKeys(
  deps: OrphanSweepDeps,
  log: JobLogFn,
  report: JobReportFn,
): Promise<number> {
  if (legacyServedKeyAdoptionDrained) return 0
  const { now: clock } = resolveJobObs(deps)
  const cutoff = new Date(clock().getTime() - R2_PUT_TTL_SEC * MS_PER_SECOND)
  try {
    const { adopted, remaining } = await deps.repo.adoptLegacyServedKeys(
      cutoff,
      deps.limits.orphanSweepBatch,
    )
    if (adopted > 0) {
      log("orphan.sweep: adopted pre-0097 ready rows onto served_key", { adopted })
    }
    if (adopted === 0 && remaining === 0) {
      legacyServedKeyAdoptionDrained = true
      log("orphan.sweep: no pre-0097 ready rows remain; legacy served-key adoption is done", {})
    }
    return adopted
  } catch (err) {
    report(err, { job: ORPHAN_SWEEP_JOB, phase: "adopt-legacy-served-keys" })
    log("orphan.sweep: legacy served-key adoption failed", { err: String(err) })
    return 0
  }
}

interface SweepPageHooks {
  onDeleted: () => void
  onBoundMeanwhile: () => void
  onError: (err: unknown, id: string) => void
  onLeak: (keys: string[], id: string) => void
}

async function sweepPage(
  orphans: OrphanRow[],
  cutoff: Date,
  deps: OrphanSweepDeps,
  hooks: SweepPageHooks,
): Promise<void> {
  const { log } = resolveJobObs(deps)
  await mapWithLimit(orphans, ORPHAN_CONCURRENCY, async (o) => {
    try {
      const reaped = await deps.repo.deleteOrphan(o.id, cutoff)
      if (reaped === null) {
        hooks.onBoundMeanwhile()
        log("orphan.sweep: row bound between select and reap, skipped", { mediaId: o.id })
        return
      }
      const stillShared = await deps.repo.r2KeyReferencedByOthers(reaped.id, reaped.r2Key)
      const leaked = stillShared ? [] : await deleteObjects(reaped, deps, log)
      hooks.onDeleted()
      if (leaked.length > 0) {
        await deps.repo
          .recordLeakedObjects?.({ mediaId: o.id, keys: leaked, error: "storage delete failed" })
          .catch((err: unknown) =>
            log("orphan.sweep: tombstone write failed (leak is now unrecoverable)", {
              mediaId: o.id,
              keys: leaked,
              err: String(err),
            }),
          )
        hooks.onLeak(leaked, o.id)
      }
    } catch (err) {
      hooks.onError(err, o.id)
    }
  })
}

async function deleteObjects(
  o: OrphanRow,
  deps: OrphanSweepDeps,
  log: JobLogFn,
): Promise<string[]> {
  const outcomes = await Promise.all(
    derivedKeys(o).map(async (key) => {
      try {
        await deps.storage.delete(key)
        return null
      } catch (err) {
        log("orphan.sweep: object delete failed (LEAKED in R2, row already gone)", {
          mediaId: o.id,
          key,
          err: String(err),
        })
        return key
      }
    }),
  )
  return outcomes.filter((key): key is string => key !== null)
}
