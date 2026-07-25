
import type { AbuseChecks } from "@civfix/shared/interfaces"
import type { MediaKind, MediaStatus } from "@civfix/shared"
import type { WorkerAbuseReason } from "@civfix/api/media-repo"
import type { FindPhashDuplicateFn } from "@civfix/api/adapters/abuse-checks"
import type { WorkerLimits } from "../config.js"
import { ALLOWED_VIDEO_CODECS } from "../config.js"
import { processImage, type ExifGps } from "../sandbox/image.js"
import { perceptualHash } from "../sandbox/phash.js"
import { probeBytes } from "../sandbox/ffprobe.js"
import { grabFrameJpeg, remuxStripMetadata } from "../sandbox/ffmpeg-remux.js"

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

export function rejected(note: string): MediaProcessResult {
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
  return `${prefix}: ${msg}`.slice(0, 300)
}

/**
 * True when the AbuseChecks implementation actually has a working NSFW verdict (M9).
 *
 * RealAbuseChecks exposes `hasNsfwScorer()`; the interface does not, so this is a structural probe. An
 * implementation WITHOUT the method (the fakes) is treated as scored: a fake returns a deliberate,
 * deterministic verdict, which is a verdict. Only the real adapter can be in the "configured to score,
 * nothing wired" state that M9 is about.
 */
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

  // M9: a score of 0 from an UNCONFIGURED scorer is "no verdict", not "benign". Detect that case up
  // front so the outcome is driven by policy instead of silently auto-approving. `hasNsfwScorer` is
  // present on RealAbuseChecks; a seam implementation without it (the fakes) is treated as scored,
  // which is correct — a fake explicitly returns a real, deterministic verdict.
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
    return { status: "held", flags: [{ reason: "nsfw" }], note: `nsfw score ${nsfw.toFixed(3)}` }
  }
  if (!scorerAvailable) {
    // No model configured. Either fail closed (hold for operator review) or publish but make the gap
    // VISIBLE by raising the flag anyway, so the moderation queue receives the asset instead of the
    // absence of a model being an invisible auto-approve. See WorkerLimits.nsfwUnscoredPolicy.
    const unscored = "nsfw scorer not configured (no verdict)"
    if (deps.limits.nsfwUnscoredPolicy === "hold") {
      return { status: "held", flags: [{ reason: "nsfw" }], note: `${unscored}; held for review` }
    }
    flags.push({ reason: "nsfw" })
    note = `${unscored}; flagged for review`
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
  let img: Awaited<ReturnType<typeof processImage>>
  try {
    img = await processImage(bytes, deps.limits)
  } catch (err) {
    return rejected(errNote("image decode/guard failed", err))
  }

  let phash: string | null = null
  try {
    phash = await perceptualHash(bytes, deps.limits)
  } catch {
    phash = null
  }

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

async function processVideoBytes(
  bytes: Uint8Array,
  deps: ProcessDeps,
): Promise<MediaProcessResult> {
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

  let remuxed: Buffer
  try {
    remuxed = await remuxStripMetadata(bytes, deps.limits)
  } catch (err) {
    return rejected(errNote("remux failed", err))
  }

  let frameJpeg: Buffer | null = null
  try {
    const at = Math.min(1, probe.durationSec / 2)
    frameJpeg = await grabFrameJpeg(bytes, at, deps.limits)
  } catch {
    frameJpeg = null
  }

  let thumbnailBytes: Buffer | null = null
  let thumbnailContentType: string | null = null
  if (frameJpeg) {
    try {
      const thumb = await processImage(frameJpeg, deps.limits)
      thumbnailBytes = thumb.thumbnailBytes
      thumbnailContentType = thumb.thumbnailContentType
    } catch {
      thumbnailBytes = null
      thumbnailContentType = null
    }
  }

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
    processedContentType: "video/mp4",
    thumbnailBytes,
    thumbnailContentType,
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
    return rejected(errNote("unexpected processing error", err))
  }
}
