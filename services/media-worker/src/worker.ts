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
 * container additionally caps CPU per the infra compose. The per-tool timeouts are enforced inside the
 * sandbox wrappers, and the OVERALL per-job wall-clock budget (limits.jobTimeoutMs) is enforced by
 * runMediaChecksJob via withJobTimeout (see jobs/media-checks.ts), so a single job cannot run unbounded.
 *
 * Seam selection mirrors the API's USE_FAKE_* flags, so the worker boots fully offline with fakes.
 */

import type { JobHandler } from "@civfix/shared/interfaces"
import { MEDIA_CHECKS_JOB } from "@civfix/api/media-repo"
import { releaseAnonHoldIfReady } from "@civfix/api/anon-hold-release"
import { buildJobs, type JobsHandle, type WorkerJobs } from "./jobs.js"
import { buildSeams, type WorkerSeams } from "./seams.js"
import {
  CHAT_PARTITION_CRON,
  HOLD_RELEASE_SWEEP_CRON,
  ORPHAN_SWEEP_CRON,
  type WorkerLimits,
} from "./config.js"
import { runMediaChecksJob, parsePayload } from "./jobs/media-checks.js"
import { runOrphanSweep } from "./jobs/orphan-sweep.js"
import { runHoldReleaseSweep } from "./jobs/hold-release-sweep.js"
import { runPartitionMaintenance } from "./jobs/partition-maintenance.js"

/** Queue/cron names. media.checks MUST equal the name the API enqueues (MEDIA_CHECKS_JOB). */
export const ORPHAN_SWEEP_JOB = "orphan.sweep"
export const CHAT_PARTITION_JOB = "chat.partition.maintenance"
/** Hold-release queue: enqueued by the media.checks post-success hook for an anon report's media. */
export const ANON_HOLD_RELEASE_JOB = "anon.hold.release"
/** Self-healing hold-release sweep cron (P2-8): reconciles held anon reports if an inline enqueue was lost. */
export const ANON_HOLD_RELEASE_SWEEP_JOB = "anon.hold.release.sweep"

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
 *
 * POST-SUCCESS HOOK (hold-then-publish): after the job records its terminal media status, if that media
 * belongs to an anonymous HELD report, enqueue an anon.hold.release job for the report so the release
 * gate re-evaluates (and publishes when all media are ready + clean). We enqueue on EVERY terminal
 * status (not just ready): a rejected/held media must also trigger a re-check so the report can settle
 * (the gate keeps it held). Enqueue is best-effort + idempotent (singletonKey = reportId): a transient
 * queue error is logged, never thrown, so the media.checks job still completes.
 */
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
      // Self-aware dedupe lookup (excludes the processing asset's own row, P0-2). Undefined in all-fake
      // offline mode, where the pipeline falls back to AbuseChecks.isNearDuplicate.
      ...(seams.findPhashDuplicate ? { findPhashDuplicate: seams.findPhashDuplicate } : {}),
      report: seams.report,
    })

    // Hold-release hook: find the media's report and, when it is an anon held report, enqueue a
    // release re-check. Best-effort; failures here must not fail the (already-complete) media job.
    try {
      const asset =
        (await seams.repo.findById(payload.mediaId)) ??
        (await seams.repo.findByUploadId(payload.uploadId))
      if (asset?.reportId) {
        await jobs.enqueue(
          ANON_HOLD_RELEASE_JOB,
          { reportId: asset.reportId },
          { singletonKey: asset.reportId },
        )
      }
    } catch (err) {
      console.warn("media.checks: failed to enqueue anon.hold.release (non-fatal)", {
        uploadId: payload.uploadId,
        err: String(err),
      })
    }
  }
}

/** Coerce an unknown anon.hold.release payload into its reportId, or null when malformed. */
function parseHoldReleasePayload(data: unknown): { reportId: string } | null {
  if (typeof data !== "object" || data === null) return null
  const d = data as Record<string, unknown>
  return typeof d.reportId === "string" ? { reportId: d.reportId } : null
}

/**
 * Build the anon.hold.release JobHandler: runs the release gate for the report id. Requires the
 * anonHoldRepo (a real DB); no-ops in all-fake offline boot. The release function returns a structured
 * outcome and does not throw for the normal stay-held reasons; an unexpected error is logged + reported
 * but the job still completes.
 */
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

/**
 * Build the anon.hold.release.sweep JobHandler (P2-8 self-healing backstop). Re-checks held anon reports
 * and publishes any that are now releasable, so a release whose inline enqueue was lost (e.g. a shutdown
 * race) is reconciled. Requires the anonHoldRepo (a real DB); no-ops in all-fake offline boot.
 */
function makeHoldReleaseSweepHandler(seams: WorkerSeams): JobHandler {
  return async () => {
    if (!seams.anonHoldRepo) {
      console.warn("anon.hold.release.sweep: no DB repo configured (offline mode); skipping")
      return
    }
    await runHoldReleaseSweep({
      repo: seams.anonHoldRepo,
      abuseChecks: seams.abuseChecks,
      batchSize: seams.limits.holdReleaseSweepBatch,
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
  await jobs.createQueue(ANON_HOLD_RELEASE_JOB)
  await jobs.createQueue(ANON_HOLD_RELEASE_SWEEP_JOB)

  // media.checks: concurrency-capped untrusted-byte pipeline. Its post-success hook enqueues
  // anon.hold.release, so it needs the jobs handle.
  await jobs.workWithSettings(MEDIA_CHECKS_JOB, makeMediaChecksHandler(jobs, seams), {
    batchSize: limits.mediaChecksConcurrency,
  })

  // anon.hold.release: re-evaluate + publish a held anon report once its media settle.
  await jobs.work(ANON_HOLD_RELEASE_JOB, makeAnonHoldReleaseHandler(seams))

  // Maintenance crons.
  await jobs.work(ORPHAN_SWEEP_JOB, makeOrphanSweepHandler(seams))
  await jobs.work(CHAT_PARTITION_JOB, makePartitionHandler(seams))
  // anon.hold.release.sweep (P2-8): self-healing backstop so a held anon report whose release enqueue was
  // lost (shutdown race) is still reconciled. Idempotent re-check; safe to race the inline hook.
  await jobs.work(ANON_HOLD_RELEASE_SWEEP_JOB, makeHoldReleaseSweepHandler(seams))
  await jobs.schedule(ORPHAN_SWEEP_JOB, ORPHAN_SWEEP_CRON)
  await jobs.schedule(CHAT_PARTITION_JOB, CHAT_PARTITION_CRON)
  await jobs.schedule(ANON_HOLD_RELEASE_SWEEP_JOB, HOLD_RELEASE_SWEEP_CRON)
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
