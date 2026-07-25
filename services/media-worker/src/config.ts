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
  /**
   * What to do when NO NSFW scorer is configured (M9).
   *
   * The moderation gate has been inert in production: `USE_REAL_NSFW` defaults false, no model was ever
   * vendored, `nsfwScore` therefore always returned 0, and the entire held/review branch was dead code —
   * so unauthenticated uploads auto-published with no moderation of any kind. A score of 0 from an
   * unconfigured scorer means "NO VERDICT", not "benign", and this knob decides how that is treated:
   *
   *   "flag" (default) — publish as usual but raise an explicit `nsfw` abuse flag and enqueue the asset
   *     for operator review, so the absence of a model is VISIBLE in the moderation queue instead of
   *     being an invisible auto-approve.
   *   "hold" — fail closed: the asset is held pending operator review and does not publish. This is the
   *     correct posture once there is moderation staffing (and it is what an operator should switch to
   *     during an abuse incident); it is not the default only because it stops anonymous reports from
   *     publishing at all until a human looks at every photo.
   */
  nsfwUnscoredPolicy: "flag" | "hold"
  /** Concurrency for the media.checks queue (parallel jobs per worker process). */
  mediaChecksConcurrency: number
  /**
   * TTL (ms) after which a media row that is bound to NOTHING (no report / chat message / post, not an
   * avatar, not a verification document — see MediaWorkerRepo.findOrphans for the exact predicate) is an
   * orphan and may be reaped.
   */
  orphanTtlMs: number
  /**
   * Max orphan rows reaped per sweep PAGE. M10: this used to be a hard per-RUN cap of 200 against
   * ~43,200 rows created per day at the presign rate limit, so the backlog could only ever grow. The
   * sweep now LOOPS while a page comes back full (see orphanSweepMaxPages), making this a batching knob
   * rather than a throughput ceiling, and the default is raised.
   *
   * NOTE ON AMPLIFICATION: batch x maxPages is the number of rows one run can DESTROY, so it multiplies
   * the blast radius of any error in the orphan predicate. That is only acceptable because the predicate
   * is exact (it matches rows with no binding in either direction); it was NOT acceptable while the
   * predicate was `report_id IS NULL`, which also matched every avatar, chat/DM attachment and post
   * photo in the database. Do not raise these knobs without re-reading that predicate.
   */
  orphanSweepBatch: number
  /** Safety bound on how many full pages one orphan-sweep run will drain before yielding to the next. */
  orphanSweepMaxPages: number
  /** Max held anon reports re-evaluated per hold-release sweep run (P2-8 self-healing backstop). */
  holdReleaseSweepBatch: number
}

/** Kill signal used when a sandboxed child exceeds its timeout. SIGKILL is non-catchable. */
export const CHILD_KILL_SIGNAL = "SIGKILL" as const

/** Allowed video codecs (ffprobe codec_name). h265 is reported as "hevc" by ffprobe. */
export const ALLOWED_VIDEO_CODECS: ReadonlySet<string> = new Set(["h264", "hevc"])

const ONE_MB = 1024 * 1024

/** Build the limits from env (with safe defaults). Pure; call once at startup or per test. */
export function loadLimits(source: NodeJS.ProcessEnv = process.env): WorkerLimits {
  return {
    // Cap exactly at the largest accepted media (the video cap); reject anything larger.
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
    nsfwUnscoredPolicy: source.MEDIA_UNSCORED_POLICY?.trim().toLowerCase() === "hold" ? "hold" : "flag",
    mediaChecksConcurrency: parsePosInt(source.MEDIA_CHECKS_CONCURRENCY, 2),
    // M10: shortened from 24h to 6h, and DELIBERATELY EQUAL to media-authorization.ts UNBOUND_GRACE_MS.
    //
    // 6h is aggressive for "a user might take a while to attach an upload", and on its own that would
    // argue for keeping 24h. It is nevertheless the right number here, because the API already REFUSES
    // TO SERVE an unbound row past UNBOUND_GRACE_MS: GET /media/:id returns 404 for it, so from 6h
    // onward the upload is already dead to every client. A longer reap TTL would only keep bytes in R2
    // that we have decided not to hand out — cost and unreviewed-content exposure with no recovered
    // functionality. (Resuming a stale draft still works either way: the commit paths claim by
    // upload_id and apply no age check, so the only thing lost is the row itself.)
    //
    // THESE TWO CONSTANTS ARE A PAIR. Grace must be <= TTL (deny before reap); moving one without the
    // other either serves rows that are about to vanish or keeps rows nobody can fetch. If this is ever
    // raised, raise UNBOUND_GRACE_MS in services/api/src/services/media-authorization.ts with it.
    orphanTtlMs: parsePosInt(source.MEDIA_ORPHAN_TTL_MS, 6 * 60 * 60 * 1000),
    orphanSweepBatch: parsePosInt(source.MEDIA_ORPHAN_SWEEP_BATCH, 1000),
    orphanSweepMaxPages: parsePosInt(source.MEDIA_ORPHAN_SWEEP_MAX_PAGES, 50),
    holdReleaseSweepBatch: parsePosInt(source.MEDIA_HOLD_RELEASE_SWEEP_BATCH, 200),
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
// Hold-release self-healing sweep (P2-8): every 5 minutes, re-check held anon reports so a release that
// lost its inline enqueue (e.g. a shutdown race) is reconciled promptly rather than the report staying
// held until an unrelated media event. Frequent + cheap (a bounded indexed scan + idempotent re-checks).
export const HOLD_RELEASE_SWEEP_CRON = "*/5 * * * *"
// Retention sweep (privacy §7.1): daily delete of consumed/expired email_otps, anon_tokens, sessions.
export const RETENTION_SWEEP_CRON = "37 4 * * *" // 04:37 UTC daily (off-peak, batch-capped)
