/**
 * media.checks job orchestrator: loads the asset, downloads its source bytes under a hard cap, runs the
 * pure pipeline (media-pipeline.ts), then PERSISTS the stripped/remuxed object + thumbnail, applies the
 * result, raises abuse flags, and reports rejections.
 *
 * NEVER throws on UNTRUSTED INPUT: a crafted/bad asset always resolves after recording a terminal
 * "rejected"/"held" status, so attacker bytes can never crash the worker or poison the queue.
 *
 * MAY throw a MediaInfraError on an INFRA failure (can't FETCH the bytes, or a storage WRITE / DB persist
 * fails). That is a controlled retry signal, not a crash: the asset is LEFT non-terminal (validating) and
 * the throw makes pg-boss retry with backoff so the media recovers once infra is healthy - never silently
 * rejected. This reject-vs-retry split is what stops a mis-pointed worker (fake-storage-in-prod, the #39
 * root cause) from permanently rejecting real media.
 *
 * Status mapping: ready = clean (a perceptual near-duplicate is ALLOWED through, not held - see #43);
 * held = NSFW over threshold; rejected = any unsafe/invalid input.
 *
 * This file is the barrel for the pipeline core (re-exported below) so the worker + tests resolve both
 * the orchestrator and the pure functions from one import.
 */

import type { MediaKind, MediaStatus } from "@civfix/shared"
import type { AbuseChecks, Storage } from "@civfix/shared/interfaces"
import type {
  MediaResultPatch,
  MediaWorkerAsset,
  MediaWorkerRepo,
} from "@civfix/api/media-repo"
import type { FindPhashDuplicateFn } from "@civfix/api/adapters/abuse-checks"
import type { WorkerLimits } from "../config.js"
import { DownloadTooLargeError } from "../download.js"
import { thumbnailKey } from "./media-keys.js"
import {
  processMedia,
  errNote,
  type MediaProcessResult,
} from "./media-pipeline.js"

export * from "./media-pipeline.js"

/** Capped downloader: returns the source bytes for an r2Key, or throws if it exceeds maxBytes. */
export type DownloadFn = (r2Key: string, maxBytes: number) => Promise<Uint8Array>

/** Sentinel thrown when the overall per-job wall-clock budget (limits.jobTimeoutMs) is exceeded. */
export class JobTimeoutError extends Error {
  constructor(ms: number) {
    super(`media.checks exceeded the per-job wall-clock budget of ${ms}ms`)
    this.name = "JobTimeoutError"
    Object.setPrototypeOf(this, JobTimeoutError.prototype)
  }
}

/**
 * Typed error runMediaChecksJob THROWS on an INFRA failure so pg-boss fails + retries the job with
 * backoff. It deliberately does NOT persist "rejected": the media is left non-terminal (validating) so it
 * recovers once infra is healthy. This does NOT violate never-throw-on-untrusted-input (only attacker
 * BYTES are covered); an infra throw is a controlled retry signal - pg-boss isolates the failed job and
 * the queue is never poisoned.
 */
export class MediaInfraError extends Error {
  constructor(phase: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`media.checks infra failure (${phase}, retryable): ${detail}`)
    this.name = "MediaInfraError"
    Object.setPrototypeOf(this, MediaInfraError.prototype)
  }
}

/**
 * Race a promise against the per-job wall-clock budget (P2-1). The per-tool timeouts bound each step;
 * this bounds the SUM, so a crafted asset chaining many near-budget steps cannot exceed jobTimeoutMs. The
 * timer is unref'd + cleared so it never keeps the worker alive (child processes are independently
 * SIGKILL-bounded by their own per-tool timeouts, so this is a belt over those suspenders).
 */
export function withJobTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new JobTimeoutError(ms)), ms)
    if (typeof timer.unref === "function") timer.unref()
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

export interface MediaChecksDeps {
  repo: MediaWorkerRepo
  storage: Storage
  abuseChecks: AbuseChecks
  limits: WorkerLimits
  download: DownloadFn
  /**
   * Self-aware near-duplicate lookup over media_assets.phash (excludes the processing asset's own row,
   * P0-2). Optional: when omitted, processMedia falls back to abuseChecks.isNearDuplicate.
   */
  findPhashDuplicate?: FindPhashDuplicateFn
  /** Report an exceptional/rejection event to GlitchTip (no-op when reporting is disabled). */
  report?: (err: unknown, context?: Record<string, unknown>) => void
  /** Structured log sink (defaults to console). */
  log?: (line: string, extra?: Record<string, unknown>) => void
}

/** The job payload the API enqueues (see media-intake-service.MediaChecksJob). */
export interface MediaChecksPayload {
  mediaId: string
  uploadId: string
  r2Key: string
  kind: MediaKind
}

/** Coerce an unknown job payload into MediaChecksPayload, or null if it is malformed. */
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

type LogFn = (line: string, extra?: Record<string, unknown>) => void
type ReportFn = (err: unknown, context?: Record<string, unknown>) => void

const defaultLog: LogFn = (line, extra) => console.log(line, extra ?? {})

export async function runMediaChecksJob(
  payload: MediaChecksPayload,
  deps: MediaChecksDeps,
): Promise<MediaStatus> {
  const log = deps.log ?? defaultLog
  const report = deps.report ?? (() => {})

  // Locate the row. Prefer mediaId; fall back to uploadId (the singletonKey) if the id moved. A DB read
  // failure is INFRA (re-throw to retry rather than report a misleading terminal "rejected" for a row we
  // never loaded); a genuinely-missing row is the real terminal condition handled below.
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
    return "rejected"
  }

  // STEP 1 - download (size-capped AND wall-clock bounded). CLASSIFY the failure BEFORE the bytes reach
  // processMedia, because the two classes have opposite outcomes:
  //   DownloadTooLargeError -> BAD INPUT (over the byte cap) -> permanent "rejected".
  //   everything else       -> INFRA (object-not-found / HTTP / presign / network, or a wedged fetch past
  //                            the budget) -> re-throw MediaInfraError so pg-boss retries; leave the row
  //                            non-terminal (validating) so it recovers once storage is healthy (#39 fix).
  let bytes: Uint8Array
  try {
    bytes = await withJobTimeout(
      deps.download(asset.r2Key, deps.limits.maxDownloadBytes),
      deps.limits.jobTimeoutMs,
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

  // STEP 2 - process under the OVERALL per-job wall-clock budget (P2-1). processMedia never throws; a
  // wall-clock overrun (JobTimeoutError) is the only throw here, and a crafted asset that wedges
  // processing IS bad input -> a safe "rejected" terminal status (the job still completes).
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

  // PHASE-1 EXIF GPS DEFERRAL (privacy): processMedia reads result.exifGps from the ORIGINAL bytes purely
  // to STRIP it (the published image is metadata-free). We deliberately do NOT persist that raw fix:
  // storing a user's device coordinates - even to power the hold-release cross-check - would reintroduce
  // exactly the location data the strip removes. The submit-time IP-geo GPS sanity already runs for anon
  // submits, so the hold-release EXIF cross-check is a documented Phase-1 deferral (it reads null and
  // treats "no signal" as passing). A future phase's privacy-preserving shape is a single boolean column
  // (e.g. exif_gps_far) computed HERE, never the coordinates. We log the read so it is observable.
  const patch: MediaResultPatch = {
    status: result.status,
    codec: result.codec,
    width: result.width,
    height: result.height,
    phash: result.phash,
  }

  try {
    if (result.status !== "rejected" && result.processedBytes) {
      // OVERWRITE the source object IN PLACE with the processed bytes (EXIF/metadata-stripped,
      // web-normalized re-encode). This is the object every downstream reader serves, so clients always
      // receive the stripped/normalized copy, never the raw upload (which may carry EXIF/GPS or be a
      // browser-unrenderable format e.g. HEIC). R2 PUT is atomic per object and the key already exists, so
      // r2_key never references a missing object mid-flight. A re-delivered job re-downloads the
      // already-processed bytes and re-strips them (a harmless near-noop). The source + thumbnail PUTs are
      // independent, so they run in parallel.
      const tKey = result.thumbnailBytes ? thumbnailKey(asset.r2Key) : null
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

    await deps.repo.applyResult(asset.id, patch)

    // Raise any abuse flags. A flag-insert failure is logged AND reported (GlitchTip) - the row is already
    // terminal here, so a silently-dropped NSFW/abuse flag would be invisible; report() so it is auditable.
    for (const flag of result.flags) {
      try {
        await deps.repo.insertAbuseFlag({ subjectId: asset.id, reason: flag.reason })
      } catch (err) {
        report(err, {
          job: "media.checks",
          phase: "abuse-flag",
          mediaId: asset.id,
          reason: flag.reason,
        })
        log("media.checks: failed to insert abuse_flag", {
          mediaId: asset.id,
          reason: flag.reason,
          err: String(err),
        })
      }
    }
  } catch (err) {
    // Persist failed (storage PUT / DB applyResult). INFRA, not bad input: the media is good, the write
    // just failed. Re-throw so pg-boss retries the whole job; a re-delivery re-downloads (the source is
    // unchanged on a write failure), re-processes, and re-persists once storage/DB is healthy.
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
    // M3: surface held MEDIA to the operator moderation queue. Best-effort + non-fatal (a moderation-
    // enqueue failure must not flip an already-correct hold into a job failure), guarded by the optional
    // repo method + a present reportId, and deduped against an open item in the impl. A `held` status now
    // only ever means an NSFW policy hold (a near-duplicate is non-blocking, stays `ready` - see #43).
    if (asset.reportId && deps.repo.enqueueHeldModerationItem) {
      await deps.repo
        .enqueueHeldModerationItem({
          reportId: asset.reportId,
          reason: "NSFW model over threshold",
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

/** Log + report a rejection (the SINGLE rejection logging shape, used by both the clean-return and the
 * persist-and-throw paths). The job still completes; a rejection from untrusted input is visible, never a
 * crash. */
function logRejection(asset: MediaWorkerAsset, log: LogFn, report: ReportFn, note: string | null): void {
  log("media.checks: rejected", { mediaId: asset.id, kind: asset.kind, note })
  report(new Error(note ?? "media rejected"), {
    job: "media.checks",
    mediaId: asset.id,
    kind: asset.kind,
    note,
  })
}

/** Mark the asset rejected and log/report it. A rejection-write failure is itself infra (reported +
 * swallowed so the job still completes). Rejections from bad bytes are not abuse, so no flag is raised. */
export async function persistRejection(
  asset: MediaWorkerAsset,
  deps: MediaChecksDeps,
  note: string,
): Promise<void> {
  const log = deps.log ?? defaultLog
  const report = deps.report ?? (() => {})
  try {
    await deps.repo.applyResult(asset.id, { status: "rejected" })
  } catch (err) {
    report(err, { job: "media.checks", phase: "reject", mediaId: asset.id })
  }
  logRejection(asset, log, report, note)
}
