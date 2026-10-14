import type { AbuseChecks } from "@civfix/shared/interfaces"
import type { MediaKind, MediaStatus } from "@civfix/shared"
import type { WorkerAbuseReason } from "@civfix/api/media-worker-repository"
import type { FindPhashDuplicateFn } from "@civfix/api/adapters/abuse-checks"
import type { WorkerLimits } from "../config.js"
import { ALLOWED_VIDEO_CODECS } from "../config.js"
import type { ExifGps } from "../sandbox/image.js"
import { processImageLane } from "../sandbox/image-lane.js"
import { SandboxSpawnError } from "../sandbox/exec.js"
import { ScratchSetupError } from "../sandbox/tmp.js"
import { probeBytes } from "../sandbox/ffprobe.js"
import { grabFrameJpeg, remuxStripMetadata } from "../sandbox/ffmpeg-remux.js"

const MAX_NOTE_CHARS = 300
const REMUXED_VIDEO_CONTENT_TYPE = "video/mp4"
const FRAME_GRAB_MAX_OFFSET_SEC = 1
const NSFW_SCORE_DIGITS = 3

export interface PipelineFlag {
  reason: WorkerAbuseReason
}

export interface MediaProcessResult {
  status: MediaStatus
  width: number | null
  height: number | null
  codec: string | null
  phash: string | null
  processedBytes: Buffer | null
  processedContentType: string | null
  thumbnailBytes: Buffer | null
  thumbnailContentType: string | null
  exifGps: ExifGps | null
  flags: PipelineFlag[]
  note: string | null
}

export interface ProcessInput {
  bytes: Uint8Array
  kind: MediaKind
  selfAssetId?: string
  selfReportId?: string | null
}

export interface ProcessDeps {
  abuseChecks: AbuseChecks
  limits: WorkerLimits
  findPhashDuplicate?: FindPhashDuplicateFn
}

// A decoder that could not start or a scratch dir the worker could not build says nothing about the
// bytes: these escape so media.checks retries them as infrastructure instead of rejecting the upload.
function isSandboxInfraFailure(err: unknown): err is SandboxSpawnError | ScratchSetupError {
  return err instanceof SandboxSpawnError || err instanceof ScratchSetupError
}

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

export function errNote(prefix: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return `${prefix}: ${msg}`.slice(0, MAX_NOTE_CHARS)
}

function hasNsfwScorer(checks: unknown): boolean {
  const probe = checks as { hasNsfwScorer?: () => boolean }
  return typeof probe.hasNsfwScorer === "function" ? probe.hasNsfwScorer() : true
}

async function applyAbuseSeams(
  bytes: Uint8Array,
  phash: string | null,
  deps: ProcessDeps,
  selfAssetId?: string,
  selfReportId?: string | null,
): Promise<{ status: MediaStatus; flags: PipelineFlag[]; note: string | null }> {
  const flags: PipelineFlag[] = []
  let note: string | null = null

  const scorerAvailable = hasNsfwScorer(deps.abuseChecks)

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
  if (scorerAvailable && nsfw >= deps.limits.nsfwHoldThreshold) {
    return {
      status: "held",
      flags: [{ reason: "nsfw" }],
      note: `nsfw score ${nsfw.toFixed(NSFW_SCORE_DIGITS)}`,
    }
  }
  if (!scorerAvailable) {
    const unscored = "nsfw scorer not configured (no verdict)"
    if (deps.limits.nsfwUnscoredPolicy === "hold") {
      return { status: "held", flags: [{ reason: "nsfw" }], note: `${unscored}; held for review` }
    }
    note = `${unscored}; published without a blocking flag`
  }

  if (phash !== null) {
    try {
      const dup = deps.findPhashDuplicate
        ? await deps.findPhashDuplicate(phash, {
            excludeAssetId: selfAssetId,
            ...(selfReportId != null ? { excludeReportId: selfReportId } : {}),
          })
        : await deps.abuseChecks.isNearDuplicate(phash)
      if (dup.dup) {
        note = `near-duplicate of ${dup.ofReportId ?? "unknown"} (allowed, not held)`
      }
    } catch (err) {
      note = errNote("dedupe check failed (ignored)", err)
    }
  }

  return { status: "ready", flags, note }
}

async function processImageBytes(
  bytes: Uint8Array,
  deps: ProcessDeps,
  selfAssetId?: string,
  selfReportId?: string | null,
): Promise<MediaProcessResult> {
  let img: Awaited<ReturnType<typeof processImageLane>>
  try {
    img = await processImageLane(bytes, deps.limits)
  } catch (err) {
    if (isSandboxInfraFailure(err)) throw err
    return rejected(errNote("image decode/guard failed", err))
  }
  const phash = img.phash

  const seam = await applyAbuseSeams(bytes, phash, deps, selfAssetId, selfReportId)

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

function videoLimitNote(
  probe: {
    durationSec: number
    width: number | null
    height: number | null
    fps: number | null
    bitrateBps: number | null
  },
  limits: WorkerLimits,
): string | null {
  if (probe.durationSec <= 0 || probe.durationSec > limits.maxVideoDurationSec) {
    return `duration ${probe.durationSec}s outside (0, ${limits.maxVideoDurationSec}]`
  }
  const { width, height } = probe
  if (width === null || height === null || width <= 0 || height <= 0) {
    return "video reports no usable resolution"
  }
  const pixels = width * height
  if (pixels > limits.maxVideoPixels) {
    return `resolution ${width}x${height} (${pixels}px) exceeds the cap of ${limits.maxVideoPixels}px`
  }
  if (probe.fps !== null && probe.fps > limits.maxVideoFps) {
    return `frame rate ${probe.fps.toFixed(2)}fps exceeds the cap of ${limits.maxVideoFps}fps`
  }
  if (probe.bitrateBps !== null && probe.bitrateBps > limits.maxVideoBitrateBps) {
    return `bitrate ${probe.bitrateBps}bps exceeds the cap of ${limits.maxVideoBitrateBps}bps`
  }
  return null
}

type VideoProbe = Awaited<ReturnType<typeof probeBytes>>

// A frame that cannot be grabbed is no verdict on the video: without one it is held for review, not rejected.
async function grabPosterFrame(
  bytes: Uint8Array,
  durationSec: number,
  limits: WorkerLimits,
): Promise<Buffer | null> {
  try {
    return await grabFrameJpeg(bytes, Math.min(FRAME_GRAB_MAX_OFFSET_SEC, durationSec / 2), limits)
  } catch (err) {
    if (isSandboxInfraFailure(err)) throw err
    return null
  }
}

async function posterThumbnail(
  frameJpeg: Buffer | null,
  limits: WorkerLimits,
): Promise<{ thumbnailBytes: Buffer | null; thumbnailContentType: string | null }> {
  const none = { thumbnailBytes: null, thumbnailContentType: null }
  if (!frameJpeg) return none
  try {
    const thumb = await processImageLane(frameJpeg, limits)
    return {
      thumbnailBytes: thumb.thumbnailBytes,
      thumbnailContentType: thumb.thumbnailContentType,
    }
  } catch (err) {
    if (isSandboxInfraFailure(err)) throw err
    return none
  }
}

async function processVideoBytes(
  bytes: Uint8Array,
  deps: ProcessDeps,
): Promise<MediaProcessResult> {
  let probe: VideoProbe
  try {
    probe = await probeBytes(bytes, deps.limits)
  } catch (err) {
    if (isSandboxInfraFailure(err)) throw err
    return rejected(errNote("ffprobe failed", err))
  }
  if (!probe.isVideo) {
    return rejected("not a video (no video stream)")
  }
  if (probe.codec === null || !ALLOWED_VIDEO_CODECS.has(probe.codec.toLowerCase())) {
    return rejected(`unsupported codec: ${probe.codec ?? "unknown"}`)
  }
  const limitNote = videoLimitNote(probe, deps.limits)
  if (limitNote !== null) {
    return rejected(limitNote)
  }

  let remuxed: Buffer
  try {
    remuxed = await remuxStripMetadata(bytes, deps.limits)
  } catch (err) {
    if (isSandboxInfraFailure(err)) throw err
    return rejected(errNote("remux failed", err))
  }

  const frameJpeg = await grabPosterFrame(bytes, probe.durationSec, deps.limits)
  const thumbnail = await posterThumbnail(frameJpeg, deps.limits)

  const seam = frameJpeg
    ? await applyAbuseSeams(frameJpeg, null, deps)
    : {
        status: "held" as MediaStatus,
        flags: [{ reason: "nsfw" as WorkerAbuseReason }],
        note: "nsfw scoring failed (held): no decodable frame extracted from video",
      }

  return {
    status: seam.status,
    width: probe.width,
    height: probe.height,
    codec: probe.codec.toLowerCase(),
    phash: null,
    processedBytes: remuxed,
    processedContentType: REMUXED_VIDEO_CONTENT_TYPE,
    thumbnailBytes: thumbnail.thumbnailBytes,
    thumbnailContentType: thumbnail.thumbnailContentType,
    exifGps: null,
    flags: seam.flags,
    note: seam.note,
  }
}

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
      return await processImageBytes(input.bytes, deps, input.selfAssetId, input.selfReportId)
    }
    return await processVideoBytes(input.bytes, deps)
  } catch (err) {
    if (isSandboxInfraFailure(err)) throw err
    return rejected(errNote("unexpected processing error", err))
  }
}
