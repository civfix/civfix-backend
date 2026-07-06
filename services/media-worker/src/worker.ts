
import type { JobHandler } from "@civfix/shared/interfaces"
import { MEDIA_CHECKS_JOB } from "@civfix/api/media-repo"
import { releaseAnonHoldIfReady, type HeldReportView } from "@civfix/api/anon-hold-release"
import { buildJobs, type JobsHandle, type WorkerJobs } from "./jobs.js"
import { buildSeams, type WorkerSeams } from "./seams.js"
import {
  CHAT_PARTITION_CRON,
  HOLD_RELEASE_SWEEP_CRON,
  ORPHAN_SWEEP_CRON,
  RETENTION_SWEEP_CRON,
  type WorkerLimits,
} from "./config.js"
import { runMediaChecksJob, parsePayload } from "./jobs/media-checks.js"
import { runOrphanSweep } from "./jobs/orphan-sweep.js"
import { runHoldReleaseSweep } from "./jobs/hold-release-sweep.js"
import { runPartitionMaintenance } from "./jobs/partition-maintenance.js"
import { runRetentionSweep } from "./jobs/retention-sweep.js"
import { sweepStaleScratchDirs } from "./sandbox/tmp.js"

export const ORPHAN_SWEEP_JOB = "orphan.sweep"
export const CHAT_PARTITION_JOB = "chat.partition.maintenance"
export const ANON_HOLD_RELEASE_JOB = "anon.hold.release"
export const ANON_HOLD_RELEASE_SWEEP_JOB = "anon.hold.release.sweep"
export const RETENTION_SWEEP_JOB = "retention.sweep"

const CRON_EXPIRE_SECONDS = 25 * 60

export interface Worker {
  jobs: WorkerJobs
  seams: WorkerSeams
  start(): Promise<void>
  stop(): Promise<void>
}

function isAnonHeldReport(report: HeldReportView | null): boolean {
  return report !== null && report.reporterUserId === null && report.status === "held"
}

async function shouldEnqueueHoldRelease(seams: WorkerSeams, reportId: string): Promise<boolean> {
  if (!seams.anonHoldRepo) return true
  return isAnonHeldReport(await seams.anonHoldRepo.findReport(reportId))
}

function makeMediaChecksHandler(jobs: WorkerJobs, seams: WorkerSeams): JobHandler {
  return async (job) => {
    const payload = parsePayload(job.data)
    if (!payload) {
      console.warn("media.checks: malformed payload, skipping", { id: job.id })
      return
    }
    if (!seams.repo) {
      console.warn("media.checks: no DB repo configured (offline mode); skipping", {
        uploadId: payload.uploadId,
      })
      return
    }
    await runMediaChecksJob(payload, {
      repo: seams.repo,
      storage: seams.storage,
      abuseChecks: seams.abuseChecks,
      limits: seams.limits,
      download: seams.download,
      ...(seams.findPhashDuplicate ? { findPhashDuplicate: seams.findPhashDuplicate } : {}),
      report: seams.report,
    })

    try {
      const asset =
        (await seams.repo.findById(payload.mediaId)) ??
        (await seams.repo.findByUploadId(payload.uploadId))
      const reportId = asset?.reportId ?? null
      if (reportId && (await shouldEnqueueHoldRelease(seams, reportId))) {
        await jobs.enqueue(
          ANON_HOLD_RELEASE_JOB,
          { reportId },
          { singletonKey: reportId },
        )
      } else {
        console.debug("media.checks: hold-release skipped (no row/reportId, or not anon-held)", {
          uploadId: payload.uploadId,
          found: Boolean(asset),
        })
      }
    } catch (err) {
      console.warn("media.checks: failed to enqueue anon.hold.release (non-fatal)", {
        uploadId: payload.uploadId,
        err: String(err),
      })
    }
  }
}

function parseHoldReleasePayload(data: unknown): { reportId: string } | null {
  if (typeof data !== "object" || data === null) return null
  const d = data as Record<string, unknown>
  return typeof d.reportId === "string" ? { reportId: d.reportId } : null
}

function makeAnonHoldReleaseHandler(seams: WorkerSeams): JobHandler {
  return async (job) => {
    const payload = parseHoldReleasePayload(job.data)
    if (!payload) {
      console.warn("anon.hold.release: malformed payload, skipping", { id: job.id })
      return
    }
    if (!seams.anonHoldRepo) {
      console.warn("anon.hold.release: no DB repo configured (offline mode); skipping", {
        reportId: payload.reportId,
      })
      return
    }
    try {
      await releaseAnonHoldIfReady(payload.reportId, {
        repo: seams.anonHoldRepo,
        abuseChecks: seams.abuseChecks,
      })
    } catch (err) {
      seams.report(err, { job: ANON_HOLD_RELEASE_JOB, reportId: payload.reportId })
      console.error("anon.hold.release: unexpected error", {
        reportId: payload.reportId,
        err: String(err),
      })
    }
  }
}

function requireRepo<K extends keyof WorkerSeams>(
  seams: WorkerSeams,
  jobName: string,
  key: K,
): NonNullable<WorkerSeams[K]> | undefined {
  const value = seams[key]
  if (!value) {
    console.warn(`${jobName}: no DB configured (offline mode); skipping`)
    return undefined
  }
  return value as NonNullable<WorkerSeams[K]>
}

function makeOrphanSweepHandler(seams: WorkerSeams): JobHandler {
  return async () => {
    const repo = requireRepo(seams, ORPHAN_SWEEP_JOB, "repo")
    if (!repo) return
    await runOrphanSweep({ repo, storage: seams.storage, limits: seams.limits, report: seams.report })
  }
}

function makeHoldReleaseSweepHandler(seams: WorkerSeams): JobHandler {
  return async () => {
    const repo = requireRepo(seams, ANON_HOLD_RELEASE_SWEEP_JOB, "anonHoldRepo")
    if (!repo) return
    await runHoldReleaseSweep({
      repo,
      abuseChecks: seams.abuseChecks,
      batchSize: seams.limits.holdReleaseSweepBatch,
      report: seams.report,
    })
  }
}

function makePartitionHandler(seams: WorkerSeams): JobHandler {
  return async () => {
    const dbHandle = requireRepo(seams, CHAT_PARTITION_JOB, "dbHandle")
    if (!dbHandle) return
    await runPartitionMaintenance({ sql: dbHandle.sql, report: seams.report })
  }
}

function makeRetentionSweepHandler(seams: WorkerSeams): JobHandler {
  return async () => {
    const dbHandle = requireRepo(seams, RETENTION_SWEEP_JOB, "dbHandle")
    if (!dbHandle) return
    await runRetentionSweep({ sql: dbHandle.sql, report: seams.report })
  }
}

async function registerHandlers(
  jobs: WorkerJobs,
  seams: WorkerSeams,
  limits: WorkerLimits,
): Promise<void> {
  await jobs.createQueue(MEDIA_CHECKS_JOB, { policy: "short", retryLimit: 5, retryBackoff: true })
  await jobs.createQueue(ORPHAN_SWEEP_JOB)
  await jobs.createQueue(CHAT_PARTITION_JOB)
  await jobs.createQueue(ANON_HOLD_RELEASE_JOB, { policy: "short" })
  await jobs.createQueue(ANON_HOLD_RELEASE_SWEEP_JOB)
  await jobs.createQueue(RETENTION_SWEEP_JOB)

  await jobs.workWithSettings(MEDIA_CHECKS_JOB, makeMediaChecksHandler(jobs, seams), {
    batchSize: limits.mediaChecksConcurrency,
  })

  await jobs.work(ANON_HOLD_RELEASE_JOB, makeAnonHoldReleaseHandler(seams))

  await jobs.work(ORPHAN_SWEEP_JOB, makeOrphanSweepHandler(seams))
  await jobs.work(CHAT_PARTITION_JOB, makePartitionHandler(seams))
  await jobs.work(ANON_HOLD_RELEASE_SWEEP_JOB, makeHoldReleaseSweepHandler(seams))
  await jobs.work(RETENTION_SWEEP_JOB, makeRetentionSweepHandler(seams))

  await jobs.schedule(ORPHAN_SWEEP_JOB, ORPHAN_SWEEP_CRON, undefined, cronSchedule(ORPHAN_SWEEP_JOB))
  await jobs.schedule(CHAT_PARTITION_JOB, CHAT_PARTITION_CRON, undefined, cronSchedule(CHAT_PARTITION_JOB))
  await jobs.schedule(
    ANON_HOLD_RELEASE_SWEEP_JOB,
    HOLD_RELEASE_SWEEP_CRON,
    undefined,
    cronSchedule(ANON_HOLD_RELEASE_SWEEP_JOB),
  )
  await jobs.schedule(RETENTION_SWEEP_JOB, RETENTION_SWEEP_CRON, undefined, cronSchedule(RETENTION_SWEEP_JOB))
}

function cronSchedule(name: string): { expireInSeconds: number; singletonKey: string } {
  return { expireInSeconds: CRON_EXPIRE_SECONDS, singletonKey: name }
}

export async function buildWorker(
  handle: JobsHandle = buildJobs(),
  seams?: WorkerSeams,
): Promise<Worker> {
  const resolvedSeams = seams ?? (await buildSeams())
  let started = false

  async function start(): Promise<void> {
    if (started) return
    await sweepStaleScratchDirs().catch(() => 0)
    await handle.start()
    await registerHandlers(handle.jobs, resolvedSeams, resolvedSeams.limits)
    started = true
  }

  async function stop(): Promise<void> {
    await handle.stop()
    await resolvedSeams.close()
    started = false
  }

  return { jobs: handle.jobs, seams: resolvedSeams, start, stop }
}

let shuttingDown = false

export async function start(): Promise<Worker> {
  const worker = await buildWorker()
  await worker.start()
  console.log("civfix media-worker started")

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`media-worker: ${signal} received, stopping`)
    try {
      await worker.stop()
      process.exit(0)
    } catch (err) {
      console.error("media-worker: error during shutdown", err)
      process.exit(1)
    }
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))

  return worker
}
