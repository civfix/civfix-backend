/**
 * civfix media worker.
 *
 * Wires the Jobs seam (pg-boss, or FakeJobs offline) to the sandboxed media pipeline and the two
 * maintenance crons, then exposes a start/stop lifecycle with graceful shutdown.
 *
 * Registered work + schedules:
 *   work("media.checks", ...)                 the untrusted-byte pipeline (concurrency-capped).
 *   schedule("orphan.sweep", cron)            reap never-attached media (section 11).
 *   schedule("chat.partition.maintenance")    create next month's chat partition (section 7/12).
 *
 * The media.checks handler NEVER throws (see media-checks.ts), so a crafted upload can never crash the
 * worker or poison the queue: it records a terminal media_assets status + abuse_flag/log/GlitchTip and
 * the job completes. Concurrency on media.checks is capped (default 2) so CPU/memory stay bounded; the
 * container additionally caps CPU per the infra compose. Per-job wall-clock and per-tool timeouts are
 * enforced inside the sandbox wrappers (see config.ts).
 *
 * Seam selection mirrors the API's USE_FAKE_* flags, so the worker boots fully offline with fakes.
 */

import type { JobHandler } from "@civfix/shared/interfaces"
import { MEDIA_CHECKS_JOB } from "@civfix/api/media-repo"
import { buildJobs, type JobsHandle, type WorkerJobs } from "./jobs.js"
import { buildSeams, type WorkerSeams } from "./seams.js"
import { CHAT_PARTITION_CRON, ORPHAN_SWEEP_CRON, type WorkerLimits } from "./config.js"
import { runMediaChecksJob, parsePayload } from "./jobs/media-checks.js"
import { runOrphanSweep } from "./jobs/orphan-sweep.js"
import { runPartitionMaintenance } from "./jobs/partition-maintenance.js"

/** Queue/cron names. media.checks MUST equal the name the API enqueues (MEDIA_CHECKS_JOB). */
export const ORPHAN_SWEEP_JOB = "orphan.sweep"
export const CHAT_PARTITION_JOB = "chat.partition.maintenance"

export interface Worker {
  jobs: WorkerJobs
  seams: WorkerSeams
  start(): Promise<void>
  stop(): Promise<void>
}

/**
 * Build the media.checks JobHandler bound to the given seams. Requires a repo (a real DB): without one
 * there is nowhere to persist results, so the handler logs and no-ops (this only happens in all-fake
 * offline boot, where nothing enqueues real media anyway).
 */
function makeMediaChecksHandler(seams: WorkerSeams): JobHandler {
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
      report: seams.report,
    })
  }
}

/** Build the orphan.sweep JobHandler. */
function makeOrphanSweepHandler(seams: WorkerSeams): JobHandler {
  return async () => {
    if (!seams.repo) {
      console.warn("orphan.sweep: no DB repo configured (offline mode); skipping")
      return
    }
    await runOrphanSweep({
      repo: seams.repo,
      storage: seams.storage,
      limits: seams.limits,
      report: seams.report,
    })
  }
}

/** Build the chat.partition.maintenance JobHandler. */
function makePartitionHandler(seams: WorkerSeams): JobHandler {
  return async () => {
    if (!seams.dbHandle) {
      console.warn("chat.partition.maintenance: no DB configured (offline mode); skipping")
      return
    }
    await runPartitionMaintenance({ sql: seams.dbHandle.sql, report: seams.report })
  }
}

/**
 * Register all queues, work handlers, and cron schedules. EXTENSION POINT for later steps: add more
 * work()/schedule() lines here.
 */
async function registerHandlers(
  jobs: WorkerJobs,
  seams: WorkerSeams,
  limits: WorkerLimits,
): Promise<void> {
  // Ensure queues exist before work/schedule (pg-boss v10 requirement; no-op on the fake).
  await jobs.createQueue(MEDIA_CHECKS_JOB)
  await jobs.createQueue(ORPHAN_SWEEP_JOB)
  await jobs.createQueue(CHAT_PARTITION_JOB)

  // media.checks: concurrency-capped untrusted-byte pipeline.
  await jobs.workWithSettings(MEDIA_CHECKS_JOB, makeMediaChecksHandler(seams), {
    batchSize: limits.mediaChecksConcurrency,
  })

  // Maintenance crons.
  await jobs.work(ORPHAN_SWEEP_JOB, makeOrphanSweepHandler(seams))
  await jobs.work(CHAT_PARTITION_JOB, makePartitionHandler(seams))
  await jobs.schedule(ORPHAN_SWEEP_JOB, ORPHAN_SWEEP_CRON)
  await jobs.schedule(CHAT_PARTITION_JOB, CHAT_PARTITION_CRON)
}

/** Build the worker over freshly-wired seams + a Jobs handle (defaults selected by env flags). */
export async function buildWorker(
  handle: JobsHandle = buildJobs(),
  seams?: WorkerSeams,
): Promise<Worker> {
  const resolvedSeams = seams ?? (await buildSeams())
  let started = false

  async function start(): Promise<void> {
    if (started) return
    await handle.start()
    await registerHandlers(handle.jobs, resolvedSeams, resolvedSeams.limits)
    started = true
  }

  async function stop(): Promise<void> {
    // Stop the queue first (drain in-flight), then tear down seams (DB pool, telemetry flush).
    await handle.stop()
    await resolvedSeams.close()
    started = false
  }

  return { jobs: handle.jobs, seams: resolvedSeams, start, stop }
}

let shuttingDown = false

/** Start the worker and install SIGTERM/SIGINT graceful shutdown. */
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
