import type { Storage } from "@civfix/shared/interfaces"
import type { MediaWorkerRepository } from "@civfix/api/media-worker-repository"
import { R2_PUT_TTL_SEC } from "@civfix/api/adapters/storage"
import { MEDIA_UPLOAD_REAP_JOB } from "@civfix/api/queue-names"
import { resolveJobObs, type JobObsDeps } from "./obs.js"

const UPLOAD_REAP_SLACK_SEC = 5 * 60

export function uploadReapDelaySec(): number {
  return R2_PUT_TTL_SEC + UPLOAD_REAP_SLACK_SEC
}

export interface UploadReapPayload {
  mediaId: string
  uploadId: string
  r2Key: string
}

export interface UploadReapDeps extends JobObsDeps {
  repo: MediaWorkerRepository
  storage: Storage
}

export type UploadReapOutcome = "deleted" | "kept" | "leaked"

export class UploadReapInfraError extends Error {
  constructor(phase: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`media.upload.reap infra failure (${phase}, retryable): ${detail}`)
    this.name = "UploadReapInfraError"
    Object.setPrototypeOf(this, UploadReapInfraError.prototype)
  }
}

export function parseUploadReapPayload(data: unknown): UploadReapPayload | null {
  if (typeof data !== "object" || data === null) return null
  const d = data as Record<string, unknown>
  if (
    typeof d.mediaId === "string" &&
    typeof d.uploadId === "string" &&
    typeof d.r2Key === "string"
  ) {
    return { mediaId: d.mediaId, uploadId: d.uploadId, r2Key: d.r2Key }
  }
  return null
}

export async function runUploadReapJob(
  payload: UploadReapPayload,
  deps: UploadReapDeps,
): Promise<UploadReapOutcome> {
  const { log, report } = resolveJobObs(deps)

  let asset
  try {
    asset =
      (await deps.repo.findById(payload.mediaId)) ??
      (await deps.repo.findByUploadId(payload.uploadId))
  } catch (err) {
    report(err, { job: MEDIA_UPLOAD_REAP_JOB, phase: "load", mediaId: payload.mediaId })
    log("media.upload.reap: asset load failed, will retry", {
      mediaId: payload.mediaId,
      err: String(err),
    })
    throw new UploadReapInfraError("load", err)
  }

  if (asset !== null && !uploadKeyIsDead(asset)) {
    log("media.upload.reap: upload key still in use, skipped", {
      mediaId: payload.mediaId,
      status: asset.status,
    })
    return "kept"
  }

  const r2Key = asset?.r2Key ?? payload.r2Key
  try {
    if (await deps.repo.r2KeyReferencedByOthers(payload.mediaId, r2Key)) {
      log("media.upload.reap: upload key referenced by another row, skipped", {
        mediaId: payload.mediaId,
      })
      return "kept"
    }
  } catch (err) {
    report(err, { job: MEDIA_UPLOAD_REAP_JOB, phase: "reference-check", mediaId: payload.mediaId })
    log("media.upload.reap: reference check failed, will retry", {
      mediaId: payload.mediaId,
      err: String(err),
    })
    throw new UploadReapInfraError("reference-check", err)
  }

  try {
    await deps.storage.delete(r2Key)
    log("media.upload.reap: upload object deleted after the presigned-PUT window", {
      mediaId: payload.mediaId,
    })
    return "deleted"
  } catch (err) {
    await deps.repo
      .recordLeakedObjects?.({
        mediaId: payload.mediaId,
        keys: [r2Key],
        error: "delayed upload reap delete failed",
      })
      .catch((tombErr: unknown) =>
        log("media.upload.reap: tombstone write failed (leak unrecoverable)", {
          mediaId: payload.mediaId,
          err: String(tombErr),
        }),
      )
    report(err, { job: MEDIA_UPLOAD_REAP_JOB, phase: "delete", mediaId: payload.mediaId })
    return "leaked"
  }
}

function uploadKeyIsDead(asset: {
  status: string
  r2Key: string
  servedKey: string | null
}): boolean {
  if (asset.status === "rejected") return true
  return asset.servedKey !== null && asset.servedKey !== asset.r2Key
}
