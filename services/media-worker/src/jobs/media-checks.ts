
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

export type DownloadFn = (
  r2Key: string,
  maxBytes: number,
  signal?: AbortSignal,
) => Promise<Uint8Array>

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
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.()
      reject(new JobTimeoutError(ms))
    }, ms)
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
  findPhashDuplicate?: FindPhashDuplicateFn
  report?: (err: unknown, context?: Record<string, unknown>) => void
  log?: (line: string, extra?: Record<string, unknown>) => void
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

type LogFn = (line: string, extra?: Record<string, unknown>) => void
type ReportFn = (err: unknown, context?: Record<string, unknown>) => void

const defaultLog: LogFn = (line, extra) => console.log(line, extra ?? {})

export async function runMediaChecksJob(
  payload: MediaChecksPayload,
  deps: MediaChecksDeps,
): Promise<MediaStatus> {
  const log = deps.log ?? defaultLog
  const report = deps.report ?? (() => {})

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

function logRejection(asset: MediaWorkerAsset, log: LogFn, report: ReportFn, note: string | null): void {
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
