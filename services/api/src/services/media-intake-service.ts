import { randomUUID } from "node:crypto"
import { AppError } from "@civfix/shared"
import type {
  CreateMediaUploadRequest,
  CreateMediaUploadResponse,
  FinalizeMediaRequest,
  FinalizeMediaResponse,
  MediaDTO,
  MediaKind,
} from "@civfix/shared"
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from "@civfix/shared"
import type { Jobs, Storage } from "@civfix/shared/interfaces"
import { readEtag } from "./media-etag.js"
import { uploaderOf, uploadersOf } from "./media-uploader.js"
import { MEDIA_CLAIM_WINDOW_SEC } from "./host/event-media.js"
import { makeMediaPresigner, makePrivateMediaPresigner } from "./media-presign.js"
import {
  makeUnboundOnlyMediaViewAuthorizer,
  type MediaViewAuthorizer,
} from "./media-authorization.js"
import { MS_PER_SECOND } from "../lib/time.js"
import { MEDIA_CHECKS_JOB } from "../lib/queue-names.js"
import type { MediaAssetView, MediaRepository } from "./media-repository.js"

interface IntakeLogger {
  warn(obj: unknown, msg?: string): void
}

export const MEDIA_GET_URL_TTL_SEC = 15 * 60

export const MEDIA_PRIVATE_GET_URL_TTL_SEC = 5 * 60

const ALLOWED_IMAGE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
])
const ALLOWED_VIDEO_CONTENT_TYPES: ReadonlySet<string> = new Set(["video/mp4", "video/quicktime"])

const SHA256_HEX = /^[0-9a-f]{64}$/
const UPLOAD_KEY_PREFIX = "uploads/"
const USER_QUOTA_PREFIX = "u:"
const ANON_QUOTA_PREFIX = "a:"
const IP_QUOTA_PREFIX = "ip:"
const UNKNOWN_IP_KEY = "unknown"
const MEDIA_NOT_FOUND = "Media not found"

export interface MediaChecksJob {
  mediaId: string
  uploadId: string
  r2Key: string
  kind: MediaKind
  uploadEtag?: string | null
}

export interface MediaOwner {
  userId?: string | undefined
  anonSessionId?: string | undefined
  guestAnonSessionId?: string | undefined
  ipKey?: string | undefined
}

export interface MediaIntakeDeps {
  repo: MediaRepository
  storage: Storage
  jobs: Jobs
  newId?: () => string
  now?: () => Date
  logger?: IntakeLogger
  authorizer?: MediaViewAuthorizer
  byteQuota?: MediaByteQuota
}

export interface MediaByteQuota {
  charge(subject: string, bytes: number): Promise<number>
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
  const allowed = input.kind === "video" ? ALLOWED_VIDEO_CONTENT_TYPES : ALLOWED_IMAGE_CONTENT_TYPES

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

export function buildR2Key(uploadId: string, now: Date): string {
  const yyyy = String(now.getUTCFullYear()).padStart(4, "0")
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0")
  return `${UPLOAD_KEY_PREFIX}${yyyy}/${mm}/${uploadId}`
}

const SIZE_MISMATCH_TOLERANCE = 1024

export function quotaSubjects(owner: MediaOwner): string[] {
  if (owner.userId) return [`${USER_QUOTA_PREFIX}${owner.userId}`]
  const ipSubject = `${IP_QUOTA_PREFIX}${owner.ipKey ?? UNKNOWN_IP_KEY}`
  return owner.anonSessionId
    ? [`${ANON_QUOTA_PREFIX}${owner.anonSessionId}`, ipSubject]
    : [ipSubject]
}

async function enforceByteQuota(
  quota: MediaByteQuota,
  owner: MediaOwner,
  byteSize: number,
  logger: IntakeLogger | undefined,
): Promise<void> {
  let over: { subject: string; total: number } | null = null
  for (const subject of quotaSubjects(owner)) {
    const total = await quota.charge(subject, byteSize)
    if (total > quota.limitBytes && over === null) over = { subject, total }
  }
  if (!over) return
  logger?.warn(
    { subject: over.subject, totalBytes: over.total, limitBytes: quota.limitBytes },
    "media upload byte quota exceeded",
  )
  throw AppError.rateLimited("Upload quota exceeded. Try again later.")
}

export function makeMediaIntakeService(deps: MediaIntakeDeps): MediaIntakeService {
  const newId = deps.newId ?? (() => randomUUID())
  const now = deps.now ?? (() => new Date())
  const presign = makeMediaPresigner(deps.storage)
  const presignPrivate = makePrivateMediaPresigner(deps.storage)
  const authorizer = deps.authorizer ?? makeUnboundOnlyMediaViewAuthorizer(now)

  // The uploadId is readable from every served URL, so only the session that created the upload may
  // finalize it and set the worker on its bytes. A NULL uploader predates attribution and passes only
  // inside the claim window, after which the orphan sweep has already reclaimed it.
  function finalizableBy(asset: MediaAssetView, owner: MediaOwner): boolean {
    if (asset.uploader == null) {
      const createdAt = asset.createdAt?.getTime()
      return (
        createdAt !== undefined &&
        now().getTime() - createdAt < MEDIA_CLAIM_WINDOW_SEC * MS_PER_SECOND
      )
    }
    return uploadersOf(owner).includes(asset.uploader)
  }

  return {
    async createUpload(
      input: CreateMediaUploadRequest,
      owner: MediaOwner,
    ): Promise<CreateMediaUploadResponse> {
      precheckUpload(input)

      if (deps.byteQuota) {
        await enforceByteQuota(deps.byteQuota, owner, input.byteSize, deps.logger)
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
        uploader: uploaderOf(owner),
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

    async finalize(input: FinalizeMediaRequest, owner: MediaOwner): Promise<FinalizeMediaResponse> {
      const asset = await deps.repo.findByUploadId(input.uploadId)
      // A foreign upload answers exactly like a missing one, so the uploadId never confirms it exists.
      if (!asset || !finalizableBy(asset, owner)) {
        throw AppError.notFound("Unknown upload")
      }

      // Once finalized, the worker may already have deleted the raw upload and overwritten byte_size with
      // the processed size, so a client retry must be answered before either is checked again.
      if (asset.status !== "validating" || asset.finalizedAt != null) {
        return { mediaId: asset.id, status: "validating" }
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

      const uploadEtag = readEtag(head)
      const claimed = await deps.repo.markFinalized(input.uploadId, uploadEtag)
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
            uploadEtag,
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

    async getMedia(id: string, viewer: MediaOwner): Promise<MediaDTO> {
      const asset = await deps.repo.findById(id)
      if (!asset || asset.status !== "ready") {
        throw AppError.notFound(MEDIA_NOT_FOUND)
      }

      const decision = await authorizer.authorize(asset, viewer)
      if (!decision.allowed) {
        throw AppError.notFound(MEDIA_NOT_FOUND)
      }

      if (asset.servedKey === null) {
        throw AppError.notFound(MEDIA_NOT_FOUND)
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
