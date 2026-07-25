
import type { MediaKind, MediaStatus } from "@civfix/shared"
import type { AbuseChecks, Storage } from "@civfix/shared/interfaces"
import type {
  MediaResultPatch,
  MediaWorkerAsset,
  MediaWorkerRepo,
} from "@civfix/api/media-repo"
import type { FindPhashDuplicateFn } from "@civfix/api/adapters/abuse-checks"
import type { WorkerLimits } from "../config.js"
import { DownloadTooLargeError, type DownloadFn } from "../download.js"
import { settleWithin } from "../timeout.js"
import { resolveJobObs, type JobObsDeps, type JobLogFn, type JobReportFn } from "./obs.js"
import { thumbnailKey } from "./media-keys.js"
import {
  processMedia,
  errNote,
  type MediaProcessResult,
} from "./media-pipeline.js"

export * from "./media-pipeline.js"

/** Re-exported so callers keep one import site for the job's deps (the type is owned by download.ts). */
export type { DownloadFn }

export class JobTimeoutError extends Error {
  constructor(ms: number) {
    super(`media.checks exceeded the per-job wall-clock budget of ${ms}ms`)
    this.name = "JobTimeoutError"
    Object.setPrototypeOf(this, JobTimeoutError.prototype)
  }
}

export class MediaInfraError extends Error {
  constructor(phase: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`media.checks infra failure (${phase}, retryable): ${detail}`)
    this.name = "MediaInfraError"
    Object.setPrototypeOf(this, MediaInfraError.prototype)
  }
}

/**
 * Bound a phase of the job by the wall-clock budget. `onTimeout` is where the phase's cancellation goes
 * (the rejection alone does not stop the work). The timer is unref'd so a pending budget never keeps the
 * process alive by itself.
 */
export function withJobTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return settleWithin(p, ms, {
    timeoutError: () => new JobTimeoutError(ms),
    ...(onTimeout ? { onElapsed: onTimeout } : {}),
    unref: true,
  })
}

export interface MediaChecksDeps extends JobObsDeps {
  repo: MediaWorkerRepo
  storage: Storage
  abuseChecks: AbuseChecks
  limits: WorkerLimits
  download: DownloadFn
  findPhashDuplicate?: FindPhashDuplicateFn
}

export interface MediaChecksPayload {
  mediaId: string
  uploadId: string
  r2Key: string
  kind: MediaKind
}

export function parsePayload(data: unknown): MediaChecksPayload | null {
  if (typeof data !== "object" || data === null) return null
  const d = data as Record<string, unknown>
  if (
    typeof d.mediaId === "string" &&
    typeof d.uploadId === "string" &&
    typeof d.r2Key === "string" &&
    (d.kind === "image" || d.kind === "video")
  ) {
    return { mediaId: d.mediaId, uploadId: d.uploadId, r2Key: d.r2Key, kind: d.kind }
  }
  return null
}

/**
 * What the job did. `status` is "missing" when the row was already swept — NOTHING was processed or
 * persisted in that case, which the plain MediaStatus return cannot express (see runMediaChecksJob).
 * `reportId` is the asset's binding AS LOADED at the start of the job (null for a row that is still
 * unattached), so a caller does not have to re-read the row it just processed.
 */
export interface MediaChecksOutcome {
  status: MediaStatus | "missing"
  reportId: string | null
}

/**
 * Run the job and report what happened. Prefer this over runMediaChecksJob in the worker: it distinguishes
 * "row absent" from "row rejected" and hands back the report binding the job already loaded.
 */
export async function runMediaChecksJobDetailed(
  payload: MediaChecksPayload,
  deps: MediaChecksDeps,
): Promise<MediaChecksOutcome> {
  const { log, report } = resolveJobObs(deps)

  let asset: MediaWorkerAsset | null = null
  try {
    asset = await deps.repo.findById(payload.mediaId)
    if (!asset) asset = await deps.repo.findByUploadId(payload.uploadId)
  } catch (err) {
    report(err, { job: "media.checks", phase: "load-infra", uploadId: payload.uploadId })
    log("media.checks: failed to load asset, will retry", {
      uploadId: payload.uploadId,
      err: String(err),
    })
    throw new MediaInfraError("load", err)
  }
  if (!asset) {
    log("media.checks: asset not found (already swept?)", { uploadId: payload.uploadId })
    return { status: "missing", reportId: null }
  }
  const reportId = asset.reportId ?? null
  return { status: await processAsset(asset, deps), reportId }
}

/**
 * Run the job, returning the persisted MediaStatus.
 *
 * CONTRACT WART: a row that no longer exists also returns "rejected", although nothing was rejected or
 * persisted — callers reading this value cannot tell "row rejected" from "row gone". Kept for the existing
 * call sites; use runMediaChecksJobDetailed when the difference matters.
 */
export async function runMediaChecksJob(
  payload: MediaChecksPayload,
  deps: MediaChecksDeps,
): Promise<MediaStatus> {
  const outcome = await runMediaChecksJobDetailed(payload, deps)
  return outcome.status === "missing" ? "rejected" : outcome.status
}

async function processAsset(asset: MediaWorkerAsset, deps: MediaChecksDeps): Promise<MediaStatus> {
  const { log, report } = resolveJobObs(deps)

  let bytes: Uint8Array
  const downloadAbort = new AbortController()
  try {
    bytes = await withJobTimeout(
      deps.download(asset.r2Key, deps.limits.maxDownloadBytes, downloadAbort.signal),
      deps.limits.jobTimeoutMs,
      () => downloadAbort.abort(),
    )
  } catch (err) {
    if (err instanceof DownloadTooLargeError) {
      await persistRejection(asset, deps, errNote("download too large", err))
      return "rejected"
    }
    report(err, { job: "media.checks", phase: "download-infra", mediaId: asset.id })
    log("media.checks: download infra failure, will retry", {
      mediaId: asset.id,
      r2Key: asset.r2Key,
      err: String(err),
    })
    throw new MediaInfraError("download", err)
  }

  let result: MediaProcessResult
  try {
    result = await withJobTimeout(
      processMedia(
        { bytes, kind: asset.kind, selfAssetId: asset.id, selfReportId: asset.reportId },
        {
          abuseChecks: deps.abuseChecks,
          limits: deps.limits,
          ...(deps.findPhashDuplicate ? { findPhashDuplicate: deps.findPhashDuplicate } : {}),
        },
      ),
      deps.limits.jobTimeoutMs,
    )
  } catch (err) {
    if (err instanceof JobTimeoutError) {
      report(err, { job: "media.checks", phase: "timeout", mediaId: asset.id })
    }
    await persistRejection(asset, deps, errNote("process failed", err))
    return "rejected"
  }

  const patch: MediaResultPatch = {
    status: result.status,
    codec: result.codec,
    width: result.width,
    height: result.height,
    phash: result.phash,
  }

  try {
    if (result.status !== "rejected" && result.processedBytes) {
      const tKey = result.thumbnailBytes ? thumbnailKey(asset.r2Key) : null
      // RETRY SEMANTICS: this overwrites r2_key IN PLACE, before applyResult. If the persist below then
      // fails and pg-boss retries the job, the retry downloads the ALREADY-STRIPPED re-encode: the outcome
      // is still safe/idempotent, but the original EXIF is gone (so the exifGps signal for the report
      // cross-check is lost on the retry) and a JPEG is re-encoded a second time at q90 (generation loss).
      // The order is deliberate anyway: writing the DB status first would publish `ready` while the bytes
      // clients fetch are still the un-stripped original.
      await Promise.all([
        deps.storage.put(asset.r2Key, result.processedBytes, {
          ...(result.processedContentType !== null
            ? { contentType: result.processedContentType }
            : {}),
        }),
        tKey && result.thumbnailBytes
          ? deps.storage.put(tKey, result.thumbnailBytes, {
              ...(result.thumbnailContentType !== null
                ? { contentType: result.thumbnailContentType }
                : {}),
            })
          : Promise.resolve(),
      ])
      patch.byteSize = result.processedBytes.byteLength
      if (tKey) patch.thumbKey = tKey
    }

    // ABUSE FLAGS FIRST, THEN THE STATUS. The anon hold-release gate (inline hook AND the 5-minute sweep)
    // decides whether to publish a held anon report from media status + countOpenAbuseFlags. Writing the
    // terminal status before the flags leaves a window where the gate sees "all media ready, zero flags"
    // and publishes a report whose media was supposed to carry a review flag. Flag first and the gate can
    // only ever be early, never wrong.
    //
    // A flag insert that FAILS is therefore infra, not a warning to swallow: the throw propagates to the
    // catch below and pg-boss retries the (idempotent) job, leaving the row non-terminal in the meantime so
    // nothing publishes on a missing flag. A retry re-raising the SAME flag is absorbed by the database:
    // drizzle/0056_abuse_flags_worker_open_unique.sql makes (subject_type, subject_id, reason) unique among
    // OPEN worker-raised flags and insertAbuseFlag (services/api/src/services/media-worker-repo.ts) inserts
    // ON CONFLICT DO NOTHING against exactly that partial index — so the moderator sees one row, not N.
    // The index is scoped to source='worker' on purpose; the unguarded admin/'api' lanes still insert freely.
    for (const flag of result.flags) {
      await deps.repo.insertAbuseFlag({ subjectId: asset.id, reason: flag.reason })
    }

    await deps.repo.applyResult(asset.id, patch)
  } catch (err) {
    report(err, { job: "media.checks", phase: "persist", mediaId: asset.id })
    log("media.checks: persist infra failure, will retry", { mediaId: asset.id, err: String(err) })
    throw new MediaInfraError("persist", err)
  }

  if (result.status === "rejected") {
    logRejection(asset, log, report, result.note)
  } else if (result.status === "held") {
    log("media.checks: held", {
      mediaId: asset.id,
      note: result.note,
      flags: result.flags.map((f) => f.reason),
    })
    if (asset.reportId && deps.repo.enqueueHeldModerationItem) {
      // CONTRACT LIMIT (not a bug to "fix" here): `kind` is a ModerationKind, whose members are
      // image | pattern | appeal | gps | duplicate | user_report - there is NO "video". A held VIDEO
      // therefore also enqueues as kind:"image" (and 0007_admin_phase2.sql's CHECK would reject anything
      // else outright). The asset's real kind is carried in the reason string so the operator console is
      // not actively misleading; widening ModerationKind is a @civfix/shared change, not a worker one.
      await deps.repo
        .enqueueHeldModerationItem({
          reportId: asset.reportId,
          reason: `NSFW model over threshold (${asset.kind})`,
          kind: "image",
          note: result.note ?? null,
        })
        .catch((err: unknown) =>
          log("media.checks: moderation enqueue failed (non-fatal)", { err: String(err) }),
        )
    }
  } else {
    log("media.checks: ready", {
      mediaId: asset.id,
      kind: asset.kind,
      width: result.width,
      height: result.height,
      codec: result.codec,
      ...(result.exifGps ? { exifGps: result.exifGps } : {}),
    })
  }
  return result.status
}

function logRejection(
  asset: MediaWorkerAsset,
  log: JobLogFn,
  report: JobReportFn,
  note: string | null,
): void {
  log("media.checks: rejected", { mediaId: asset.id, kind: asset.kind, note })
  report(new Error(note ?? "media rejected"), {
    job: "media.checks",
    mediaId: asset.id,
    kind: asset.kind,
    note,
  })
}

/**
 * Persist the terminal 'rejected' status for bad input.
 *
 * The WRITE is the point of this function, so a failed write must NOT be swallowed: the job would then
 * complete successfully, pg-boss would never retry, and the row would sit at 'validating' forever — no
 * sweep reconciles an ATTACHED asset (orphan sweep only reaps rows bound to nothing), so the report's
 * media, and any anon hold-release gate waiting on it, wedges permanently. Rethrow as MediaInfraError
 * instead: the job is idempotent, so the retry re-derives the same rejection.
 */
export async function persistRejection(
  asset: MediaWorkerAsset,
  deps: MediaChecksDeps,
  note: string,
): Promise<void> {
  const { log, report } = resolveJobObs(deps)
  try {
    await deps.repo.applyResult(asset.id, { status: "rejected" })
  } catch (err) {
    report(err, { job: "media.checks", phase: "reject", mediaId: asset.id })
    log("media.checks: failed to persist rejection, will retry", {
      mediaId: asset.id,
      note,
      err: String(err),
    })
    throw new MediaInfraError("reject", err)
  }
  logRejection(asset, log, report, note)
}
