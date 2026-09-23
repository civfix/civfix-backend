import type { JobHandler } from "@civfix/shared/interfaces"
import {
  ANON_HOLD_RELEASE_JOB,
  ANON_HOLD_RELEASE_SWEEP_JOB,
  CHAT_PARTITION_JOB,
  MEDIA_CHECKS_JOB,
  MEDIA_STUCK_SWEEP_JOB,
  MEDIA_UPLOAD_REAP_JOB,
  ORPHAN_SWEEP_JOB,
  RETENTION_SWEEP_JOB,
  SHARED_QUEUE_POLICY,
} from "@civfix/api/queue-names"
import { releaseAnonHoldIfReady, type HeldReportView } from "@civfix/api/anon-hold-release"
import {
  buildJobs,
  stopGraceMsFor,
  type JobsHandle,
  type QueueOptions,
  type WorkerJobs,
} from "./jobs.js"
import { buildSeams, type WorkerSeams } from "./seams.js"
import {
  CHAT_PARTITION_CRON,
  HOLD_RELEASE_SWEEP_CRON,
  MEDIA_STUCK_SWEEP_CRON,
  ORPHAN_SWEEP_CRON,
  RETENTION_SWEEP_CRON,
  type WorkerLimits,
} from "./config.js"
import {
  runMediaChecksJobDetailed,
  parsePayload,
  type MediaChecksOutcome,
  type MediaChecksPayload,
} from "./jobs/media-checks.js"
import { runOrphanSweep } from "./jobs/orphan-sweep.js"
import { runHoldReleaseSweep } from "./jobs/hold-release-sweep.js"
import { runPartitionMaintenance } from "./jobs/partition-maintenance.js"
import { runRetentionSweep } from "./jobs/retention-sweep.js"
import { runStuckSweep } from "./jobs/stuck-sweep.js"
import { parseUploadReapPayload, runUploadReapJob, uploadReapDelaySec } from "./jobs/upload-reap.js"
import { sweepStaleScratchDirs } from "./sandbox/tmp.js"
import { assertSandboxPreflight } from "./sandbox/preflight.js"
import { killAllSandboxChildren } from "./sandbox/exec.js"
import { MS_PER_SECOND } from "@civfix/api/time"

const CRON_EXPIRE_SECONDS = 25 * 60
const MEDIA_CHECKS_RETRY_LIMIT = 5
const UPLOAD_REAP_RETRY_LIMIT = 3
const COMPOSE_STOP_GRACE_HEADROOM_SEC = 15

const QUEUES: readonly [name: string, options: QueueOptions][] = [
  [
    MEDIA_CHECKS_JOB,
    { policy: SHARED_QUEUE_POLICY, retryLimit: MEDIA_CHECKS_RETRY_LIMIT, retryBackoff: true },
  ],
  [ORPHAN_SWEEP_JOB, { policy: "singleton" }],
  [CHAT_PARTITION_JOB, { policy: "singleton" }],
  [ANON_HOLD_RELEASE_JOB, { policy: SHARED_QUEUE_POLICY }],
  [ANON_HOLD_RELEASE_SWEEP_JOB, { policy: "singleton" }],
  [RETENTION_SWEEP_JOB, { policy: "singleton" }],
  [MEDIA_STUCK_SWEEP_JOB, { policy: "singleton" }],
  [
    MEDIA_UPLOAD_REAP_JOB,
    { policy: "short", retryLimit: UPLOAD_REAP_RETRY_LIMIT, retryBackoff: true },
  ],
]

const CRON_SCHEDULES: readonly [name: string, cron: string][] = [
  [ORPHAN_SWEEP_JOB, ORPHAN_SWEEP_CRON],
  [CHAT_PARTITION_JOB, CHAT_PARTITION_CRON],
  [ANON_HOLD_RELEASE_SWEEP_JOB, HOLD_RELEASE_SWEEP_CRON],
  [RETENTION_SWEEP_JOB, RETENTION_SWEEP_CRON],
  [MEDIA_STUCK_SWEEP_JOB, MEDIA_STUCK_SWEEP_CRON],
]

export interface Worker {
  jobs: WorkerJobs
  seams: WorkerSeams
  start(): Promise<void>
  stop(): Promise<void>
}

function isAnonHeldReport(report: HeldReportView | null): boolean {
  return report !== null && report.anonSessionId !== null && report.status === "held"
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
    const repo = seams.repo
    const outcome = await runMediaChecksJobDetailed(payload, {
      repo,
      storage: seams.storage,
      abuseChecks: seams.abuseChecks,
      limits: seams.limits,
      download: seams.download,
      ...(seams.findPhashDuplicate ? { findPhashDuplicate: seams.findPhashDuplicate } : {}),
      ...(seams.publicMediaBase ? { publicMediaBase: seams.publicMediaBase } : {}),
      report: seams.report,
    })

    if (outcome.status !== "missing") {
      await scheduleUploadReap(jobs, payload)
    }
    await enqueueHoldReleaseIfAnonHeld(jobs, seams, repo, payload, outcome)
  }
}

async function scheduleUploadReap(jobs: WorkerJobs, payload: MediaChecksPayload): Promise<void> {
  try {
    await jobs.enqueue(
      MEDIA_UPLOAD_REAP_JOB,
      { mediaId: payload.mediaId, uploadId: payload.uploadId, r2Key: payload.r2Key },
      { singletonKey: payload.uploadId, startAfter: uploadReapDelaySec() },
    )
  } catch (err) {
    console.warn("media.checks: failed to schedule media.upload.reap (non-fatal)", {
      uploadId: payload.uploadId,
      err: String(err),
    })
  }
}

async function enqueueHoldReleaseIfAnonHeld(
  jobs: WorkerJobs,
  seams: WorkerSeams,
  repo: NonNullable<WorkerSeams["repo"]>,
  payload: MediaChecksPayload,
  outcome: MediaChecksOutcome,
): Promise<void> {
  try {
    const reportId =
      outcome.reportId ?? (outcome.status === "missing" ? null : await findReportId(repo, payload))
    if (reportId && (await shouldEnqueueHoldRelease(seams, reportId))) {
      await jobs.enqueue(ANON_HOLD_RELEASE_JOB, { reportId }, { singletonKey: reportId })
    } else {
      console.debug("media.checks: hold-release skipped (no row/reportId, or not anon-held)", {
        uploadId: payload.uploadId,
        status: outcome.status,
      })
    }
  } catch (err) {
    console.warn("media.checks: failed to enqueue anon.hold.release (non-fatal)", {
      uploadId: payload.uploadId,
      err: String(err),
    })
  }
}

async function findReportId(
  repo: NonNullable<WorkerSeams["repo"]>,
  payload: { mediaId: string; uploadId: string },
): Promise<string | null> {
  const asset =
    (await repo.findById(payload.mediaId)) ?? (await repo.findByUploadId(payload.uploadId))
  return asset?.reportId ?? null
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
    await sweepStaleScratchDirs().catch(() => 0)
    const repo = requireRepo(seams, ORPHAN_SWEEP_JOB, "repo")
    if (!repo) return
    await runOrphanSweep({
      repo,
      storage: seams.storage,
      limits: seams.limits,
      report: seams.report,
    })
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
    await runRetentionSweep({
      sql: dbHandle.sql,
      storage: seams.inboundStorage,
      batchSize: seams.limits.retentionSweepBatch,
      maxPages: seams.limits.retentionSweepMaxPages,
      report: seams.report,
    })
  }
}

function makeUploadReapHandler(seams: WorkerSeams): JobHandler {
  return async (job) => {
    const payload = parseUploadReapPayload(job.data)
    if (!payload) {
      console.warn("media.upload.reap: malformed payload, skipping", { id: job.id })
      return
    }
    const repo = requireRepo(seams, MEDIA_UPLOAD_REAP_JOB, "repo")
    if (!repo) return
    await runUploadReapJob(payload, { repo, storage: seams.storage, report: seams.report })
  }
}

function makeStuckSweepHandler(jobs: WorkerJobs, seams: WorkerSeams): JobHandler {
  return async () => {
    const repo = requireRepo(seams, MEDIA_STUCK_SWEEP_JOB, "repo")
    if (!repo) return
    await runStuckSweep({
      repo,
      jobs,
      storage: seams.storage,
      limits: seams.limits,
      report: seams.report,
    })
  }
}

async function registerHandlers(
  jobs: WorkerJobs,
  seams: WorkerSeams,
  limits: WorkerLimits,
): Promise<void> {
  for (const [name, options] of QUEUES) {
    await jobs.createQueue(name, options)
  }

  await jobs.workWithSettings(MEDIA_CHECKS_JOB, makeMediaChecksHandler(jobs, seams), {
    batchSize: limits.mediaChecksConcurrency,
  })

  await jobs.work(ANON_HOLD_RELEASE_JOB, makeAnonHoldReleaseHandler(seams))

  await jobs.work(ORPHAN_SWEEP_JOB, makeOrphanSweepHandler(seams))
  await jobs.work(CHAT_PARTITION_JOB, makePartitionHandler(seams))
  await jobs.work(ANON_HOLD_RELEASE_SWEEP_JOB, makeHoldReleaseSweepHandler(seams))
  await jobs.work(RETENTION_SWEEP_JOB, makeRetentionSweepHandler(seams))
  await jobs.work(MEDIA_STUCK_SWEEP_JOB, makeStuckSweepHandler(jobs, seams))
  await jobs.work(MEDIA_UPLOAD_REAP_JOB, makeUploadReapHandler(seams))

  for (const [name, cron] of CRON_SCHEDULES) {
    await jobs.schedule(name, cron, undefined, cronSchedule(name))
  }
}

function cronSchedule(name: string): { expireInSeconds: number; singletonKey: string } {
  return { expireInSeconds: CRON_EXPIRE_SECONDS, singletonKey: name }
}

function logStopGraceRequirement(limits: WorkerLimits): void {
  const graceMs = stopGraceMsFor(limits.jobTimeoutMs)
  console.log("media-worker: graceful-stop budget", {
    jobTimeoutMs: limits.jobTimeoutMs,
    stopGraceMs: graceMs,
    requiredComposeStopGracePeriodSec:
      Math.ceil(graceMs / MS_PER_SECOND) + COMPOSE_STOP_GRACE_HEADROOM_SEC,
  })
}

async function runBootPartitionMaintenance(seams: WorkerSeams): Promise<void> {
  if (!seams.dbHandle) return
  try {
    await runPartitionMaintenance({ sql: seams.dbHandle.sql, report: seams.report })
  } catch (err) {
    seams.report(err, { job: CHAT_PARTITION_JOB, phase: "boot" })
    console.error("media-worker: boot partition maintenance failed (daily cron will retry)", {
      err: String(err),
    })
  }
}

export async function buildWorker(
  handle: JobsHandle = buildJobs(),
  seams?: WorkerSeams,
): Promise<Worker> {
  const resolvedSeams = seams ?? (await buildSeams())
  let started = false

  async function start(): Promise<void> {
    if (started) return
    installSandboxChildCleanup()
    await assertSandboxPreflight()
    await sweepStaleScratchDirs().catch(() => 0)
    await handle.start()
    await registerHandlers(handle.jobs, resolvedSeams, resolvedSeams.limits)
    logStopGraceRequirement(resolvedSeams.limits)
    await runBootPartitionMaintenance(resolvedSeams)
    started = true
  }

  async function stop(): Promise<void> {
    await handle.stop()
    await resolvedSeams.close()
    started = false
  }

  return { jobs: handle.jobs, seams: resolvedSeams, start, stop }
}

let sandboxCleanupInstalled = false

function installSandboxChildCleanup(): void {
  if (sandboxCleanupInstalled) return
  sandboxCleanupInstalled = true
  process.once("exit", () => killAllSandboxChildren())
}

let shuttingDown = false

export function makeShutdown(
  worker: Worker,
  opts: { exitCode?: number } = {},
): (reason: string) => Promise<void> {
  const cleanExitCode = opts.exitCode ?? 0
  return async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`media-worker: ${reason} received, stopping`)
    try {
      await worker.stop()
      process.exit(cleanExitCode)
    } catch (err) {
      console.error("media-worker: error during shutdown", err)
      process.exit(1)
    }
  }
}

export async function start(): Promise<Worker> {
  const worker = await buildWorker()
  await worker.start()
  console.log("civfix media-worker started")

  const shutdown = makeShutdown(worker)

  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))

  return worker
}
