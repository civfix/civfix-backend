/**
 * Media-worker limits, timeouts, and concurrency knobs.
 *
 * Every value here is a HARD safety bound on untrusted-byte processing. They are intentionally
 * centralized (not scattered across the sandbox wrappers) so the resource envelope is auditable in one
 * place and overridable by env for ops tuning. The container additionally caps CPU per the infra
 * compose file; these are the in-process belts to that suspenders.
 *
 * ASCII only. No vendor SDKs imported here.
 */

import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from "@civfix/shared"

/** Parse "1"/"true"/"yes"/"on" (case-insensitive) as true; otherwise the fallback. */
export function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())
}

/** Parse a positive integer env value, falling back when blank/invalid. */
function parsePosInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export interface WorkerLimits {
  /** Hard cap on bytes downloaded from storage for a single asset. Abort if the object is larger. */
  maxDownloadBytes: number
  /** Cap on decoded image pixels handed to sharp (decode-bomb guard). */
  maxImagePixels: number
  /** sharp pixel-limit ceiling: refuse to even start decoding above this many pixels. */
  sharpPixelLimit: number
  /** Max bytes any sandboxed child process may emit on a pipe (execa maxBuffer). */
  maxChildOutputBytes: number
  /** Per-call timeout for ffprobe (ms). */
  ffprobeTimeoutMs: number
  /** Per-call timeout for an ffmpeg remux/thumbnail (ms). */
  ffmpegTimeoutMs: number
  /** Per-call timeout for the sharp image pipeline (ms). */
  imageTimeoutMs: number
  /** Overall per-job wall-clock budget for processMedia (ms). */
  jobTimeoutMs: number
  /** Longest video we accept, in seconds. */
  maxVideoDurationSec: number
  /** Thumbnail longest edge, in pixels. */
  thumbnailMaxEdge: number
  /** NSFW score at/above which an asset is held. */
  nsfwHoldThreshold: number
  /** Concurrency for the media.checks queue (parallel jobs per worker process). */
  mediaChecksConcurrency: number
  /** TTL (ms) after which a never-attached (report_id null) media row is an orphan. */
  orphanTtlMs: number
  /** Max orphan rows reaped per sweep run. */
  orphanSweepBatch: number
}

/** Kill signal used when a sandboxed child exceeds its timeout. SIGKILL is non-catchable. */
export const CHILD_KILL_SIGNAL = "SIGKILL" as const

/** Allowed video codecs (ffprobe codec_name). h265 is reported as "hevc" by ffprobe. */
export const ALLOWED_VIDEO_CODECS: ReadonlySet<string> = new Set(["h264", "hevc"])

const ONE_MB = 1024 * 1024

/** Build the limits from env (with safe defaults). Pure; call once at startup or per test. */
export function loadLimits(source: NodeJS.ProcessEnv = process.env): WorkerLimits {
  return {
    // Never download more than the largest accepted media (video cap) plus a small slop for container
    // overhead is unnecessary: we cap exactly at MAX_VIDEO_BYTES and reject anything larger.
    maxDownloadBytes: parsePosInt(source.MEDIA_MAX_DOWNLOAD_BYTES, MAX_VIDEO_BYTES),
    // ~24 MP: comfortably above a 15 MB photo's real pixel count but well below a decode bomb.
    maxImagePixels: parsePosInt(source.MEDIA_MAX_IMAGE_PIXELS, 24_000_000),
    sharpPixelLimit: parsePosInt(source.MEDIA_SHARP_PIXEL_LIMIT, 32_000_000),
    maxChildOutputBytes: parsePosInt(source.MEDIA_MAX_CHILD_OUTPUT_BYTES, MAX_VIDEO_BYTES + ONE_MB),
    ffprobeTimeoutMs: parsePosInt(source.MEDIA_FFPROBE_TIMEOUT_MS, 10_000),
    ffmpegTimeoutMs: parsePosInt(source.MEDIA_FFMPEG_TIMEOUT_MS, 30_000),
    imageTimeoutMs: parsePosInt(source.MEDIA_IMAGE_TIMEOUT_MS, 15_000),
    jobTimeoutMs: parsePosInt(source.MEDIA_JOB_TIMEOUT_MS, 60_000),
    maxVideoDurationSec: parsePosInt(source.MEDIA_MAX_VIDEO_DURATION_SEC, 30),
    thumbnailMaxEdge: parsePosInt(source.MEDIA_THUMBNAIL_MAX_EDGE, 400),
    nsfwHoldThreshold: clampUnit(source.MEDIA_NSFW_HOLD_THRESHOLD, 0.8),
    mediaChecksConcurrency: parsePosInt(source.MEDIA_CHECKS_CONCURRENCY, 2),
    orphanTtlMs: parsePosInt(source.MEDIA_ORPHAN_TTL_MS, 24 * 60 * 60 * 1000),
    orphanSweepBatch: parsePosInt(source.MEDIA_ORPHAN_SWEEP_BATCH, 200),
  }
}

/** Parse a 0..1 float from env, clamped; fall back when blank/invalid. */
function clampUnit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number.parseFloat(raw.trim())
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

/** Re-export the shared byte caps so worker code has one import site for limits. */
export { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES }

/** Cron expressions for the scheduled maintenance jobs (UTC; pg-boss uses node-cron syntax). */
export const ORPHAN_SWEEP_CRON = "17 * * * *" // hourly at :17 (off the top of the hour)
export const CHAT_PARTITION_CRON = "0 3 28 * *" // 03:00 UTC on the 28th, before month rollover
