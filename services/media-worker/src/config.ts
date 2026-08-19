
import { MAX_VIDEO_BYTES } from "@civfix/shared"

export function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())
}

export function assertRealSeamInProd(
  source: NodeJS.ProcessEnv,
  flagKey: string,
  fakeEnabled: boolean,
  why: string,
): void {
  if (source.NODE_ENV !== "production" || !fakeEnabled) return
  throw new Error(`media-worker: ${flagKey} must be 0 in production - ${why}`)
}

function parsePosInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export interface WorkerLimits {
  maxDownloadBytes: number
  maxImagePixels: number
  sharpPixelLimit: number
  maxChildOutputBytes: number
  ffprobeTimeoutMs: number
  ffmpegTimeoutMs: number
  imageTimeoutMs: number
  jobTimeoutMs: number
  maxVideoDurationSec: number
  thumbnailMaxEdge: number
  nsfwHoldThreshold: number
  nsfwUnscoredPolicy: "flag" | "hold"
  mediaChecksConcurrency: number
  orphanTtlMs: number
  orphanSweepBatch: number
  orphanSweepMaxPages: number
  holdReleaseSweepBatch: number
  retentionSweepBatch: number
  retentionSweepMaxPages: number
  stuckMediaTtlMs: number
  stuckSweepBatch: number
  stuckSweepMaxAttempts: number
}

export const CHILD_KILL_SIGNAL = "SIGKILL" as const

export const ALLOWED_VIDEO_CODECS: ReadonlySet<string> = new Set(["h264", "hevc"])

const ONE_MB = 1024 * 1024

export function loadLimits(source: NodeJS.ProcessEnv = process.env): WorkerLimits {
  return {
    maxDownloadBytes: parsePosInt(source.MEDIA_MAX_DOWNLOAD_BYTES, MAX_VIDEO_BYTES),
    maxImagePixels: parsePosInt(source.MEDIA_MAX_IMAGE_PIXELS, 24_000_000),
    sharpPixelLimit: parsePosInt(source.MEDIA_SHARP_PIXEL_LIMIT, 32_000_000),
    maxChildOutputBytes: parsePosInt(source.MEDIA_MAX_CHILD_OUTPUT_BYTES, MAX_VIDEO_BYTES + ONE_MB),
    ffprobeTimeoutMs: parsePosInt(source.MEDIA_FFPROBE_TIMEOUT_MS, 10_000),
    ffmpegTimeoutMs: parsePosInt(source.MEDIA_FFMPEG_TIMEOUT_MS, 30_000),
    imageTimeoutMs: parsePosInt(source.MEDIA_IMAGE_TIMEOUT_MS, 15_000),
    jobTimeoutMs: parsePosInt(source.MEDIA_JOB_TIMEOUT_MS, 90_000),
    maxVideoDurationSec: parsePosInt(source.MEDIA_MAX_VIDEO_DURATION_SEC, 30),
    thumbnailMaxEdge: parsePosInt(source.MEDIA_THUMBNAIL_MAX_EDGE, 400),
    nsfwHoldThreshold: clampUnit(source.MEDIA_NSFW_HOLD_THRESHOLD, 0.8),
    nsfwUnscoredPolicy: source.MEDIA_UNSCORED_POLICY?.trim().toLowerCase() === "hold" ? "hold" : "flag",
    mediaChecksConcurrency: parsePosInt(source.MEDIA_CHECKS_CONCURRENCY, 2),
    orphanTtlMs: parsePosInt(source.MEDIA_ORPHAN_TTL_MS, 6 * 60 * 60 * 1000),
    orphanSweepBatch: parsePosInt(source.MEDIA_ORPHAN_SWEEP_BATCH, 1000),
    orphanSweepMaxPages: parsePosInt(source.MEDIA_ORPHAN_SWEEP_MAX_PAGES, 50),
    holdReleaseSweepBatch: parsePosInt(source.MEDIA_HOLD_RELEASE_SWEEP_BATCH, 200),
    retentionSweepBatch: parsePosInt(source.RETENTION_SWEEP_BATCH, 5000),
    retentionSweepMaxPages: parsePosInt(source.RETENTION_SWEEP_MAX_PAGES, 20),
    stuckMediaTtlMs: parsePosInt(source.MEDIA_STUCK_TTL_MS, 60 * 60 * 1000),
    stuckSweepBatch: parsePosInt(source.MEDIA_STUCK_SWEEP_BATCH, 500),
    stuckSweepMaxAttempts: parsePosInt(source.MEDIA_STUCK_SWEEP_MAX_ATTEMPTS, 5),
  }
}

function clampUnit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number.parseFloat(raw.trim())
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

export const ORPHAN_SWEEP_CRON = "17 * * * *"
export const CHAT_PARTITION_CRON = "23 3 * * *"
export const HOLD_RELEASE_SWEEP_CRON = "*/5 * * * *"
export const RETENTION_SWEEP_CRON = "37 4 * * *"
export const MEDIA_STUCK_SWEEP_CRON = "*/15 * * * *"
