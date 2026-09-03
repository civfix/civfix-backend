import type { Storage } from "@civfix/shared/interfaces"
import type { MediaWorkerRepo } from "@civfix/api/media-repo"
import type { JobLogFn, JobReportFn } from "./obs.js"
import { servedKey, thumbnailKey } from "./media-keys.js"

export interface RejectedAsset {
  id: string
  r2Key: string
  servedKey: string | null
  thumbKey: string | null
}

export interface RejectCleanupDeps {
  repo: Pick<MediaWorkerRepo, "r2KeyReferencedByOthers" | "recordLeakedObjects">
  storage: Pick<Storage, "delete">
}

/**
 * C1: drop the UPLOAD object once the processed bytes are published under the worker-owned served key.
 * The upload key is the one the client holds a live presigned PUT for, so leaving the object there
 * leaves a writable copy of an asset nobody reads; deleting it also reclaims the bytes immediately
 * instead of at the next orphan sweep. Best-effort with the same tombstone + retry as every other reap,
 * and skipped when another row still points at the key. Never throws.
 */
export async function deleteSupersededUpload(
  asset: { id: string; r2Key: string },
  deps: RejectCleanupDeps,
  log: JobLogFn,
  report: JobReportFn,
): Promise<void> {
  let stillShared: boolean
  try {
    stillShared = await deps.repo.r2KeyReferencedByOthers(asset.id, asset.r2Key)
  } catch (err) {
    report(err, { job: "media.checks", phase: "upload-cleanup", mediaId: asset.id })
    log("media.checks: superseded-upload reference check failed (bytes left in place)", {
      mediaId: asset.id,
      err: String(err),
    })
    return
  }
  if (stillShared) return

  try {
    await deps.storage.delete(asset.r2Key)
    return
  } catch {
    // fall through to the tombstone
  }

  await deps.repo
    .recordLeakedObjects?.({
      mediaId: asset.id,
      keys: [asset.r2Key],
      error: "superseded-upload delete failed",
    })
    .catch((err: unknown) =>
      log("media.checks: superseded-upload tombstone write failed (leak unrecoverable)", {
        mediaId: asset.id,
        key: asset.r2Key,
        err: String(err),
      }),
    )
  report(
    new Error("media.checks leaked the superseded upload object (tombstoned for retry)"),
    { job: "media.checks", phase: "upload-cleanup", mediaId: asset.id, key: asset.r2Key },
  )
}

export async function deleteRejectedObjects(
  asset: RejectedAsset,
  deps: RejectCleanupDeps,
  log: JobLogFn,
  report: JobReportFn,
): Promise<void> {
  let stillShared: boolean
  try {
    stillShared = await deps.repo.r2KeyReferencedByOthers(asset.id, asset.r2Key)
  } catch (err) {
    report(err, { job: "media.checks", phase: "reject-cleanup", mediaId: asset.id })
    log("media.checks: rejected-media reference check failed (bytes left in place)", {
      mediaId: asset.id,
      err: String(err),
    })
    return
  }
  if (stillShared) return

  const keys = [asset.r2Key, servedKey(asset.r2Key), thumbnailKey(asset.r2Key)]
  if (asset.servedKey && !keys.includes(asset.servedKey)) keys.push(asset.servedKey)
  if (asset.thumbKey && !keys.includes(asset.thumbKey)) keys.push(asset.thumbKey)

  const leaked: string[] = []
  for (const key of keys) {
    try {
      await deps.storage.delete(key)
    } catch {
      leaked.push(key)
    }
  }
  if (leaked.length === 0) return

  await deps.repo
    .recordLeakedObjects?.({ mediaId: asset.id, keys: leaked, error: "rejected-media delete failed" })
    .catch((err: unknown) =>
      log("media.checks: rejected-media tombstone write failed (leak unrecoverable)", {
        mediaId: asset.id,
        keys: leaked,
        err: String(err),
      }),
    )
  report(
    new Error(`media.checks leaked ${leaked.length} rejected-media R2 object(s) (tombstoned for retry)`),
    { job: "media.checks", phase: "reject-cleanup", mediaId: asset.id, keys: leaked },
  )
}
