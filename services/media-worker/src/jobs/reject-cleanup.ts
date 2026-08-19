import type { Storage } from "@civfix/shared/interfaces"
import type { MediaWorkerRepo } from "@civfix/api/media-repo"
import type { JobLogFn, JobReportFn } from "./obs.js"
import { thumbnailKey } from "./media-keys.js"

export interface RejectedAsset {
  id: string
  r2Key: string
  thumbKey: string | null
}

export interface RejectCleanupDeps {
  repo: Pick<MediaWorkerRepo, "r2KeyReferencedByOthers" | "recordLeakedObjects">
  storage: Pick<Storage, "delete">
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

  const keys = [asset.r2Key, thumbnailKey(asset.r2Key)]
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
