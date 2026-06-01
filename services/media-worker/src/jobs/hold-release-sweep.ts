/**
 * anon.hold.release.sweep cron: self-healing backstop for the hold-then-publish release (P2-8).
 *
 * WHY THIS EXISTS. The normal release path is the media.checks post-success HOOK: after a media asset
 * reaches a terminal status, the worker enqueues anon.hold.release for the media's report, and that job
 * re-evaluates + publishes the held anon report once all its media are ready + clean. That inline enqueue
 * is best-effort: if SIGTERM lands such that pg-boss begins stopping while a handler sits between
 * "persisted the media result" and "enqueued anon.hold.release", the enqueue can fail (boss stopping) and
 * is swallowed (the media job still completes). For a single-media anon report there is then no other
 * media event to ever re-trigger the release, so the report could stay HELD forever.
 *
 * THE GUARANTEE this sweep provides: a held anon report whose media are all ready + clean is ALWAYS
 * eventually published, independent of whether any single inline enqueue was delivered. Every few minutes
 * (HOLD_RELEASE_SWEEP_CRON) the sweep lists held anon reports (reporter_user_id IS NULL, status 'held',
 * not deleted, bounded batch oldest-first) and runs the SAME idempotent release gate
 * (releaseAnonHoldIfReady) for each. A report that is not yet releasable (media pending, flagged, gps)
 * simply stays held and is re-checked next run; a releasable one is published. Because the gate is
 * idempotent (a no-longer-held report is a no-op) and the publish flip is a single guarded transaction,
 * the sweep racing the inline hook is harmless: whichever runs first publishes, the other no-ops.
 *
 * NEVER throws: a per-report gate error is counted + logged + reported, and the sweep continues. A bounded
 * batch per run drains a backlog over several runs without one giant pass.
 */

import type { AbuseChecks } from "@civfix/shared/interfaces"
import {
  releaseAnonHoldIfReady,
  type AnonHoldReleaseRepo,
} from "@civfix/api/anon-hold-release"

export interface HoldReleaseSweepDeps {
  repo: AnonHoldReleaseRepo
  abuseChecks: AbuseChecks
  /** Max held anon reports to re-check this run. */
  batchSize: number
  now?: () => Date
  log?: (line: string, extra?: Record<string, unknown>) => void
  report?: (err: unknown, context?: Record<string, unknown>) => void
}

export interface HoldReleaseSweepResult {
  scanned: number
  published: number
  errors: number
}

/**
 * Run one hold-release sweep. Returns counts. Never throws; per-report failures are counted + logged +
 * reported. Idempotent end-to-end (the underlying release gate is a no-op on a no-longer-held report).
 */
export async function runHoldReleaseSweep(
  deps: HoldReleaseSweepDeps,
): Promise<HoldReleaseSweepResult> {
  const log = deps.log ?? ((l: string, e?: Record<string, unknown>) => console.log(l, e ?? {}))
  const report = deps.report ?? (() => {})

  let ids: string[]
  try {
    ids = await deps.repo.findHeldAnonReportIds(deps.batchSize)
  } catch (err) {
    report(err, { job: "anon.hold.release.sweep", phase: "find" })
    log("anon.hold.release.sweep: find failed", { err: String(err) })
    return { scanned: 0, published: 0, errors: 1 }
  }

  let published = 0
  let errors = 0
  for (const reportId of ids) {
    try {
      const result = await releaseAnonHoldIfReady(reportId, {
        repo: deps.repo,
        abuseChecks: deps.abuseChecks,
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.log ? { log: deps.log } : {}),
      })
      if (result.published) published++
    } catch (err) {
      errors++
      report(err, { job: "anon.hold.release.sweep", phase: "release", reportId })
      log("anon.hold.release.sweep: report failed", { reportId, err: String(err) })
    }
  }

  log("anon.hold.release.sweep: done", { scanned: ids.length, published, errors })
  return { scanned: ids.length, published, errors }
}
