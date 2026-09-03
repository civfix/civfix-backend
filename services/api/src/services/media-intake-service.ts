
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
import type { MEDIA_PURPOSE_VALUES } from "../db/schema/types.js"

/**
 * The media purpose, sourced from the DB schema enum (MEDIA_PURPOSE_VALUES) rather than the shared
 * MediaPurpose: the DB ships 'post' (social-feed media) AHEAD of the shared contract, so the internal
 * view must accept it. `purpose` is only used internally (never serialized to a shared DTO).
 */
type MediaPurpose = (typeof MEDIA_PURPOSE_VALUES)[number]
import type { Jobs, Storage } from "@civfix/shared/interfaces"
import { readEtag } from "./media-etag.js"
import { makeMediaPresigner, makePrivateMediaPresigner } from "./media-presign.js"
import {
  makeUnboundOnlyMediaViewAuthorizer,
  type MediaViewAuthorizer,
} from "./media-authorization.js"

interface IntakeLogger {
  warn(obj: unknown, msg?: string): void
}

export const MEDIA_CHECKS_JOB = "media.checks"

/**
 * TTL for a presigned GET of PUBLIC media (published+public report media, public post media, avatars).
 * Shortened from 1h to 15m as part of H9: a media URL that leaks (screenshot, shared link, proxy log)
 * should stop working quickly, and every surface that renders media re-presigns on read anyway.
 */
export const MEDIA_GET_URL_TTL_SEC = 15 * 60

/**
 * TTL for a presigned GET of PRIVATE media — chat/DM attachments, an owner's own held/unlisted report
 * media, and not-yet-committed uploads. Deliberately much shorter than the public TTL, and always
 * paired with `forceSigned` so private media never goes out as an unsigned, never-expiring CDN URL.
 */
export const MEDIA_PRIVATE_GET_URL_TTL_SEC = 5 * 60

export const ALLOWED_IMAGE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
])
export const ALLOWED_VIDEO_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "video/mp4",
  "video/quicktime",
])

const SHA256_HEX = /^[0-9a-f]{64}$/

export interface MediaChecksJob {
  mediaId: string
  uploadId: string
  r2Key: string
  kind: MediaKind
  /**
   * C1: the ETag of the object as it stood at finalize. The worker compares it against what it actually
   * downloads, so bytes swapped between finalize and processing are rejected rather than published. Null
   * when the storage seam reports no ETag (offline fakes) and absent on a job enqueued before this field
   * existed or re-driven by the stuck sweep, which has no finalize-time observation to pass on.
   */
  uploadEtag?: string | null
}

export interface MediaOwner {
  userId?: string | undefined
  anonSessionId?: string | undefined
  /** Normalized client IP: the un-rotatable quota bucket key for any caller without a session (see quotaSubjects). */
  ipKey?: string | undefined
}

export interface MediaAssetView {
  id: string
  uploadId: string
  kind: MediaKind
  codec: string | null
  r2Key: string
  /**
   * C1: the WORKER-OWNED key the processed bytes were published to (media-worker/src/jobs/media-keys.ts
   * servedKey). Every path that serves bytes for a `ready` asset reads THIS key, never `r2Key` — the
   * client holds a presigned PUT for `r2Key` and could otherwise overwrite vetted media. NULL on a row
   * that has not been published yet and on pre-migration rows until the served-key backfill has run
   * (src/db/backfill-served-key.ts); a NULL on a `ready` row is served as "not found".
   */
  servedKey: string | null
  thumbKey: string | null
  status: MediaStatus
  width: number | null
  height: number | null
  byteSize: number | null
  purpose?: MediaPurpose
  // BINDINGS (H9): the subject this asset belongs to. Exactly one is set once the asset is claimed;
  // all three are null for an avatar or a not-yet-committed upload. The media view authorizer
  // (services/media-authorization.ts) resolves visibility THROUGH these — an asset has no visibility
  // of its own — so they must be projected by every MediaRepository implementation.
  reportId?: string | null
  chatMessageId?: string | null
  postId?: string | null
  /** Row age, used to bound the pre-commit capability window for an unbound asset. */
  createdAt?: Date | null
  /** 0087 finalize watermark: NULL until the one winning finalize stamps it. */
  finalizedAt?: Date | null
}

export interface NewMediaAsset {
  id: string
  uploadId: string
  kind: MediaKind
  r2Key: string
  status: MediaStatus
  byteSize: number
}

export interface MediaRepository {
  insert(row: NewMediaAsset): Promise<void>
  findByUploadId(uploadId: string): Promise<MediaAssetView | null>
  findById(id: string): Promise<MediaAssetView | null>
  /**
   * F087 finalize CAS: stamp finalized_at exactly once per upload. Returns the row for the caller that
   * won the compare-and-set and null for every later finalize, so the media.checks enqueue happens once
   * no matter how often the client (or a retrying proxy) calls finalize.
   */
  markFinalized(uploadId: string): Promise<MediaAssetView | null>
}

export interface MediaIntakeDeps {
  repo: MediaRepository
  storage: Storage
  jobs: Jobs
  newId?: () => string
  now?: () => Date
  logger?: IntakeLogger
  /**
   * View authorization for getMedia (H9). Omitted -> the fail-closed unbound-only authorizer, which
   * serves not-yet-committed uploads inside the capability window and DENIES every bound asset.
   */
  authorizer?: MediaViewAuthorizer
  /**
   * Cumulative presigned-BYTE meter for createUpload (M10). Omitted -> no byte quota (offline
   * harnesses); production wires the Redis-backed meter in routes/media.routes.ts.
   */
  byteQuota?: MediaByteQuota
}

/**
 * Per-caller cumulative presigned-byte quota (M10). `charge` returns the running total for the
 * caller's daily window AFTER adding `bytes`; the service rejects once that exceeds the cap.
 *
 * Metering BYTES rather than requests is the point: the route's 30/min request cap still allowed
 * 30 x 50 MB x 60 = 90 GB/hour from one source, all of it landing in R2 before anything looks at it.
 */
export interface MediaByteQuota {
  charge(subject: string, bytes: number): Promise<number>
  /** Cap, in bytes, per subject per window. */
  readonly limitBytes: number
}

export interface MediaIntakeService {
  createUpload(
    input: CreateMediaUploadRequest,
    owner: MediaOwner,
  ): Promise<CreateMediaUploadResponse>
  finalize(input: FinalizeMediaRequest, owner: MediaOwner): Promise<FinalizeMediaResponse>
  getMedia(id: string, viewer: MediaOwner): Promise<MediaDTO>
}

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

  // NOTE (L14): this is a SHAPE check only. The declared digest is NOT persisted and the worker does
  // NOT re-hash the downloaded bytes against it, so there is currently NO content-integrity control on
  // this path — do not cite it as one. It is retained purely to reject obviously-malformed input at the
  // boundary. Making it real needs a `media_assets.sha256` column (migration) plus a compare in the
  // worker's download step; until then the honest statement is "declared, unverified".
  const sha = input.sha256.toLowerCase()
  if (!SHA256_HEX.test(sha)) {
    throw AppError.mediaRejected("sha256 must be a 64-character hex digest")
  }
}

export function buildR2Key(uploadId: string, now: Date): string {
  const yyyy = String(now.getUTCFullYear()).padStart(4, "0")
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0")
  return `uploads/${yyyy}/${mm}/${uploadId}`
}

const SIZE_MISMATCH_TOLERANCE = 1024

/**
 * Quota buckets for a caller — EVERY returned subject is charged and EVERY one is capped (F016).
 *
 * A signed-in user is metered by account alone: the session token behind `userId` is server-issued, so
 * rotating IPs cannot reset that budget (M22's complaint about IP-only keying).
 *
 * An unauthenticated caller is metered by IP **always**, plus the anon session when one is presented.
 * `anonSessionId` is the RAW `civfix_anon` cookie (auth/context.ts resolves it with no store lookup and
 * no signature), so it is a client-CHOSEN label, never an identity: this used to be a preference order,
 * which let an attacker mint a fresh 512 MB/day bucket per request just by rotating the cookie and left
 * the 30/min per-IP request cap as the only real bound (30 x 50 MB x 60 = 90 GB/hour). The IP lane is
 * the un-rotatable floor; the anon lane survives only as a tighter per-browser bound on top of it.
 */
export function quotaSubjects(owner: MediaOwner): string[] {
  if (owner.userId) return [`u:${owner.userId}`]
  const ipSubject = `ip:${owner.ipKey ?? "unknown"}`
  return owner.anonSessionId ? [`a:${owner.anonSessionId}`, ipSubject] : [ipSubject]
}

export function makeMediaIntakeService(deps: MediaIntakeDeps): MediaIntakeService {
  const newId = deps.newId ?? (() => randomUUID())
  const now = deps.now ?? (() => new Date())
  const presign = makeMediaPresigner(deps.storage)
  const presignPrivate = makePrivateMediaPresigner(deps.storage)
  const authorizer = deps.authorizer ?? makeUnboundOnlyMediaViewAuthorizer(now)

  return {
    async createUpload(
      input: CreateMediaUploadRequest,
      owner: MediaOwner,
    ): Promise<CreateMediaUploadResponse> {
      precheckUpload(input)

      // M10: meter cumulative presigned BYTES per caller per day, BEFORE minting the presign. The
      // route's request-per-minute cap bounds call frequency but says nothing about volume; without a
      // byte budget one source can park tens of GB in R2 far faster than the orphan sweep reclaims it.
      // Charged on the DECLARED byteSize, which is exactly what the signed PUT pins (Content-Length is
      // part of the signature), so the client cannot upload more than it was charged for.
      const quota = deps.byteQuota
      if (quota) {
        // Charge EVERY bucket before deciding (F016): a caller whose anon bucket is already over must
        // still be accounted against its IP bucket, or tripping the cheap bucket would shield the
        // expensive one. The first bucket over the cap is what gets reported.
        let over: { subject: string; total: number } | null = null
        for (const subject of quotaSubjects(owner)) {
          const total = await quota.charge(subject, input.byteSize)
          if (total > quota.limitBytes && over === null) over = { subject, total }
        }
        if (over) {
          deps.logger?.warn(
            { subject: over.subject, totalBytes: over.total, limitBytes: quota.limitBytes },
            "media upload byte quota exceeded",
          )
          throw AppError.rateLimited("Upload quota exceeded. Try again later.")
        }
      }

      const uploadId = newId()
      const r2Key = buildR2Key(uploadId, now())

      await deps.repo.insert({
        id: newId(),
        uploadId,
        kind: input.kind,
        r2Key,
        status: "validating",
        byteSize: input.byteSize,
      })

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
      const asset = await deps.repo.findByUploadId(input.uploadId)
      if (!asset) {
        throw AppError.notFound("Unknown upload")
      }

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

      // CONTRACT LIMIT (not a bug to "fix" here): a re-finalize of an already-processed asset reports
      // 'validating' even when the row is terminally ready/rejected/held, because
      // FinalizeMediaResponseSchema.status is a z.ZodLiteral<"validating"> — the only value this response
      // can carry. Combined with getMedia's status !== "ready" -> 404 (the H9 non-oracle control, which
      // must NOT be relaxed), a REJECTED upload therefore has no terminal signal anywhere on the media
      // surface: 'validating' from finalize, 404 from the poll, forever. Widening the literal to
      // MediaStatus in @civfix/shared is the fix; it is a contract change, so it is not made here.
      if (asset.status !== "validating") {
        return { mediaId: asset.id, status: "validating" }
      }

      const claimed = await deps.repo.markFinalized(input.uploadId)
      if (claimed === null) {
        return { mediaId: asset.id, status: "validating" }
      }
      const mediaId = claimed.id

      try {
        await deps.jobs.enqueue(
          MEDIA_CHECKS_JOB,
          {
            mediaId,
            uploadId: input.uploadId,
            r2Key: asset.r2Key,
            kind: asset.kind,
            uploadEtag: readEtag(head),
          } satisfies MediaChecksJob,
          { singletonKey: input.uploadId },
        )
      } catch (err) {
        deps.logger?.warn(
          { err, uploadId: input.uploadId, mediaId },
          "media.checks enqueue failed; the finalized row is left for the stuck sweep to drive",
        )
      }

      return { mediaId, status: "validating" }
    },

    /**
     * H9: authorize the VIEWER against the asset's binding before issuing any URL.
     *
     * Every deny is a 404 with the same message as "no such media" — never a 403 — so the endpoint is
     * not an existence oracle for a private DM attachment or a held report's photo. The authorizer
     * decides both *whether* the viewer may see it and whether it must be served as a short-lived
     * signed GET rather than a public CDN URL.
     */
    async getMedia(id: string, viewer: MediaOwner): Promise<MediaDTO> {
      const asset = await deps.repo.findById(id)
      if (!asset || asset.status !== "ready") {
        throw AppError.notFound("Media not found")
      }

      const decision = await authorizer.authorize(asset, viewer)
      if (!decision.allowed) {
        throw AppError.notFound("Media not found")
      }

      // C1: serve the worker-owned processed key. A `ready` row with no served_key has not been
      // published to one (pre-migration row awaiting the backfill), and is 404'd exactly like a
      // not-ready asset rather than falling back to the client-writable upload key.
      if (asset.servedKey === null) {
        throw AppError.notFound("Media not found")
      }
      const issue = decision.private ? presignPrivate : presign
      const { url, thumbUrl } = await issue(asset.servedKey, asset.thumbKey)

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
