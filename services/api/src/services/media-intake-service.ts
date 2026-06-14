/**
 * Media intake service: the cheap, API-side half of the media pipeline.
 *
 * This step does NOT touch the uploaded bytes. It only:
 *   1. createUpload  - runs CHEAP pre-checks on the client's declared metadata (kind/contentType/size/
 *                      sha256 shape), allocates an uploadId + a content-addressed r2_key, inserts a
 *                      media_assets row, and presigns a direct-to-R2 PUT for the client.
 *   2. finalize      - after the client has PUT the bytes, confirms the object exists (optional HEAD),
 *                      flips status to "validating", and ENQUEUES a single "media.checks" job for the
 *                      later media-worker to do the expensive untrusted-byte processing.
 *   3. getMedia      - renders a MediaDTO with a presigned/CDN URL, subject to the visibility rule.
 *
 * The heavy work (decode, NSFW, phash, transcode, thumbnailing, EXIF/GPS, dimension extraction, orphan
 * sweep) belongs to the SEPARATE media-worker step; here we only pre-check + presign + enqueue.
 *
 * STATUS LIFECYCLE (chosen): a row is inserted at "validating" on createUpload and STAYS "validating"
 * through finalize. Rationale: MediaStatus (shared) is exactly {validating, ready, rejected, held} -
 * there is no "pending" member, and FinalizeMediaResponse.status is the literal "validating". Rather
 * than invent an out-of-contract pre-finalize state, the row is "validating" (a not-yet-usable asset)
 * from creation; the worker later advances it to ready/rejected/held. A never-finalized row simply
 * stays "validating" with report_id null and is swept by the worker cron. finalize is the trigger that
 * actually enqueues the checks job, so "validating" before finalize means "awaiting upload", and after
 * finalize means "awaiting worker"; both are correctly not-usable. See REPORT for the gap note.
 *
 * OWNERSHIP / VISIBILITY (documented; see also the @civfix/shared gap in the REPORT): media_assets has
 * NO owner column (no reporter_user_id / anon_session_id), and the refined contract is frozen, so we do
 * not persist the uploader. Pre-report-commit, ownership is therefore CAPABILITY-BASED: the uploadId is
 * an unguessable client UUID and possessing it is the proof needed to finalize. getMedia enforces a
 * conservative visibility rule: a "ready" asset is public (public report pins surface ready media), but
 * a not-yet-ready asset (validating/held/rejected) is NOT public and, because there is no stored owner
 * to authorize against, is reported as 404 (not found) to every caller of the public GET /media/:id.
 * Owner-scoped previews of in-flight media are deferred to the report step (which DOES own the media).
 */

import { randomUUID } from "node:crypto"
import { AppError } from "@civfix/shared"
import type {
  CreateMediaUploadRequest,
  CreateMediaUploadResponse,
  FinalizeMediaRequest,
  FinalizeMediaResponse,
  MediaDTO,
  MediaKind,
  MediaStatus,
} from "@civfix/shared"
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from "@civfix/shared"
import type { Jobs, Storage } from "@civfix/shared/interfaces"

/** Stable job name the media-worker step MUST consume to run the untrusted-byte checks. */
export const MEDIA_CHECKS_JOB = "media.checks"

/** TTL (seconds) for the presigned GET URL returned by getMedia. 1 hour balances cacheability vs leak. */
export const MEDIA_GET_URL_TTL_SEC = 60 * 60

/**
 * Allowlisted upload content types per kind. CHEAP gate only: the worker re-validates against the real
 * bytes. Kept narrow to the formats the mobile/web clients produce AND the media-worker can decode +
 * re-encode.
 *
 * HEIC/HEIF are deliberately NOT accepted: the worker's `sharp` ships the prebuilt libvips, which has no
 * libheif/HEVC decoder, so it cannot decode (or EXIF-strip / normalize) iPhone HEIC. Accepting it created
 * a media row whose served object stayed the raw, browser-unrenderable HEIC -> a blank image on web.
 * Mobile already transcodes captures to JPEG before upload; a web pick of a `.heic` file is rejected here
 * with MEDIA_REJECTED so the client fails fast instead of producing a report with an unviewable photo.
 */
export const ALLOWED_IMAGE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
])
export const ALLOWED_VIDEO_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "video/mp4",
  "video/quicktime",
])

/** A lowercase 64-character hex string (a SHA-256 digest). */
const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * Payload enqueued on the "media.checks" queue. The worker re-reads the row by id/uploadId; this is the
 * minimal handle set it needs to locate the object and decide how to process it.
 */
export interface MediaChecksJob {
  mediaId: string
  uploadId: string
  r2Key: string
  kind: MediaKind
}

/** The owner context (signed-in user or anonymous session) initiating an upload/finalize. */
export interface MediaOwner {
  userId?: string | undefined
  anonSessionId?: string | undefined
}

/**
 * The subset of a media_assets row the service reads back. Structural (not the full Drizzle row) so the
 * repository can be faked in unit tests without a DB.
 */
export interface MediaAssetView {
  id: string
  uploadId: string
  kind: MediaKind
  codec: string | null
  r2Key: string
  thumbKey: string | null
  status: MediaStatus
  width: number | null
  height: number | null
  byteSize: number | null
}

/** Fields inserted for a freshly-created upload row. */
export interface NewMediaAsset {
  id: string
  uploadId: string
  kind: MediaKind
  r2Key: string
  status: MediaStatus
  byteSize: number
}

/**
 * Persistence seam for media_assets. The production impl (makeDrizzleMediaRepository) runs Drizzle; unit
 * tests pass an in-memory implementation. Keeping all media_assets access behind this interface is what
 * makes createUpload/finalize/getMedia testable offline (mirrors the auth step's store seam).
 */
export interface MediaRepository {
  insert(row: NewMediaAsset): Promise<void>
  findByUploadId(uploadId: string): Promise<MediaAssetView | null>
  findById(id: string): Promise<MediaAssetView | null>
  /** Set status for a row identified by uploadId. Returns the updated view (null if it vanished). */
  setStatusByUploadId(uploadId: string, status: MediaStatus): Promise<MediaAssetView | null>
}

export interface MediaIntakeDeps {
  repo: MediaRepository
  storage: Storage
  jobs: Jobs
  /** Injectable id factory (defaults to crypto.randomUUID) so tests can assert deterministic ids. */
  newId?: () => string
  /** Injectable clock for the r2_key date prefix (defaults to Date.now), for deterministic tests. */
  now?: () => Date
}

export interface MediaIntakeService {
  createUpload(
    input: CreateMediaUploadRequest,
    owner: MediaOwner,
  ): Promise<CreateMediaUploadResponse>
  finalize(input: FinalizeMediaRequest, owner: MediaOwner): Promise<FinalizeMediaResponse>
  getMedia(id: string, viewer: MediaOwner): Promise<MediaDTO>
}

/**
 * PURE pre-check on the client-declared upload metadata. No byte parsing, no IO. Throws
 * AppError.mediaRejected (MEDIA_REJECTED -> 422) when the request is not acceptable; returns void when
 * it passes. Exposed standalone so it is unit-testable without a DB or any seam.
 *
 * Checks:
 *   - contentType is on the kind-appropriate allowlist;
 *   - byteSize is a positive integer within the kind-appropriate cap (image <= MAX_IMAGE_BYTES,
 *     video <= MAX_VIDEO_BYTES);
 *   - sha256 looks like a 64-char lowercase hex digest.
 * (The shared Zod schema already enforces the basic shape + the video cap; we re-assert here so the
 * service is safe even when called with an un-validated object, and so image vs video caps are applied.)
 */
export function precheckUpload(input: CreateMediaUploadRequest): void {
  const max = input.kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES
  const allowed =
    input.kind === "video" ? ALLOWED_VIDEO_CONTENT_TYPES : ALLOWED_IMAGE_CONTENT_TYPES

  if (!allowed.has(input.contentType)) {
    throw AppError.mediaRejected(
      `contentType "${input.contentType}" is not allowed for kind "${input.kind}"`,
    )
  }

  if (!Number.isInteger(input.byteSize) || input.byteSize <= 0) {
    throw AppError.mediaRejected("byteSize must be a positive integer")
  }
  if (input.byteSize > max) {
    throw AppError.mediaRejected(`byteSize exceeds the ${input.kind} limit of ${max} bytes`)
  }

  const sha = input.sha256.toLowerCase()
  if (!SHA256_HEX.test(sha)) {
    throw AppError.mediaRejected("sha256 must be a 64-character hex digest")
  }
}

/**
 * Build the content-addressed object key for an upload.
 *
 * Scheme: `uploads/<yyyy>/<mm>/<sha256>`. Content-addressing by the client-declared sha256 dedupes
 * identical bytes to one key and keeps the key independent of the (random) uploadId; the yyyy/mm prefix
 * keeps the bucket listing shardable by month for lifecycle/cleanup. The worker is the one that trusts
 * bytes, so a colliding/incorrect sha only affects key placement, never correctness of validation.
 */
export function buildR2Key(sha256: string, now: Date): string {
  const yyyy = String(now.getUTCFullYear()).padStart(4, "0")
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0")
  return `uploads/${yyyy}/${mm}/${sha256.toLowerCase()}`
}

/** Tolerance for the finalize HEAD size check: reject only a GROSS mismatch vs the declared byteSize. */
const SIZE_MISMATCH_TOLERANCE = 1024

export function makeMediaIntakeService(deps: MediaIntakeDeps): MediaIntakeService {
  const newId = deps.newId ?? (() => randomUUID())
  const now = deps.now ?? (() => new Date())

  return {
    async createUpload(
      input: CreateMediaUploadRequest,
      _owner: MediaOwner,
    ): Promise<CreateMediaUploadResponse> {
      // Cheap pre-checks (throws MEDIA_REJECTED on any failure). No bytes are read.
      precheckUpload(input)

      const uploadId = newId()
      const r2Key = buildR2Key(input.sha256, now())

      // Insert the tracking row first (status "validating" = not-yet-usable; see file header). report_id
      // stays null until a report commits; the worker cron sweeps never-finalized orphans later.
      await deps.repo.insert({
        id: newId(),
        uploadId,
        kind: input.kind,
        r2Key,
        status: "validating",
        byteSize: input.byteSize,
      })

      // Presign the direct-to-R2 PUT. The returned headers are the ones the client MUST echo (the real
      // adapter signs content-type + content-length; FakeStorage mirrors that shape).
      const presigned = await deps.storage.presignPut(r2Key, {
        contentType: input.contentType,
        byteSize: input.byteSize,
      })

      return {
        uploadId,
        putUrl: presigned.url,
        headers: presigned.headers,
      }
    },

    async finalize(
      input: FinalizeMediaRequest,
      _owner: MediaOwner,
    ): Promise<FinalizeMediaResponse> {
      // Ownership pre-report-commit is capability-based: knowing the uploadId IS the proof (the row has
      // no stored owner to compare against; see file header + REPORT). An unknown uploadId is a 404.
      const asset = await deps.repo.findByUploadId(input.uploadId)
      if (!asset) {
        throw AppError.notFound("Unknown upload")
      }

      // Optional existence/size confirmation. Storage.head returns the object's true size; reject a
      // GROSS mismatch vs what the client declared (a small delta can come from metadata, so we tolerate
      // a little). A missing object means the client never completed the PUT -> reject.
      const head = await deps.storage.head(asset.r2Key)
      if (!head) {
        throw AppError.mediaRejected("Uploaded object not found in storage")
      }
      if (
        asset.byteSize !== null &&
        Math.abs(head.size - asset.byteSize) > SIZE_MISMATCH_TOLERANCE
      ) {
        throw AppError.mediaRejected("Uploaded object size does not match the declared byteSize")
      }

      // Move to "validating" (idempotent: it is already "validating" from createUpload, but finalize is
      // the authoritative transition into the worker pipeline).
      const updated = await deps.repo.setStatusByUploadId(input.uploadId, "validating")
      const mediaId = updated?.id ?? asset.id

      // Enqueue EXACTLY ONE checks job. singletonKey = uploadId so a double-finalize (client retry)
      // collapses to a single active job in pg-boss. The worker re-reads the row by id/uploadId.
      const data: MediaChecksJob = {
        mediaId,
        uploadId: asset.uploadId,
        r2Key: asset.r2Key,
        kind: asset.kind,
      }
      await deps.jobs.enqueue(MEDIA_CHECKS_JOB, data, { singletonKey: asset.uploadId })

      return { mediaId, status: "validating" }
    },

    async getMedia(id: string, _viewer: MediaOwner): Promise<MediaDTO> {
      const asset = await deps.repo.findById(id)
      // Visibility: only "ready" media is public. Not-yet-ready (validating/held/rejected) media has no
      // stored owner to authorize a preview against, so it is reported as not found (see file header).
      if (!asset || asset.status !== "ready") {
        throw AppError.notFound("Media not found")
      }

      const url = await deps.storage.presignGet(asset.r2Key, MEDIA_GET_URL_TTL_SEC)
      const thumbUrl =
        asset.thumbKey !== null
          ? await deps.storage.presignGet(asset.thumbKey, MEDIA_GET_URL_TTL_SEC)
          : undefined

      return {
        id: asset.id,
        kind: asset.kind,
        codec: asset.codec,
        url,
        ...(thumbUrl !== undefined ? { thumbUrl } : {}),
        width: asset.width,
        height: asset.height,
        status: asset.status,
      }
    },
  }
}
