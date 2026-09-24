import { dirname, join } from "node:path"
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
  maxToolStdoutBytes: number
  ffprobeTimeoutMs: number
  ffmpegTimeoutMs: number
  imageTimeoutMs: number
  jobTimeoutMs: number
  maxVideoDurationSec: number
  maxVideoPixels: number
  maxVideoFps: number
  maxVideoBitrateBps: number
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

export interface SandboxIdentity {
  uid: number
  gid: number
}

function parseId(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null
  const n = Number.parseInt(raw.trim(), 10)
  return Number.isInteger(n) && n > 0 ? n : null
}

export function loadSandboxIdentity(
  source: NodeJS.ProcessEnv = process.env,
): SandboxIdentity | null {
  const uid = parseId(source.MEDIA_SANDBOX_UID)
  const gid = parseId(source.MEDIA_SANDBOX_GID)
  if (uid !== null && gid !== null) return { uid, gid }
  if (uid !== null || gid !== null) {
    throw new Error(
      "media-worker: MEDIA_SANDBOX_UID and MEDIA_SANDBOX_GID must be set together (both positive " +
        "integers naming the unprivileged account the media decoders run as)",
    )
  }
  if (source.NODE_ENV === "production") {
    throw new Error(
      "media-worker: MEDIA_SANDBOX_UID / MEDIA_SANDBOX_GID are required in production - the media " +
        "decoders must not run as the uid that holds DATABASE_URL and the R2 credentials. The image " +
        "provisions uid/gid 1001 (mediatools) and compose sets both variables.",
    )
  }
  return null
}

export function loadImageLaneEntry(source: NodeJS.ProcessEnv = process.env): string {
  const configured = (source.MEDIA_IMAGE_LANE_ENTRY ?? "").trim()
  if (configured) return configured
  const entry = process.argv[1]
  const dir = entry === undefined ? process.cwd() : dirname(entry)
  return join(dir, "image-lane.js")
}

export function loadHttpsProxy(source: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (source.HTTPS_PROXY ?? source.https_proxy ?? "").trim()
  return raw.length > 0 ? raw : null
}

export const ALLOWED_VIDEO_CODECS: ReadonlySet<string> = new Set(["h264", "hevc"])

const ONE_MB = 1024 * 1024

const IMAGE_LANE_SPAWN_OVERHEAD_MS = 5_000

// The child bounds metadata, strip + thumbnail, and the perceptual hash by imageTimeoutMs EACH and runs them
// in sequence, so killing it at a single imageTimeoutMs rejected (and deleted) slow but legitimate photos.
const IMAGE_LANE_TIMED_PHASES = 3

export function imageLaneTimeoutMs(limits: Pick<WorkerLimits, "imageTimeoutMs">): number {
  return IMAGE_LANE_TIMED_PHASES * limits.imageTimeoutMs + IMAGE_LANE_SPAWN_OVERHEAD_MS
}

// The lane must be killed inside the processing phase's job budget: a lane still running when that budget
// fires surfaces as a JobTimeoutError, which media.checks retries as infra instead of rejecting the bytes,
// so a slow hostile image would be retried rather than refused.
function assertImageLaneFitsJobBudget(limits: WorkerLimits): void {
  const laneMs = imageLaneTimeoutMs(limits)
  if (laneMs < limits.jobTimeoutMs) return
  throw new Error(
    `media-worker: MEDIA_IMAGE_TIMEOUT_MS=${limits.imageTimeoutMs} gives an image lane budget of ` +
      `${laneMs}ms (${IMAGE_LANE_TIMED_PHASES} phases + ${IMAGE_LANE_SPAWN_OVERHEAD_MS}ms spawn overhead), ` +
      `which must stay below MEDIA_JOB_TIMEOUT_MS=${limits.jobTimeoutMs}. Lower the image timeout or ` +
      "raise the job timeout.",
  )
}

export function loadLimits(source: NodeJS.ProcessEnv = process.env): WorkerLimits {
  const limits: WorkerLimits = {
    maxDownloadBytes: parsePosInt(source.MEDIA_MAX_DOWNLOAD_BYTES, MAX_VIDEO_BYTES),
    maxImagePixels: parsePosInt(source.MEDIA_MAX_IMAGE_PIXELS, 24_000_000),
    sharpPixelLimit: parsePosInt(source.MEDIA_SHARP_PIXEL_LIMIT, 32_000_000),
    maxChildOutputBytes: parsePosInt(source.MEDIA_MAX_CHILD_OUTPUT_BYTES, MAX_VIDEO_BYTES + ONE_MB),
    maxToolStdoutBytes: parsePosInt(source.MEDIA_MAX_TOOL_STDOUT_BYTES, ONE_MB),
    ffprobeTimeoutMs: parsePosInt(source.MEDIA_FFPROBE_TIMEOUT_MS, 10_000),
    ffmpegTimeoutMs: parsePosInt(source.MEDIA_FFMPEG_TIMEOUT_MS, 30_000),
    imageTimeoutMs: parsePosInt(source.MEDIA_IMAGE_TIMEOUT_MS, 15_000),
    jobTimeoutMs: parsePosInt(source.MEDIA_JOB_TIMEOUT_MS, 90_000),
    maxVideoDurationSec: parsePosInt(source.MEDIA_MAX_VIDEO_DURATION_SEC, 30),
    maxVideoPixels: parsePosInt(source.MEDIA_VIDEO_MAX_PIXELS, 3840 * 2160),
    maxVideoFps: parsePosInt(source.MEDIA_VIDEO_MAX_FPS, 120),
    maxVideoBitrateBps: parsePosInt(source.MEDIA_VIDEO_MAX_BITRATE, 50_000_000),
    thumbnailMaxEdge: parsePosInt(source.MEDIA_THUMBNAIL_MAX_EDGE, 400),
    nsfwHoldThreshold: clampUnit(source.MEDIA_NSFW_HOLD_THRESHOLD, 0.8),
    nsfwUnscoredPolicy:
      source.MEDIA_UNSCORED_POLICY?.trim().toLowerCase() === "hold" ? "hold" : "flag",
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
  assertImageLaneFitsJobBudget(limits)
  return limits
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
