import type { Storage } from "@civfix/shared/interfaces"
import type { MediaWorkerRepository } from "@civfix/api/media-worker-repository"
import { MEDIA_CHECKS_JOB } from "@civfix/api/queue-names"
import type { JobLogFn, JobReportFn } from "./obs.js"
import { servedKey, thumbnailKey } from "./media-keys.js"

export interface RejectedAsset {
  id: string
  r2Key: string
  servedKey: string | null
  thumbKey: string | null
}

export interface RejectCleanupDeps {
  repo: Pick<MediaWorkerRepository, "r2KeyReferencedByOthers" | "recordLeakedObjects">
  storage: Pick<Storage, "delete">
}

// A failed reference check counts as "still referenced": deleting bytes another row may serve is the
// unrecoverable mistake, a leaked object is not.
async function keepSharedBytes(
  asset: { id: string; r2Key: string },
  deps: RejectCleanupDeps,
  log: JobLogFn,
  report: JobReportFn,
  failure: { phase: string; line: string },
): Promise<boolean> {
  try {
    return await deps.repo.r2KeyReferencedByOthers(asset.id, asset.r2Key)
  } catch (err) {
    report(err, { job: MEDIA_CHECKS_JOB, phase: failure.phase, mediaId: asset.id })
    log(failure.line, { mediaId: asset.id, err: String(err) })
    return true
  }
}

export async function deleteSupersededUpload(
  asset: { id: string; r2Key: string },
  deps: RejectCleanupDeps,
  log: JobLogFn,
  report: JobReportFn,
): Promise<void> {
  const keep = await keepSharedBytes(asset, deps, log, report, {
    phase: "upload-cleanup",
    line: "media.checks: superseded-upload reference check failed (bytes left in place)",
  })
  if (keep) return

  try {
    await deps.storage.delete(asset.r2Key)
    return
  } catch (err) {
    log("media.checks: superseded-upload delete failed, tombstoning for retry", {
      mediaId: asset.id,
      key: asset.r2Key,
      err: String(err),
    })
  }

  await deps.repo
    .recordLeakedObjects({
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
  report(new Error("media.checks leaked the superseded upload object (tombstoned for retry)"), {
    job: MEDIA_CHECKS_JOB,
    phase: "upload-cleanup",
    mediaId: asset.id,
    key: asset.r2Key,
  })
}

export async function deleteRejectedObjects(
  asset: RejectedAsset,
  deps: RejectCleanupDeps,
  log: JobLogFn,
  report: JobReportFn,
): Promise<void> {
  const keep = await keepSharedBytes(asset, deps, log, report, {
    phase: "reject-cleanup",
    line: "media.checks: rejected-media reference check failed (bytes left in place)",
  })
  if (keep) return

  const keys = [asset.r2Key, servedKey(asset.r2Key), thumbnailKey(asset.r2Key)]
  if (asset.servedKey && !keys.includes(asset.servedKey)) keys.push(asset.servedKey)
  if (asset.thumbKey && !keys.includes(asset.thumbKey)) keys.push(asset.thumbKey)

  const leaked: string[] = []
  for (const key of keys) {
    try {
      await deps.storage.delete(key)
    } catch (err) {
      leaked.push(key)
      log("media.checks: rejected-media delete failed, tombstoning for retry", {
        mediaId: asset.id,
        key,
        err: String(err),
      })
    }
  }
  if (leaked.length === 0) return

  await deps.repo
    .recordLeakedObjects({
      mediaId: asset.id,
      keys: leaked,
      error: "rejected-media delete failed",
    })
    .catch((err: unknown) =>
      log("media.checks: rejected-media tombstone write failed (leak unrecoverable)", {
        mediaId: asset.id,
        keys: leaked,
        err: String(err),
      }),
    )
  report(
    new Error(
      `media.checks leaked ${leaked.length} rejected-media R2 object(s) (tombstoned for retry)`,
    ),
    { job: MEDIA_CHECKS_JOB, phase: "reject-cleanup", mediaId: asset.id, keys: leaked },
  )
}
