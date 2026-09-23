import type { MediaKind, MediaStatus } from "@civfix/shared"
import type { AbuseChecks, Storage, StorageHead } from "@civfix/shared/interfaces"
import type { MediaResultPatch, MediaWorkerAsset, MediaWorkerRepo } from "@civfix/api/media-repo"
import type { FindPhashDuplicateFn } from "@civfix/api/adapters/abuse-checks"
import type { WorkerLimits } from "../config.js"
import { DownloadTooLargeError, type DownloadedObject, type DownloadFn } from "../download.js"
import { settleWithin } from "../timeout.js"
import {
  resolveJobObs,
  type JobObs,
  type JobObsDeps,
  type JobLogFn,
  type JobReportFn,
} from "./obs.js"
import { MEDIA_CHECKS_JOB, readEtag } from "@civfix/api/media-repo"
import { SandboxSpawnError } from "../sandbox/exec.js"
import { ScratchSetupError } from "../sandbox/tmp.js"
import { servedKey, thumbnailKey } from "./media-keys.js"
import { deleteRejectedObjects, deleteSupersededUpload } from "./reject-cleanup.js"
import { processMedia, errNote, type MediaProcessResult } from "./media-pipeline.js"

export * from "./media-pipeline.js"

export type { DownloadFn }

class JobTimeoutError extends Error {
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

function withJobTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
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
  publicMediaBase?: string
}

function publicMediaUrl(base: string, key: string): string {
  return `${base.replace(/\/+$/, "")}/${key.replace(/^\/+/, "")}`
}

export interface MediaChecksPayload {
  mediaId: string
  uploadId: string
  r2Key: string
  kind: MediaKind
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

interface RetryableFailure {
  phase: string
  reportPhase?: string
  line: string
  ids: Record<string, unknown>
  logExtra?: Record<string, unknown>
}

// The one shape every retryable failure takes: report it, log it, and hand back the MediaInfraError the
// caller throws. MediaInfraError is the only error allowed to leave a media.checks job, so every infra
// branch below funnels through here rather than wrapping the whole job in a catch that would misclassify
// a rejection as infra.
function retryableFailure(
  { log, report }: JobObs,
  err: unknown,
  failure: RetryableFailure,
): MediaInfraError {
  report(err, {
    job: MEDIA_CHECKS_JOB,
    phase: failure.reportPhase ?? failure.phase,
    ...failure.ids,
  })
  log(failure.line, { ...failure.ids, ...failure.logExtra, err: String(err) })
  return new MediaInfraError(failure.phase, err)
}

export async function runMediaChecksJobDetailed(
  payload: MediaChecksPayload,
  deps: MediaChecksDeps,
): Promise<MediaChecksOutcome> {
  const obs = resolveJobObs(deps)

  let asset: MediaWorkerAsset | null = null
  try {
    asset = await deps.repo.findById(payload.mediaId)
    if (!asset) asset = await deps.repo.findByUploadId(payload.uploadId)
  } catch (err) {
    throw retryableFailure(obs, err, {
      phase: "load",
      reportPhase: "load-infra",
      line: "media.checks: failed to load asset, will retry",
      ids: { uploadId: payload.uploadId },
    })
  }
  if (!asset) {
    obs.log("media.checks: asset not found (already swept?)", { uploadId: payload.uploadId })
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

type PhaseOutcome<T> = { settled: true; status: MediaStatus } | { settled: false; value: T }

async function processAsset(
  asset: MediaWorkerAsset,
  payload: MediaChecksPayload,
  deps: MediaChecksDeps,
): Promise<MediaStatus> {
  if (asset.status !== "validating") {
    resolveJobObs(deps).log("media.checks: asset already terminal, skipping", {
      mediaId: asset.id,
      uploadId: asset.uploadId,
      status: asset.status,
    })
    return asset.status
  }

  const download = await downloadUpload(asset, payload, deps)
  if (download.settled) return download.status
  const downloaded = download.value

  const processing = await runPipeline(asset, downloaded.bytes, deps)
  if (processing.settled) return processing.status
  const result = processing.value

  const publishes = result.status !== "rejected" && result.processedBytes !== null
  if (publishes) {
    const drift = await uploadDriftBeforePublish(asset, downloaded.etag, deps)
    if (drift !== null) return persistRejection(asset, deps, drift)
  }

  const { applied, uploaded } = await persistResult(asset, result, publishes, deps)
  if (applied === null) {
    return settleTerminalRace(asset, deps, { attempted: result.status, uploaded })
  }
  await afterApply(asset, result, applied, uploaded, deps)
  return result.status
}

async function downloadUpload(
  asset: MediaWorkerAsset,
  payload: MediaChecksPayload,
  deps: MediaChecksDeps,
): Promise<PhaseOutcome<DownloadedObject>> {
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
      return rejectedOutcome(asset, deps, errNote("download too large", err))
    }
    throw retryableFailure(resolveJobObs(deps), err, {
      phase: "download",
      reportPhase: "download-infra",
      line: "media.checks: download infra failure, will retry",
      ids: { mediaId: asset.id },
      logExtra: { r2Key: asset.r2Key },
    })
  }

  if (payload.uploadEtag && downloaded.etag && payload.uploadEtag !== downloaded.etag) {
    return rejectedOutcome(asset, deps, "upload object changed between finalize and processing")
  }
  return { settled: false, value: downloaded }
}

async function rejectedOutcome<T>(
  asset: MediaWorkerAsset,
  deps: MediaChecksDeps,
  note: string,
): Promise<PhaseOutcome<T>> {
  return { settled: true, status: await persistRejection(asset, deps, note) }
}

function retryableProcessFailure(err: unknown): { phase: string; line: string } | null {
  if (err instanceof JobTimeoutError) {
    return { phase: "process-timeout", line: "media.checks: processing timed out, will retry" }
  }
  if (err instanceof SandboxSpawnError) {
    return {
      phase: "sandbox-spawn",
      line: "media.checks: a decoder could not be started, will retry",
    }
  }
  if (err instanceof ScratchSetupError) {
    return {
      phase: "scratch",
      line: "media.checks: the sandbox scratch dir could not be prepared, will retry",
    }
  }
  return null
}

async function runPipeline(
  asset: MediaWorkerAsset,
  bytes: Uint8Array,
  deps: MediaChecksDeps,
): Promise<PhaseOutcome<MediaProcessResult>> {
  try {
    const result = await withJobTimeout(
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
    return { settled: false, value: result }
  } catch (err) {
    const retryable = retryableProcessFailure(err)
    if (retryable !== null) {
      throw retryableFailure(resolveJobObs(deps), err, { ...retryable, ids: { mediaId: asset.id } })
    }
    return rejectedOutcome(asset, deps, errNote("process failed", err))
  }
}

async function uploadDriftBeforePublish(
  asset: MediaWorkerAsset,
  downloadedEtag: string | null,
  deps: MediaChecksDeps,
): Promise<string | null> {
  let current: StorageHead | null
  try {
    current = await deps.storage.head(asset.r2Key)
  } catch (err) {
    throw retryableFailure(resolveJobObs(deps), err, {
      phase: "publish-precheck",
      line: "media.checks: pre-publish head failed, will retry",
      ids: { mediaId: asset.id },
    })
  }
  return uploadDriftNote(current, downloadedEtag)
}

function contentTypeOption(contentType: string | null): { contentType?: string } {
  return contentType !== null ? { contentType } : {}
}

async function putProcessedObjects(
  asset: MediaWorkerAsset,
  processedBytes: Buffer,
  result: MediaProcessResult,
  storage: Storage,
): Promise<{ servedKey: string; thumbKey: string | null }> {
  const sKey = servedKey(asset.r2Key)
  const tKey = result.thumbnailBytes ? thumbnailKey(asset.r2Key) : null
  await Promise.all([
    storage.put(sKey, processedBytes, contentTypeOption(result.processedContentType)),
    tKey && result.thumbnailBytes
      ? storage.put(tKey, result.thumbnailBytes, contentTypeOption(result.thumbnailContentType))
      : Promise.resolve(),
  ])
  return { servedKey: sKey, thumbKey: tKey }
}

async function persistResult(
  asset: MediaWorkerAsset,
  result: MediaProcessResult,
  publishes: boolean,
  deps: MediaChecksDeps,
): Promise<{ applied: MediaWorkerAsset | null; uploaded: boolean }> {
  const patch: MediaResultPatch = {
    status: result.status,
    codec: result.codec,
    width: result.width,
    height: result.height,
    phash: result.phash,
  }
  let uploaded = false
  try {
    if (publishes && result.processedBytes) {
      const keys = await putProcessedObjects(asset, result.processedBytes, result, deps.storage)
      patch.byteSize = result.processedBytes.byteLength
      patch.servedKey = keys.servedKey
      if (keys.thumbKey) patch.thumbKey = keys.thumbKey
      uploaded = true
    }

    for (const flag of result.flags) {
      await deps.repo.insertAbuseFlag({ subjectId: asset.id, reason: flag.reason })
    }

    return { applied: await deps.repo.applyResult(asset.id, patch), uploaded }
  } catch (err) {
    throw retryableFailure(resolveJobObs(deps), err, {
      phase: "persist",
      line: "media.checks: persist infra failure, will retry",
      ids: { mediaId: asset.id },
    })
  }
}

async function afterApply(
  asset: MediaWorkerAsset,
  result: MediaProcessResult,
  applied: MediaWorkerAsset,
  uploaded: boolean,
  deps: MediaChecksDeps,
): Promise<void> {
  const { log, report } = resolveJobObs(deps)
  if (uploaded) {
    await deleteSupersededUpload(asset, deps, log, report)
  }
  if (result.status === "rejected") {
    logRejection(asset, log, report, result.note)
    await deleteRejectedObjects(asset, deps, log, report)
    return
  }
  if (result.status === "held") {
    await onHeld(asset, result, deps, log)
    return
  }
  await onReady(asset, result, applied, deps, log)
}

async function onHeld(
  asset: MediaWorkerAsset,
  result: MediaProcessResult,
  deps: MediaChecksDeps,
  log: JobLogFn,
): Promise<void> {
  log("media.checks: held", {
    mediaId: asset.id,
    note: result.note,
    flags: result.flags.map((f) => f.reason),
  })
  if (!asset.reportId || !deps.repo.enqueueHeldModerationItem) return
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

async function onReady(
  asset: MediaWorkerAsset,
  result: MediaProcessResult,
  applied: MediaWorkerAsset,
  deps: MediaChecksDeps,
  log: JobLogFn,
): Promise<void> {
  log("media.checks: ready", {
    mediaId: asset.id,
    kind: asset.kind,
    width: result.width,
    height: result.height,
    codec: result.codec,
    exifGpsPresent: result.exifGps !== null,
  })
  if (!applied.servedKey || !deps.publicMediaBase || !deps.repo.refreshAvatarUrls) return
  await deps.repo
    .refreshAvatarUrls(asset.id, publicMediaUrl(deps.publicMediaBase, applied.servedKey))
    .catch((err: unknown) =>
      log("media.checks: avatar url refresh failed (non-fatal)", { err: String(err) }),
    )
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
    report(err, { job: MEDIA_CHECKS_JOB, phase: "terminal-race-reread", mediaId: asset.id })
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
        { job: MEDIA_CHECKS_JOB, phase: "terminal-race", mediaId: asset.id, r2Key: asset.r2Key },
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
    job: MEDIA_CHECKS_JOB,
    mediaId: asset.id,
    kind: asset.kind,
    note,
  })
}

async function persistRejection(
  asset: MediaWorkerAsset,
  deps: MediaChecksDeps,
  note: string,
): Promise<MediaStatus> {
  const obs = resolveJobObs(deps)
  const { log, report } = obs
  let applied: MediaWorkerAsset | null
  try {
    applied = await deps.repo.applyResult(asset.id, { status: "rejected" })
  } catch (err) {
    throw retryableFailure(obs, err, {
      phase: "reject",
      line: "media.checks: failed to persist rejection, will retry",
      ids: { mediaId: asset.id },
      logExtra: { note },
    })
  }
  if (applied === null) {
    return settleTerminalRace(asset, deps, { attempted: "rejected", uploaded: false })
  }
  logRejection(asset, log, report, note)
  await deleteRejectedObjects(asset, deps, log, report)
  return "rejected"
}
