/**
 * PURE-ish decode/seam core of the media.checks pipeline.
 *
 * The contract: NO UNTRUSTED INPUT may throw out of here. Every outcome of processing attacker-controlled
 * BYTES is a MediaProcessResult (a terminal status + optional flags/note); the only throw a caller sees is
 * the absolute backstop being itself wrapped into a rejected result. This module is storage/DB-free so it
 * is directly assertable in tests with crafted bytes + a FakeAbuseChecks (the orchestrator in
 * media-checks.ts adds the load/download/persist around it).
 */

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
  processedBytes: Buffer | null
  processedContentType: string | null
  thumbnailBytes: Buffer | null
  thumbnailContentType: string | null
  /** GPS read from the ORIGINAL EXIF, kept for the report GPS cross-check note (images only). */
  exifGps: ExifGps | null
  flags: PipelineFlag[]
  /** Human-readable reason when status is rejected/held (for logs + GlitchTip). */
  note: string | null
}

export interface ProcessInput {
  bytes: Uint8Array
  kind: MediaKind
  /**
   * Excluded from the near-duplicate lookup so a re-delivered job (which recomputes the SAME phash on a
   * row that already has its phash persisted) never matches the asset against its OWN row (P0-2).
   */
  selfAssetId?: string
  /**
   * Excluded from the near-duplicate lookup so SIBLING photos of the SAME report are never flagged
   * duplicates of each other (#43 - dedupe is scoped CROSS-report only). Optional/nullable.
   */
  selfReportId?: string | null
}

export interface ProcessDeps {
  abuseChecks: AbuseChecks
  limits: WorkerLimits
  /**
   * Self-aware near-duplicate lookup (excludes the current asset via excludeAssetId). When provided it is
   * used INSTEAD of abuseChecks.isNearDuplicate (honoring the P0-2 self-exclusion); when omitted the
   * pipeline falls back to abuseChecks.isNearDuplicate (e.g. FakeAbuseChecks offline).
   */
  findPhashDuplicate?: FindPhashDuplicateFn
}

/** Build a rejected result with a note (keeps the safe-failure paths terse + consistent). */
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

/** Stringify an unknown error compactly for a note (no stack, ASCII-only). */
export function errNote(prefix: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return `${prefix}: ${msg}`.slice(0, 300)
}

/**
 * NSFW + near-duplicate seams over an already-validated asset; finalizes the status. Never throws.
 * NSFW fails CLOSED (a scoring error holds the asset for review). The near-duplicate seam is NON-blocking
 * (#43): a hit is detected/logged but never holds the asset and never raises a flag, and a dedupe outage
 * is treated as "not a duplicate" (fail open). Auto-holding a near-duplicate silently hid legitimate
 * report media (a `held` row is stripped from every reader's gallery and wedges anon hold-release), so a
 * cross-report perceptual match - overwhelmingly legitimate on a civic platform - falls through to `ready`.
 */
async function applyAbuseSeams(
  bytes: Uint8Array,
  phash: string | null,
  deps: ProcessDeps,
  selfAssetId?: string,
  selfReportId?: string | null,
): Promise<{ status: MediaStatus; flags: PipelineFlag[]; note: string | null }> {
  const flags: PipelineFlag[] = []
  let note: string | null = null

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

  if (phash !== null) {
    try {
      // Prefer the self-aware lookup (excludes THIS asset's own row, P0-2, and scopes CROSS-report, #43)
      // so the recorded note is accurate.
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

/** Process an IMAGE: decode-guard, EXIF read+strip, thumbnail, phash, NSFW + dedupe. Never throws. */
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

  // A phash failure is non-fatal: proceed without dedupe.
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

/** Process a VIDEO: ffprobe validate, remux strip, thumbnail grab, NSFW. Never throws. */
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

  // Thumbnail through the image path (strip + downsize); a failure is non-fatal (publish the video anyway).
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
      return await processImageBytes(input.bytes, deps, input.selfAssetId, input.selfReportId)
    }
    return await processVideoBytes(input.bytes, deps)
  } catch (err) {
    // Absolute backstop: even an unexpected error in the dispatch logic must not throw.
    return rejected(errNote("unexpected processing error", err))
  }
}
