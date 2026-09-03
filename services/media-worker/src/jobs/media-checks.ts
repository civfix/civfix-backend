
import type { MediaKind, MediaStatus } from "@civfix/shared"
import type { AbuseChecks, Storage, StorageHead } from "@civfix/shared/interfaces"
import type {
  MediaResultPatch,
  MediaWorkerAsset,
  MediaWorkerRepo,
} from "@civfix/api/media-repo"
import type { FindPhashDuplicateFn } from "@civfix/api/adapters/abuse-checks"
import type { WorkerLimits } from "../config.js"
import { DownloadTooLargeError, type DownloadedObject, type DownloadFn } from "../download.js"
import { settleWithin } from "../timeout.js"
import { resolveJobObs, type JobObsDeps, type JobLogFn, type JobReportFn } from "./obs.js"
import { readEtag } from "@civfix/api/media-repo"
import { servedKey, thumbnailKey } from "./media-keys.js"
import { deleteRejectedObjects, deleteSupersededUpload } from "./reject-cleanup.js"
import {
  processMedia,
  errNote,
  type MediaProcessResult,
} from "./media-pipeline.js"

export * from "./media-pipeline.js"

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
  /** ETag of the upload object as the API saw it at finalize; absent when the seam reports none. */
  uploadEtag?: string | null
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
    return {
      mediaId: d.mediaId,
      uploadId: d.uploadId,
      r2Key: d.r2Key,
      kind: d.kind,
      uploadEtag: typeof d.uploadEtag === "string" ? d.uploadEtag : null,
    }
  }
  return null
}

export interface MediaChecksOutcome {
  status: MediaStatus | "missing"
  reportId: string | null
}

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
  return { status: await processAsset(asset, payload, deps), reportId }
}

export async function runMediaChecksJob(
  payload: MediaChecksPayload,
  deps: MediaChecksDeps,
): Promise<MediaStatus> {
  const outcome = await runMediaChecksJobDetailed(payload, deps)
  return outcome.status === "missing" ? "rejected" : outcome.status
}

async function processAsset(
  asset: MediaWorkerAsset,
  payload: MediaChecksPayload,
  deps: MediaChecksDeps,
): Promise<MediaStatus> {
  const { log, report } = resolveJobObs(deps)

  // A re-delivered job for an asset that already reached a terminal status has nothing to do: every
  // write below is CAS'd on status='validating', and since C1 the upload object it would download is
  // deleted the moment the processed bytes are published. Settle on the recorded verdict instead of
  // failing the download and burning the retry budget.
  if (asset.status !== "validating") {
    log("media.checks: asset already terminal, skipping", {
      mediaId: asset.id,
      uploadId: asset.uploadId,
      status: asset.status,
    })
    return asset.status
  }

  let downloaded: DownloadedObject
  const downloadAbort = new AbortController()
  try {
    downloaded = await withJobTimeout(
      deps.download(asset.r2Key, deps.limits.maxDownloadBytes, downloadAbort.signal),
      deps.limits.jobTimeoutMs,
      () => downloadAbort.abort(),
    )
  } catch (err) {
    if (err instanceof DownloadTooLargeError) {
      return persistRejection(asset, deps, errNote("download too large", err))
    }
    report(err, { job: "media.checks", phase: "download-infra", mediaId: asset.id })
    log("media.checks: download infra failure, will retry", {
      mediaId: asset.id,
      r2Key: asset.r2Key,
      err: String(err),
    })
    throw new MediaInfraError("download", err)
  }

  const bytes = downloaded.bytes
  // C1: the bytes the API sized at finalize must be the bytes we just inspected. A PUT that raced
  // finalize (the presigned URL stays valid for its whole TTL) changes the object version, and the
  // result of checking one version while publishing another is exactly the overwrite this closes.
  if (payload.uploadEtag && downloaded.etag && payload.uploadEtag !== downloaded.etag) {
    return persistRejection(asset, deps, "upload object changed between finalize and processing")
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
      report(err, { job: "media.checks", phase: "process-timeout", mediaId: asset.id })
      log("media.checks: processing timed out, will retry", { mediaId: asset.id, err: String(err) })
      throw new MediaInfraError("process-timeout", err)
    }
    return persistRejection(asset, deps, errNote("process failed", err))
  }

  const patch: MediaResultPatch = {
    status: result.status,
    codec: result.codec,
    width: result.width,
    height: result.height,
    phash: result.phash,
  }

  const publishes = result.status !== "rejected" && result.processedBytes !== null

  if (publishes) {
    let current: StorageHead | null
    try {
      current = await deps.storage.head(asset.r2Key)
    } catch (err) {
      report(err, { job: "media.checks", phase: "publish-precheck", mediaId: asset.id })
      log("media.checks: pre-publish head failed, will retry", {
        mediaId: asset.id,
        err: String(err),
      })
      throw new MediaInfraError("publish-precheck", err)
    }
    const note = uploadDriftNote(current, downloaded.etag)
    if (note !== null) {
      return persistRejection(asset, deps, note)
    }
  }

  let uploaded = false
  let applied: MediaWorkerAsset | null
  try {
    if (publishes && result.processedBytes) {
      // C1: publish to the WORKER-OWNED key. Writing back to asset.r2Key would put the vetted bytes at
      // the exact key the uploader still holds a presigned PUT for, so every check here could be
      // undone after the asset went `ready`.
      const sKey = servedKey(asset.r2Key)
      const tKey = result.thumbnailBytes ? thumbnailKey(asset.r2Key) : null
      await Promise.all([
        deps.storage.put(sKey, result.processedBytes, {
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
      patch.servedKey = sKey
      if (tKey) patch.thumbKey = tKey
      uploaded = true
    }

    for (const flag of result.flags) {
      await deps.repo.insertAbuseFlag({ subjectId: asset.id, reason: flag.reason })
    }

    applied = await deps.repo.applyResult(asset.id, patch)
  } catch (err) {
    report(err, { job: "media.checks", phase: "persist", mediaId: asset.id })
    log("media.checks: persist infra failure, will retry", { mediaId: asset.id, err: String(err) })
    throw new MediaInfraError("persist", err)
  }

  if (applied === null) {
    return settleTerminalRace(asset, deps, { attempted: result.status, uploaded })
  }

  if (uploaded) {
    // The processed object is live at served_key, so the upload object is now dead weight AND a
    // still-writable key: drop it (tombstoned + retried like every other reap failure).
    await deleteSupersededUpload(asset, deps, log, report)
  }

  if (result.status === "rejected") {
    logRejection(asset, log, report, result.note)
    await deleteRejectedObjects(asset, deps, log, report)
  } else if (result.status === "held") {
    log("media.checks: held", {
      mediaId: asset.id,
      note: result.note,
      flags: result.flags.map((f) => f.reason),
    })
    if (asset.reportId && deps.repo.enqueueHeldModerationItem) {
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
      exifGpsPresent: result.exifGps !== null,
    })
  }
  return result.status
}

async function settleTerminalRace(
  asset: MediaWorkerAsset,
  deps: MediaChecksDeps,
  ctx: { attempted: MediaStatus; uploaded: boolean },
): Promise<MediaStatus> {
  const { log, report } = resolveJobObs(deps)

  let current: MediaWorkerAsset | null = null
  let reread = true
  try {
    current = await deps.repo.findById(asset.id)
  } catch (err) {
    reread = false
    report(err, { job: "media.checks", phase: "terminal-race-reread", mediaId: asset.id })
  }

  const winner = current?.status ?? null
  log("media.checks: terminal-status CAS lost, the asset is already terminal", {
    mediaId: asset.id,
    uploadId: asset.uploadId,
    attempted: ctx.attempted,
    winner,
    reread,
  })

  if (ctx.uploaded) {
    if (!reread) {
      report(
        new Error(
          "media.checks re-uploaded bytes for an already-terminal asset it could not re-read",
        ),
        { job: "media.checks", phase: "terminal-race", mediaId: asset.id, r2Key: asset.r2Key },
      )
    } else if (winner === null || winner === "rejected") {
      await deleteRejectedObjects(
        {
          id: asset.id,
          r2Key: asset.r2Key,
          servedKey: servedKey(asset.r2Key),
          thumbKey: thumbnailKey(asset.r2Key),
        },
        deps,
        log,
        report,
      )
    }
  }

  return winner ?? "rejected"
}

/**
 * C1: is the upload object still the exact object we processed? A missing object or a different ETag
 * means someone re-PUT the key while the worker was working, so what we vetted is not what is there.
 * Returns a rejection note, or null when the object is unchanged (or the seam reports no version at
 * all, which is the offline-fake case).
 */
function uploadDriftNote(head: StorageHead | null, downloadedEtag: string | null): string | null {
  if (head === null) return "upload object disappeared before publish"
  const current = readEtag(head)
  if (downloadedEtag === null || current === null) return null
  return current === downloadedEtag ? null : "upload object was overwritten during processing"
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

export async function persistRejection(
  asset: MediaWorkerAsset,
  deps: MediaChecksDeps,
  note: string,
): Promise<MediaStatus> {
  const { log, report } = resolveJobObs(deps)
  let applied: MediaWorkerAsset | null
  try {
    applied = await deps.repo.applyResult(asset.id, { status: "rejected" })
  } catch (err) {
    report(err, { job: "media.checks", phase: "reject", mediaId: asset.id })
    log("media.checks: failed to persist rejection, will retry", {
      mediaId: asset.id,
      note,
      err: String(err),
    })
    throw new MediaInfraError("reject", err)
  }
  if (applied === null) {
    return settleTerminalRace(asset, deps, { attempted: "rejected", uploaded: false })
  }
  logRejection(asset, log, report, note)
  await deleteRejectedObjects(asset, deps, log, report)
  return "rejected"
}
