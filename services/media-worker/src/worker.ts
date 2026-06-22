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
 *   schedule("anon.hold.release.sweep", cron) reconcile held anon reports (P2-8 self-healing backstop).
 *   schedule("retention.sweep", cron)         delete expired OTP/anon-token/session rows (privacy §7.1).
 *
 * The media.checks handler NEVER throws on UNTRUSTED INPUT (see media-checks.ts), so a crafted upload can
 * never crash the worker or poison the queue: it records a terminal media_assets status + abuse_flag/log/
 * GlitchTip and the job completes. It MAY throw on an INFRA failure (storage/DB) - that throw PROPAGATES
 * out of the handler so pg-boss fails + RETRIES the job (bounded retryLimit/retryBackoff set on the
 * media.checks queue in registerHandlers), recovering the media once infra is healthy instead of
 * silently rejecting it. Concurrency on media.checks is capped (default 2) so CPU/memory stay bounded; the
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
  RETENTION_SWEEP_CRON,
  type WorkerLimits,
} from "./config.js"
import { runMediaChecksJob, parsePayload } from "./jobs/media-checks.js"
import { runOrphanSweep } from "./jobs/orphan-sweep.js"
import { runHoldReleaseSweep } from "./jobs/hold-release-sweep.js"
import { runPartitionMaintenance } from "./jobs/partition-maintenance.js"
import { runRetentionSweep } from "./jobs/retention-sweep.js"
import { sweepStaleScratchDirs } from "./sandbox/tmp.js"

/** Queue/cron names. media.checks MUST equal the name the API enqueues (MEDIA_CHECKS_JOB). */
export const ORPHAN_SWEEP_JOB = "orphan.sweep"
export const CHAT_PARTITION_JOB = "chat.partition.maintenance"
/** Hold-release queue: enqueued by the media.checks post-success hook for an anon report's media. */
export const ANON_HOLD_RELEASE_JOB = "anon.hold.release"
/** Self-healing hold-release sweep cron (P2-8): reconciles held anon reports if an inline enqueue was lost. */
export const ANON_HOLD_RELEASE_SWEEP_JOB = "anon.hold.release.sweep"
/** Privacy retention sweep cron (§7.1): deletes expired OTP/anon-token/session rows. */
export const RETENTION_SWEEP_JOB = "retention.sweep"

/**
 * expireInSeconds for the maintenance crons: above each one's worst-case runtime so a long run is not
 * re-delivered concurrently at pg-boss v10's 900s default (two sweeps racing the same rows). Set on the
 * SCHEDULE (not createQueue) so the maintenance queues keep their default policy. A singletonKey on each
 * adds belt-and-suspenders single-flight per cron.
 */
const CRON_EXPIRE_SECONDS = 25 * 60

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
 *
 * INFRA-RETRY: runMediaChecksJob may THROW on an infra failure (storage/DB) to signal a pg-boss retry.
 * We deliberately do NOT catch that throw - it must PROPAGATE out of the handler so pg-boss fails +
 * retries the job. Because it short-circuits the await, the hold-release hook below runs ONLY after a
 * non-throwing (terminal) completion, so we never release/re-check a report whose media is still
 * pending a retry.
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
    // An infra throw here is NOT caught: it propagates out of the handler so pg-boss retries the job, and
    // (by short-circuiting) skips the hold-release hook below.
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

    // Hold-release hook (reached ONLY on a terminal, non-throwing completion above): find the media's
    // report and, when it is an anon held report, enqueue a release re-check. Best-effort; failures here
    // must not fail the (already-complete) media job.
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
      } else {
        // No row or no reportId: the 5-min hold-release sweep is the backstop, but a debug log makes the
        // skip diagnosable rather than silent.
        console.debug("media.checks: hold-release skipped (no row/reportId)", {
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

/**
 * Offline guard shared by the DB-backed handlers: return seams[key] when present, else log + return
 * undefined so the handler no-ops (all-fake offline boot configures no DB and nothing enqueues real work).
 * Collapses the repeated `if (!seams.X) { warn; return }` boilerplate across the maintenance handlers.
 */
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

/** Build the orphan.sweep JobHandler. */
function makeOrphanSweepHandler(seams: WorkerSeams): JobHandler {
  return async () => {
    const repo = requireRepo(seams, ORPHAN_SWEEP_JOB, "repo")
    if (!repo) return
    await runOrphanSweep({ repo, storage: seams.storage, limits: seams.limits, report: seams.report })
  }
}

/**
 * Build the anon.hold.release.sweep JobHandler (P2-8 self-healing backstop). Re-checks held anon reports
 * and publishes any that are now releasable, so a release whose inline enqueue was lost (e.g. a shutdown
 * race) is reconciled. Requires the anonHoldRepo (a real DB); no-ops in all-fake offline boot.
 */
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

/** Build the chat.partition.maintenance JobHandler. */
function makePartitionHandler(seams: WorkerSeams): JobHandler {
  return async () => {
    const dbHandle = requireRepo(seams, CHAT_PARTITION_JOB, "dbHandle")
    if (!dbHandle) return
    await runPartitionMaintenance({ sql: dbHandle.sql, report: seams.report })
  }
}

/** Build the retention.sweep JobHandler (privacy §7.1). Requires a real DB; no-ops in offline boot. */
function makeRetentionSweepHandler(seams: WorkerSeams): JobHandler {
  return async () => {
    const dbHandle = requireRepo(seams, RETENTION_SWEEP_JOB, "dbHandle")
    if (!dbHandle) return
    await runRetentionSweep({ sql: dbHandle.sql, report: seams.report })
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
  // media.checks gets a BOUNDED retry policy: its handler THROWS on an infra failure (storage/DB) to
  // signal a retry. pg-boss v10's default retryLimit is 2 (retries are OPT-OUT), but we set it explicitly
  // to 5 + exponential backoff so a transient outage retries a handful of times with widening gaps, then
  // gives up (the orphan/hold-release sweeps are the last-resort backstop). Bad-input rejections do NOT
  // throw, so they never consume a retry. policy "short" MUST match the API (which creates this same queue
  // with "short" so its enqueue's singletonKey dedups duplicate pending jobs); omitting it here would let
  // the worker's updateQueue rewrite the policy to "standard" on boot and silently break that dedup.
  await jobs.createQueue(MEDIA_CHECKS_JOB, { policy: "short", retryLimit: 5, retryBackoff: true })
  await jobs.createQueue(ORPHAN_SWEEP_JOB)
  await jobs.createQueue(CHAT_PARTITION_JOB)
  // anon.hold.release is enqueued with singletonKey = reportId (post-media hook below), so it needs
  // policy "short" for that dedup to actually fire (pg-boss's singletonKey index is "short"-only).
  await jobs.createQueue(ANON_HOLD_RELEASE_JOB, { policy: "short" })
  await jobs.createQueue(ANON_HOLD_RELEASE_SWEEP_JOB)
  await jobs.createQueue(RETENTION_SWEEP_JOB)

  // media.checks: concurrency-capped untrusted-byte pipeline. Its post-success hook enqueues
  // anon.hold.release, so it needs the jobs handle.
  await jobs.workWithSettings(MEDIA_CHECKS_JOB, makeMediaChecksHandler(jobs, seams), {
    batchSize: limits.mediaChecksConcurrency,
  })

  // anon.hold.release: re-evaluate + publish a held anon report once its media settle.
  await jobs.work(ANON_HOLD_RELEASE_JOB, makeAnonHoldReleaseHandler(seams))

  // Maintenance crons. Each schedule carries an explicit expireInSeconds (above its worst-case runtime so
  // a long run is not re-delivered concurrently at the 900s default) + a singletonKey for single-flight.
  await jobs.work(ORPHAN_SWEEP_JOB, makeOrphanSweepHandler(seams))
  await jobs.work(CHAT_PARTITION_JOB, makePartitionHandler(seams))
  // anon.hold.release.sweep (P2-8): self-healing backstop so a held anon report whose release enqueue was
  // lost (shutdown race) is still reconciled. Idempotent re-check; safe to race the inline hook.
  await jobs.work(ANON_HOLD_RELEASE_SWEEP_JOB, makeHoldReleaseSweepHandler(seams))
  // retention.sweep (privacy §7.1): delete consumed/expired email_otps, anon_tokens, sessions.
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

/** expireInSeconds + a per-cron singletonKey so a long run is not re-delivered concurrently (the cron
 * default would re-run at 900s) and two scheduled fires of the same cron never overlap. */
function cronSchedule(name: string): { expireInSeconds: number; singletonKey: string } {
  return { expireInSeconds: CRON_EXPIRE_SECONDS, singletonKey: name }
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
    // Boot-time backstop: reap scratch dirs leaked by a prior SIGKILL mid-pipeline (the per-job finally
    // cannot run on a hard kill). Best-effort; a failure here must not block startup.
    await sweepStaleScratchDirs().catch(() => 0)
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
