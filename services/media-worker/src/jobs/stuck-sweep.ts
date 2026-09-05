import type { Jobs, Storage } from "@civfix/shared/interfaces"
import { MEDIA_CHECKS_JOB, type MediaWorkerRepo, type StuckMediaRow } from "@civfix/api/media-repo"
import type { WorkerLimits } from "../config.js"
import { resolveJobObs, type JobObsDeps } from "./obs.js"
import { deleteRejectedObjects } from "./reject-cleanup.js"
import { MEDIA_UPLOAD_REAP_JOB, uploadReapDelaySec } from "./upload-reap.js"

export interface StuckSweepDeps extends JobObsDeps {
  repo: MediaWorkerRepo
  jobs: Pick<Jobs, "enqueue">
  storage: Storage
  limits: WorkerLimits
}

export interface StuckSweepResult {
  scanned: number
  requeued: number
  terminalized: number
  errors: number
}

export async function runStuckSweep(deps: StuckSweepDeps): Promise<StuckSweepResult> {
  const { log, report, now } = resolveJobObs(deps)
  const cutoff = new Date(now().getTime() - deps.limits.stuckMediaTtlMs)
  const maxAttempts = deps.limits.stuckSweepMaxAttempts

  let rows: StuckMediaRow[]
  try {
    rows = await deps.repo.findStuckValidating(cutoff, deps.limits.stuckSweepBatch)
  } catch (err) {
    report(err, { job: "media.stuck.sweep", phase: "find" })
    log("media.stuck.sweep: find failed", { err: String(err) })
    return { scanned: 0, requeued: 0, terminalized: 0, errors: 1 }
  }

  let requeued = 0
  let terminalized = 0
  let errors = 0
  for (const row of rows) {
    if (row.checkCount > maxAttempts) {
      try {
        const rejected = await deps.repo.terminalizeStuck(row.id)
        if (rejected === null) {
          log("media.stuck.sweep: give-up skipped, media already terminal", {
            mediaId: row.id,
            uploadId: row.uploadId,
          })
          continue
        }
        terminalized++
        log("media.stuck.sweep: gave up, media rejected", {
          mediaId: row.id,
          uploadId: row.uploadId,
          checkCount: row.checkCount,
          maxAttempts,
        })
        await deleteRejectedObjects(rejected, deps, log, report)
        await deps.jobs
          .enqueue(
            MEDIA_UPLOAD_REAP_JOB,
            { mediaId: row.id, uploadId: row.uploadId, r2Key: row.r2Key },
            { singletonKey: row.uploadId, startAfter: uploadReapDelaySec() },
          )
          .catch((err: unknown) =>
            log("media.stuck.sweep: failed to schedule media.upload.reap (non-fatal)", {
              mediaId: row.id,
              err: String(err),
            }),
          )
      } catch (err) {
        errors++
        report(err, { job: "media.stuck.sweep", phase: "terminalize", mediaId: row.id })
        log("media.stuck.sweep: terminalize failed", { mediaId: row.id, err: String(err) })
      }
      continue
    }

    try {
      await deps.jobs.enqueue(
        MEDIA_CHECKS_JOB,
        { mediaId: row.id, uploadId: row.uploadId, r2Key: row.r2Key, kind: row.kind },
        { singletonKey: row.uploadId },
      )
      requeued++
    } catch (err) {
      errors++
      report(err, { job: "media.stuck.sweep", phase: "requeue", mediaId: row.id })
      log("media.stuck.sweep: re-enqueue failed", { mediaId: row.id, err: String(err) })
    }
  }

  log("media.stuck.sweep: done", {
    scanned: rows.length,
    requeued,
    terminalized,
    errors,
    cutoff: cutoff.toISOString(),
  })
  return { scanned: rows.length, requeued, terminalized, errors }
}
