import { dirname, join } from "node:path"
import { MAX_VIDEO_BYTES } from "@civfix/shared"
import { MS_PER_HOUR } from "@civfix/api/time"

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
  transcodeTimeoutMs: number
  transcodeThreads: number
  imageTimeoutMs: number
  jobTimeoutMs: number
  maxVideoDurationSec: number
  maxVideoPixels: number
  maxVideoEdge: number
  maxVideoFps: number
  maxVideoBitrateBps: number
  servedVideoMaxBitrateBps: number
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

const IMAGE_LANE_ENTRY_FILE = "image-lane.js"

export function loadImageLaneEntry(source: NodeJS.ProcessEnv = process.env): string {
  const configured = (source.MEDIA_IMAGE_LANE_ENTRY ?? "").trim()
  if (configured) return configured
  const entry = process.argv[1]
  const dir = entry === undefined ? process.cwd() : dirname(entry)
  return join(dir, IMAGE_LANE_ENTRY_FILE)
}

export function loadHttpsProxy(source: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (source.HTTPS_PROXY ?? source.https_proxy ?? "").trim()
  return raw.length > 0 ? raw : null
}

export const ALLOWED_VIDEO_CODECS: ReadonlySet<string> = new Set(["h264", "hevc"])

// The served copy of every upload. The image numbers are the ones the mobile app already compresses
// to, so a phone photo is re-encoded at the size it arrived in.
export const SERVED_IMAGE_MAX_EDGE = 1920
export const SERVED_IMAGE_JPEG_QUALITY = 80
export const SERVED_VIDEO_MAX_EDGE = 1280
export const SERVED_VIDEO_MAX_FPS = 30

// The decoders' -max_pixels guard. ffmpeg checks it against the frame buffer, whose width is rounded up
// to the SIMD stride (a 1080x1920 portrait clip allocates 1088x1920), so the accepted pixel cap itself
// would refuse a clip that passed it. Any frame within the long-edge cap both ways fits.
export function videoDecoderMaxPixels(limits: Pick<WorkerLimits, "maxVideoEdge">): number {
  return limits.maxVideoEdge * limits.maxVideoEdge
}

const ONE_MB = 1024 * 1024

const DEFAULT_LIMITS = {
  maxImagePixels: 24_000_000,
  sharpPixelLimit: 32_000_000,
  maxChildOutputBytes: MAX_VIDEO_BYTES + ONE_MB,
  maxToolStdoutBytes: ONE_MB,
  ffprobeTimeoutMs: 10_000,
  ffmpegTimeoutMs: 30_000,
  transcodeTimeoutMs: 90_000,
  transcodeThreads: 1,
  imageTimeoutMs: 15_000,
  jobTimeoutMs: 290_000,
  maxVideoDurationSec: 10,
  maxVideoPixels: 1920 * 1080,
  maxVideoEdge: 1920,
  maxVideoFps: 60,
  maxVideoBitrateBps: 20_000_000,
  servedVideoMaxBitrateBps: 4_000_000,
  thumbnailMaxEdge: 400,
  nsfwHoldThreshold: 0.8,
  mediaChecksConcurrency: 2,
  orphanTtlMs: 6 * MS_PER_HOUR,
  orphanSweepBatch: 1000,
  orphanSweepMaxPages: 50,
  holdReleaseSweepBatch: 200,
  retentionSweepBatch: 5000,
  retentionSweepMaxPages: 20,
  stuckMediaTtlMs: MS_PER_HOUR,
  stuckSweepBatch: 500,
  stuckSweepMaxAttempts: 5,
} as const

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

// The slowest accepted video, step by step inside one processing phase: probe, wait out the transcodes of
// the other jobs in this worker's batch (one runs at a time), transcode, probe the output, grab the poster
// frame, then the poster thumbnail through the image lane.
export function videoPathTimeoutMs(
  limits: Pick<
    WorkerLimits,
    | "ffprobeTimeoutMs"
    | "ffmpegTimeoutMs"
    | "transcodeTimeoutMs"
    | "imageTimeoutMs"
    | "mediaChecksConcurrency"
  >,
): number {
  return (
    2 * limits.ffprobeTimeoutMs +
    limits.mediaChecksConcurrency * limits.transcodeTimeoutMs +
    limits.ffmpegTimeoutMs +
    imageLaneTimeoutMs(limits)
  )
}

// A video whose tools all run to their own timeouts must still finish inside the processing budget: past
// it the job is retried as infra rather than settled, and the abandoned transcode keeps the one slot busy.
function assertVideoPathFitsJobBudget(limits: WorkerLimits): void {
  const pathMs = videoPathTimeoutMs(limits)
  if (pathMs < limits.jobTimeoutMs) return
  throw new Error(
    `media-worker: the slowest video path takes up to ${pathMs}ms (2 x MEDIA_FFPROBE_TIMEOUT_MS + ` +
      "MEDIA_CHECKS_CONCURRENCY x MEDIA_TRANSCODE_TIMEOUT_MS + MEDIA_FFMPEG_TIMEOUT_MS + the image lane), " +
      `which must stay below MEDIA_JOB_TIMEOUT_MS=${limits.jobTimeoutMs}. Lower those timeouts or ` +
      "raise the job timeout.",
  )
}

export function loadLimits(source: NodeJS.ProcessEnv = process.env): WorkerLimits {
  const limits: WorkerLimits = {
    maxDownloadBytes: parsePosInt(source.MEDIA_MAX_DOWNLOAD_BYTES, MAX_VIDEO_BYTES),
    maxImagePixels: parsePosInt(source.MEDIA_MAX_IMAGE_PIXELS, DEFAULT_LIMITS.maxImagePixels),
    sharpPixelLimit: parsePosInt(source.MEDIA_SHARP_PIXEL_LIMIT, DEFAULT_LIMITS.sharpPixelLimit),
    maxChildOutputBytes: parsePosInt(
      source.MEDIA_MAX_CHILD_OUTPUT_BYTES,
      DEFAULT_LIMITS.maxChildOutputBytes,
    ),
    maxToolStdoutBytes: parsePosInt(
      source.MEDIA_MAX_TOOL_STDOUT_BYTES,
      DEFAULT_LIMITS.maxToolStdoutBytes,
    ),
    ffprobeTimeoutMs: parsePosInt(source.MEDIA_FFPROBE_TIMEOUT_MS, DEFAULT_LIMITS.ffprobeTimeoutMs),
    ffmpegTimeoutMs: parsePosInt(source.MEDIA_FFMPEG_TIMEOUT_MS, DEFAULT_LIMITS.ffmpegTimeoutMs),
    transcodeTimeoutMs: parsePosInt(
      source.MEDIA_TRANSCODE_TIMEOUT_MS,
      DEFAULT_LIMITS.transcodeTimeoutMs,
    ),
    transcodeThreads: parsePosInt(source.MEDIA_TRANSCODE_THREADS, DEFAULT_LIMITS.transcodeThreads),
    imageTimeoutMs: parsePosInt(source.MEDIA_IMAGE_TIMEOUT_MS, DEFAULT_LIMITS.imageTimeoutMs),
    jobTimeoutMs: parsePosInt(source.MEDIA_JOB_TIMEOUT_MS, DEFAULT_LIMITS.jobTimeoutMs),
    maxVideoDurationSec: parsePosInt(
      source.MEDIA_MAX_VIDEO_DURATION_SEC,
      DEFAULT_LIMITS.maxVideoDurationSec,
    ),
    maxVideoPixels: parsePosInt(source.MEDIA_VIDEO_MAX_PIXELS, DEFAULT_LIMITS.maxVideoPixels),
    maxVideoEdge: parsePosInt(source.MEDIA_VIDEO_MAX_EDGE, DEFAULT_LIMITS.maxVideoEdge),
    maxVideoFps: parsePosInt(source.MEDIA_VIDEO_MAX_FPS, DEFAULT_LIMITS.maxVideoFps),
    maxVideoBitrateBps: parsePosInt(
      source.MEDIA_VIDEO_MAX_BITRATE,
      DEFAULT_LIMITS.maxVideoBitrateBps,
    ),
    servedVideoMaxBitrateBps: parsePosInt(
      source.MEDIA_VIDEO_SERVED_MAX_BITRATE,
      DEFAULT_LIMITS.servedVideoMaxBitrateBps,
    ),
    thumbnailMaxEdge: parsePosInt(source.MEDIA_THUMBNAIL_MAX_EDGE, DEFAULT_LIMITS.thumbnailMaxEdge),
    nsfwHoldThreshold: clampUnit(
      source.MEDIA_NSFW_HOLD_THRESHOLD,
      DEFAULT_LIMITS.nsfwHoldThreshold,
    ),
    nsfwUnscoredPolicy:
      source.MEDIA_UNSCORED_POLICY?.trim().toLowerCase() === "hold" ? "hold" : "flag",
    mediaChecksConcurrency: parsePosInt(
      source.MEDIA_CHECKS_CONCURRENCY,
      DEFAULT_LIMITS.mediaChecksConcurrency,
    ),
    orphanTtlMs: parsePosInt(source.MEDIA_ORPHAN_TTL_MS, DEFAULT_LIMITS.orphanTtlMs),
    orphanSweepBatch: parsePosInt(source.MEDIA_ORPHAN_SWEEP_BATCH, DEFAULT_LIMITS.orphanSweepBatch),
    orphanSweepMaxPages: parsePosInt(
      source.MEDIA_ORPHAN_SWEEP_MAX_PAGES,
      DEFAULT_LIMITS.orphanSweepMaxPages,
    ),
    holdReleaseSweepBatch: parsePosInt(
      source.MEDIA_HOLD_RELEASE_SWEEP_BATCH,
      DEFAULT_LIMITS.holdReleaseSweepBatch,
    ),
    retentionSweepBatch: parsePosInt(
      source.RETENTION_SWEEP_BATCH,
      DEFAULT_LIMITS.retentionSweepBatch,
    ),
    retentionSweepMaxPages: parsePosInt(
      source.RETENTION_SWEEP_MAX_PAGES,
      DEFAULT_LIMITS.retentionSweepMaxPages,
    ),
    stuckMediaTtlMs: parsePosInt(source.MEDIA_STUCK_TTL_MS, DEFAULT_LIMITS.stuckMediaTtlMs),
    stuckSweepBatch: parsePosInt(source.MEDIA_STUCK_SWEEP_BATCH, DEFAULT_LIMITS.stuckSweepBatch),
    stuckSweepMaxAttempts: parsePosInt(
      source.MEDIA_STUCK_SWEEP_MAX_ATTEMPTS,
      DEFAULT_LIMITS.stuckSweepMaxAttempts,
    ),
  }
  assertImageLaneFitsJobBudget(limits)
  assertVideoPathFitsJobBudget(limits)
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
