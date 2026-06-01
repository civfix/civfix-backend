/**
 * media.checks job: the sandboxed, untrusted-byte processing pipeline.
 *
 * THIS is where the Phase-1 done-criterion "a crafted upload fails safely in the worker" is enforced.
 * The contract, in one sentence: NO input may crash the worker; every outcome is a row update plus an
 * abuse_flag/log/GlitchTip report, and the job always COMPLETES.
 *
 * Two layers, split for testability:
 *
 *   processMedia({ bytes, kind }, deps)  PURE-ish core. Decodes/validates the bytes via the sandbox
 *     wrappers, runs the NSFW + near-duplicate seams, and returns a MediaProcessResult (status, width,
 *     height, codec, phash, thumbnailBytes, processedBytes, flags, ...). It NEVER throws and NEVER
 *     touches storage or the database, so unit tests can call it with crafted bytes + a FakeAbuseChecks
 *     and assert the result object directly.
 *
 *   runMediaChecksJob(job, deps)  ORCHESTRATOR the worker registers. Loads the asset (repo), downloads
 *     the source bytes under a hard size cap (deps.download), calls processMedia, then PERSISTS:
 *     writes the stripped/remuxed object + thumbnail to NEW storage keys, applies the result to the
 *     media_assets row, raises any abuse_flag, and reports rejections to GlitchTip. It also never
 *     throws: a failure to even load/download still results in status "rejected" and a completed job.
 *     The download+process span is bounded by an OVERALL per-job wall-clock budget (limits.jobTimeoutMs)
 *     via withJobTimeout, so the documented per-job budget is actually enforced (P2-1) on top of the
 *     individual per-tool timeouts - a wall-clock overrun is a safe "rejected".
 *
 * Status mapping:
 *   ready     - decoded/validated clean, below NSFW threshold, not a near-duplicate.
 *   held      - NSFW score >= threshold (policy hold; abuse_flag reason "nsfw"). Also used for a
 *               near-duplicate hold (abuse_flag reason "phash_dup").
 *   rejected  - any unsafe/invalid input (undecodable, wrong magic, pixel bomb, oversize, unsupported
 *               codec/duration, ffprobe/ffmpeg/timeout failure).
 *
 * NSFW seam: nsfwScore stays behind AbuseChecks (FakeAbuseChecks by default under USE_FAKE_ABUSE_NSFW).
 * The flag-and-hold FLOW is fully implemented and tested here against the fake; a real ONNX/NSFW model
 * is a flag-gated pre-launch follow-up (plan sections 3/20) that only swaps the adapter behind the seam.
 */

import type { AbuseChecks } from "@civfix/shared/interfaces"
import type { MediaKind, MediaStatus } from "@civfix/shared"
import type {
  MediaResultPatch,
  MediaWorkerAsset,
  MediaWorkerRepo,
  WorkerAbuseReason,
} from "@civfix/api/media-repo"
import type { FindPhashDuplicateFn } from "@civfix/api/adapters/abuse-checks"
import type { Storage } from "@civfix/shared/interfaces"
import type { WorkerLimits } from "../config.js"
import { ALLOWED_VIDEO_CODECS } from "../config.js"
import { processImage, type ExifGps } from "../sandbox/image.js"
import { perceptualHash } from "../sandbox/phash.js"
import { probeBytes } from "../sandbox/ffprobe.js"
import { grabFrameJpeg, remuxStripMetadata } from "../sandbox/ffmpeg-remux.js"

/** A flag the pipeline decided to raise (subject is the media id; source defaults to "worker"). */
export interface PipelineFlag {
  reason: WorkerAbuseReason
}

/** Result of processing one asset's bytes. Storage/DB-free so it is directly assertable in tests. */
export interface MediaProcessResult {
  status: MediaStatus
  width: number | null
  height: number | null
  codec: string | null
  phash: string | null
  /** Processed (EXIF-stripped image / metadata-stripped remux) bytes, when produced. */
  processedBytes: Buffer | null
  processedContentType: string | null
  /** Thumbnail bytes, when produced. */
  thumbnailBytes: Buffer | null
  thumbnailContentType: string | null
  /** GPS read from the ORIGINAL EXIF, kept for the report GPS cross-check note (images only). */
  exifGps: ExifGps | null
  /** Abuse flags to raise (nsfw / phash_dup / gps). */
  flags: PipelineFlag[]
  /** Human-readable reason when status is rejected/held (for logs + GlitchTip). */
  note: string | null
}

export interface ProcessInput {
  bytes: Uint8Array
  kind: MediaKind
  /**
   * The id of the asset being processed. Threaded into the near-duplicate lookup as excludeAssetId so a
   * re-delivered/double-enqueued job (which recomputes the SAME phash on a row that already has its phash
   * persisted) never matches the asset against its OWN row and flags it a duplicate of itself (P0-2).
   * Optional so pure-core unit tests that only assert decode/strip behavior can omit it.
   */
  selfAssetId?: string
}

export interface ProcessDeps {
  abuseChecks: AbuseChecks
  limits: WorkerLimits
  /**
   * Self-aware near-duplicate lookup (excludes the current asset via excludeAssetId). When provided it is
   * used INSTEAD of abuseChecks.isNearDuplicate so the self-exclusion (P0-2) is honored; when omitted the
   * pipeline falls back to abuseChecks.isNearDuplicate (e.g. FakeAbuseChecks in offline tests, which has
   * no persisted self-row to collide with). Injected by the worker from its DB-backed lookup.
   */
  findPhashDuplicate?: FindPhashDuplicateFn
}

/** Build a rejected result with a note. Helper to keep the safe-failure paths terse + consistent. */
function rejected(note: string): MediaProcessResult {
  return {
    status: "rejected",
    width: null,
    height: null,
    codec: null,
    phash: null,
    processedBytes: null,
    processedContentType: null,
    thumbnailBytes: null,
    thumbnailContentType: null,
    exifGps: null,
    flags: [],
    note,
  }
}

/** Stringify an unknown error compactly for a note (no stack, ASCII-only). */
function errNote(prefix: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return `${prefix}: ${msg}`.slice(0, 300)
}

/**
 * Apply the NSFW + near-duplicate seams to an already-validated asset and finalize the status. Shared
 * by the image and video success paths. Returns the (possibly held) status plus any flags. Never
 * throws: a seam error degrades to "ready" with no flag is NOT acceptable for NSFW (fail closed), so a
 * seam throw is mapped to a hold. Dedupe seam throw is treated as "not a duplicate" (fail open: a
 * dedupe outage must not block legitimate uploads), and logged via the returned note.
 */
async function applyAbuseSeams(
  bytes: Uint8Array,
  phash: string | null,
  deps: ProcessDeps,
  selfAssetId?: string,
): Promise<{ status: MediaStatus; flags: PipelineFlag[]; note: string | null }> {
  const flags: PipelineFlag[] = []
  let note: string | null = null

  // NSFW: fail CLOSED (a scoring error holds the asset for human review rather than publishing it).
  let nsfw = 0
  try {
    nsfw = await deps.abuseChecks.nsfwScore(bytes)
  } catch (err) {
    return {
      status: "held",
      flags: [{ reason: "nsfw" }],
      note: errNote("nsfw scoring failed (held)", err),
    }
  }
  if (nsfw >= deps.limits.nsfwHoldThreshold) {
    return { status: "held", flags: [{ reason: "nsfw" }], note: `nsfw score ${nsfw.toFixed(3)}` }
  }

  // Near-duplicate: fail OPEN (a dedupe outage must not reject good uploads). Only consult the seam
  // when we actually have a perceptual hash. Prefer the self-aware lookup (excludes THIS asset's own row
  // so a re-delivered job is not a duplicate of itself, P0-2); fall back to the plain isNearDuplicate.
  if (phash !== null) {
    try {
      const dup = deps.findPhashDuplicate
        ? await deps.findPhashDuplicate(phash, { excludeAssetId: selfAssetId })
        : await deps.abuseChecks.isNearDuplicate(phash)
      if (dup.dup) {
        flags.push({ reason: "phash_dup" })
        return {
          status: "held",
          flags,
          note: `near-duplicate of ${dup.ofReportId ?? "unknown"}`,
        }
      }
    } catch (err) {
      note = errNote("dedupe check failed (ignored)", err)
    }
  }

  return { status: "ready", flags, note }
}

/** Process an IMAGE: decode-guard, EXIF read+strip, thumbnail, phash, NSFW + dedupe. Never throws. */
async function processImageBytes(
  bytes: Uint8Array,
  deps: ProcessDeps,
  selfAssetId?: string,
): Promise<MediaProcessResult> {
  let img: Awaited<ReturnType<typeof processImage>>
  try {
    img = await processImage(bytes, deps.limits)
  } catch (err) {
    return rejected(errNote("image decode/guard failed", err))
  }

  // Perceptual hash from normalized pixels. A hash failure is non-fatal: proceed without dedupe.
  let phash: string | null = null
  try {
    phash = await perceptualHash(bytes, deps.limits)
  } catch {
    phash = null
  }

  const seam = await applyAbuseSeams(bytes, phash, deps, selfAssetId)

  return {
    status: seam.status,
    width: img.meta.width,
    height: img.meta.height,
    codec: null,
    phash,
    processedBytes: img.strippedBytes,
    processedContentType: img.strippedContentType,
    thumbnailBytes: img.thumbnailBytes,
    thumbnailContentType: img.thumbnailContentType,
    exifGps: img.exifGps,
    flags: seam.flags,
    note: seam.note,
  }
}

/** Process a VIDEO: ffprobe validate, remux strip, thumbnail grab, NSFW. Never throws. */
async function processVideoBytes(
  bytes: Uint8Array,
  deps: ProcessDeps,
): Promise<MediaProcessResult> {
  // 1) Probe the REAL bytes. Reject anything ffprobe cannot read as a video.
  let probe: Awaited<ReturnType<typeof probeBytes>>
  try {
    probe = await probeBytes(bytes, deps.limits)
  } catch (err) {
    return rejected(errNote("ffprobe failed", err))
  }
  if (!probe.isVideo) {
    return rejected("not a video (no video stream)")
  }
  if (probe.codec === null || !ALLOWED_VIDEO_CODECS.has(probe.codec.toLowerCase())) {
    return rejected(`unsupported codec: ${probe.codec ?? "unknown"}`)
  }
  if (probe.durationSec <= 0 || probe.durationSec > deps.limits.maxVideoDurationSec) {
    return rejected(
      `duration ${probe.durationSec}s outside (0, ${deps.limits.maxVideoDurationSec}]`,
    )
  }
  if (bytes.byteLength > deps.limits.maxDownloadBytes) {
    return rejected(`video ${bytes.byteLength} bytes exceeds cap ${deps.limits.maxDownloadBytes}`)
  }

  // 2) Stream-copy remux to strip location/metadata (no transcode). Reject if even the remux fails.
  let remuxed: Buffer
  try {
    remuxed = await remuxStripMetadata(bytes, deps.limits)
  } catch (err) {
    return rejected(errNote("remux failed", err))
  }

  // 3) Thumbnail frame -> normalize through the image path (strip + downsize). A thumbnail failure is
  //    non-fatal (we still publish the video), so it is best-effort.
  let thumbnailBytes: Buffer | null = null
  let thumbnailContentType: string | null = null
  try {
    const at = Math.min(1, probe.durationSec / 2)
    const frame = await grabFrameJpeg(bytes, at, deps.limits)
    const thumb = await processImage(frame, deps.limits)
    thumbnailBytes = thumb.thumbnailBytes
    thumbnailContentType = thumb.thumbnailContentType
  } catch {
    thumbnailBytes = null
    thumbnailContentType = null
  }

  // 4) NSFW seam over the source bytes (dedupe does not apply to video here; no perceptual hash).
  const seam = await applyAbuseSeams(bytes, null, deps)

  return {
    status: seam.status,
    width: probe.width,
    height: probe.height,
    codec: probe.codec.toLowerCase(),
    phash: null,
    processedBytes: remuxed,
    processedContentType: "video/mp4",
    thumbnailBytes,
    thumbnailContentType,
    exifGps: null,
    flags: seam.flags,
    note: seam.note,
  }
}

/**
 * PURE-ish core: process `input.bytes` per `input.kind`. NEVER throws; any failure becomes a rejected
 * result. Storage/DB-free so it is unit-testable with crafted bytes + a FakeAbuseChecks.
 */
export async function processMedia(
  input: ProcessInput,
  deps: ProcessDeps,
): Promise<MediaProcessResult> {
  try {
    if (input.bytes.byteLength === 0) {
      return rejected("empty input")
    }
    if (input.bytes.byteLength > deps.limits.maxDownloadBytes) {
      return rejected(
        `input ${input.bytes.byteLength} bytes exceeds cap ${deps.limits.maxDownloadBytes}`,
      )
    }
    if (input.kind === "image") {
      return await processImageBytes(input.bytes, deps, input.selfAssetId)
    }
    return await processVideoBytes(input.bytes, deps)
  } catch (err) {
    // Absolute backstop: even an unexpected error in the dispatch logic must not throw.
    return rejected(errNote("unexpected processing error", err))
  }
}

// ---------------------------------------------------------------------------
// Orchestration layer (loads, downloads, persists). Registered by the worker.
// ---------------------------------------------------------------------------

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
 * Race a promise against the per-job wall-clock budget (P2-1). The per-tool timeouts (ffprobe/ffmpeg/
 * image) bound each step; this bounds the SUM, so a crafted asset that chains many near-budget steps
 * cannot exceed the documented jobTimeoutMs. On expiry it rejects with JobTimeoutError; the orchestrator
 * maps that to a safe "rejected" terminal status. The timer is unref'd + cleared so it never keeps the
 * worker alive. Note: the underlying child processes are independently SIGKILL-bounded by their own
 * per-tool timeouts, so this wall-clock guard is a belt over those suspenders.
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
   * Self-aware near-duplicate lookup over media_assets.phash. The orchestrator passes the processing
   * asset's id as excludeAssetId so a re-delivered job does not flag the asset a duplicate of itself
   * (P0-2). Optional: when omitted, processMedia falls back to abuseChecks.isNearDuplicate.
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

/** Derive the processed-object key from the source key (keep it adjacent, mark it processed). */
function processedKey(r2Key: string, kind: MediaKind): string {
  const ext = kind === "video" ? "mp4" : "img"
  return `processed/${r2Key}.${ext}`
}

/** Derive the thumbnail key from the source key. */
function thumbnailKey(r2Key: string): string {
  return `thumbs/${r2Key}.jpg`
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

/**
 * Run the full media.checks job for one payload. NEVER throws (so a single bad asset can never crash
 * the worker or poison the queue); always resolves after recording a terminal status. Returns the
 * final status for observability/tests.
 */
export async function runMediaChecksJob(
  payload: MediaChecksPayload,
  deps: MediaChecksDeps,
): Promise<MediaStatus> {
  const log =
    deps.log ?? ((line: string, extra?: Record<string, unknown>) => console.log(line, extra ?? {}))
  const report = deps.report ?? (() => {})

  // Locate the row. Prefer mediaId; fall back to uploadId (the singletonKey) if the id moved.
  let asset: MediaWorkerAsset | null = null
  try {
    asset = await deps.repo.findById(payload.mediaId)
    if (!asset) asset = await deps.repo.findByUploadId(payload.uploadId)
  } catch (err) {
    // A DB read failure is infra, not untrusted input: report and complete (pg-boss will not retry a
    // completed job; the orphan sweep / a re-finalize covers a truly stuck row).
    report(err, { job: "media.checks", phase: "load", uploadId: payload.uploadId })
    log("media.checks: failed to load asset", { uploadId: payload.uploadId, err: String(err) })
    return "rejected"
  }
  if (!asset) {
    log("media.checks: asset not found (already swept?)", { uploadId: payload.uploadId })
    return "rejected"
  }

  // Download + process under the OVERALL per-job wall-clock budget (P2-1). The download is capped by
  // size and the per-tool steps inside processMedia have their own timeouts; this bounds their SUM so a
  // crafted asset cannot chain near-budget steps past the documented jobTimeoutMs. A download failure or
  // a wall-clock timeout is a safe "rejected" terminal status (the job still completes; never throws out).
  let result: MediaProcessResult
  try {
    result = await withJobTimeout(
      (async () => {
        const bytes = await deps.download(asset.r2Key, deps.limits.maxDownloadBytes)
        // Pass the asset id (selfAssetId) so the dedupe lookup excludes this asset's own row (P0-2), and
        // forward the self-aware lookup so processMedia uses it over the plain isNearDuplicate.
        return processMedia(
          { bytes, kind: asset.kind, selfAssetId: asset.id },
          {
            abuseChecks: deps.abuseChecks,
            limits: deps.limits,
            ...(deps.findPhashDuplicate ? { findPhashDuplicate: deps.findPhashDuplicate } : {}),
          },
        )
      })(),
      deps.limits.jobTimeoutMs,
    )
  } catch (err) {
    if (err instanceof JobTimeoutError) {
      report(err, { job: "media.checks", phase: "timeout", mediaId: asset.id })
    }
    await persistRejection(asset, deps, errNote("download/process failed", err), report)
    return "rejected"
  }

  // PHASE-1 EXIF GPS DEFERRAL (privacy decision): processMedia reads result.exifGps from the ORIGINAL
  // bytes purely to STRIP it (the published image is metadata-free). We deliberately do NOT persist that
  // raw fix: storing a user's original device coordinates - even just to power the anon hold-release
  // cross-check - would reintroduce exactly the location data the strip removes. The submit-time IP-geo
  // GPS sanity (AbuseChecks.gpsPlausible) already runs for anon submits, so the hold-release EXIF
  // cross-check is a documented Phase-1 deferral (it reads exifGeo as null and treats "no signal" as
  // passing; see anon-hold-release.ts + anon-hold-release-repo.drizzle.findMedia). If a future phase
  // wants it, the privacy-preserving shape is a single boolean column (e.g. exif_gps_far) computed HERE
  // by comparing result.exifGps to the report geom, never the coordinates themselves. We log the read so
  // it is observable, but it leaves the worker only as a yes/no in logs, not as stored data.
  const patch: MediaResultPatch = {
    status: result.status,
    codec: result.codec,
    width: result.width,
    height: result.height,
    phash: result.phash,
  }

  try {
    if (result.status !== "rejected" && result.processedBytes) {
      const pKey = processedKey(asset.r2Key, asset.kind)
      await deps.storage.put(pKey, result.processedBytes, {
        ...(result.processedContentType !== null
          ? { contentType: result.processedContentType }
          : {}),
      })
      // The stripped/remuxed object is written to a NEW key (processed/...). We intentionally leave
      // media_assets.r2_key pointing at the original validated upload so the row never references a
      // not-yet-written object mid-flight; downstream readers use r2_key, and the processed/thumb keys
      // are derivable. byteSize is re-measured from the processed object.
      patch.byteSize = result.processedBytes.byteLength

      if (result.thumbnailBytes) {
        const tKey = thumbnailKey(asset.r2Key)
        await deps.storage.put(tKey, result.thumbnailBytes, {
          ...(result.thumbnailContentType !== null
            ? { contentType: result.thumbnailContentType }
            : {}),
        })
        patch.thumbKey = tKey
      }
    }

    await deps.repo.applyResult(asset.id, patch)

    // Raise any abuse flags (nsfw / phash_dup). Best-effort: a flag-insert failure is logged, not fatal.
    for (const flag of result.flags) {
      try {
        await deps.repo.insertAbuseFlag({ subjectId: asset.id, reason: flag.reason })
      } catch (err) {
        log("media.checks: failed to insert abuse_flag", {
          mediaId: asset.id,
          reason: flag.reason,
          err: String(err),
        })
      }
    }
  } catch (err) {
    // Persisting the SUCCESS path failed (storage/DB). Fall back to a rejection so the row is terminal
    // and consistent, and report it.
    report(err, { job: "media.checks", phase: "persist", mediaId: asset.id })
    await persistRejection(asset, deps, errNote("persist failed", err), report)
    return "rejected"
  }

  if (result.status === "rejected") {
    // A rejection from untrusted input: log + report so it is visible, but the job still completes.
    log("media.checks: rejected", { mediaId: asset.id, kind: asset.kind, note: result.note })
    report(new Error(result.note ?? "media rejected"), {
      job: "media.checks",
      mediaId: asset.id,
      kind: asset.kind,
    })
  } else if (result.status === "held") {
    log("media.checks: held", {
      mediaId: asset.id,
      note: result.note,
      flags: result.flags.map((f) => f.reason),
    })
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

/** Mark the asset rejected and best-effort raise nothing (rejections from bad bytes are not abuse). */
async function persistRejection(
  asset: MediaWorkerAsset,
  deps: MediaChecksDeps,
  note: string,
  report: (err: unknown, context?: Record<string, unknown>) => void,
): Promise<void> {
  try {
    await deps.repo.applyResult(asset.id, { status: "rejected" })
  } catch (err) {
    // Even the rejection write failed: this is infra. Report and swallow so the job still completes.
    report(err, { job: "media.checks", phase: "reject", mediaId: asset.id })
  }
  ;(deps.log ?? ((l: string, e?: Record<string, unknown>) => console.log(l, e ?? {})))(
    "media.checks: rejected",
    { mediaId: asset.id, note },
  )
  report(new Error(note), { job: "media.checks", mediaId: asset.id, note })
}
