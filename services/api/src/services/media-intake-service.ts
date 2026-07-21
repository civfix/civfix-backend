
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
import { makeMediaPresigner } from "./media-presign.js"

interface IntakeLogger {
  warn(obj: unknown, msg?: string): void
}

export const MEDIA_CHECKS_JOB = "media.checks"

export const MEDIA_GET_URL_TTL_SEC = 60 * 60

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
}

export interface MediaOwner {
  userId?: string | undefined
  anonSessionId?: string | undefined
}

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
  purpose?: MediaPurpose
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
  setStatusByUploadId(
    uploadId: string,
    status: MediaStatus,
    expectedStatus?: MediaStatus,
  ): Promise<MediaAssetView | null>
}

export interface MediaIntakeDeps {
  repo: MediaRepository
  storage: Storage
  jobs: Jobs
  newId?: () => string
  now?: () => Date
  logger?: IntakeLogger
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

export function makeMediaIntakeService(deps: MediaIntakeDeps): MediaIntakeService {
  const newId = deps.newId ?? (() => randomUUID())
  const now = deps.now ?? (() => new Date())
  const presign = makeMediaPresigner(deps.storage)

  return {
    async createUpload(
      input: CreateMediaUploadRequest,
      _owner: MediaOwner,
    ): Promise<CreateMediaUploadResponse> {
      precheckUpload(input)

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

      if (asset.status !== "validating") {
        return { mediaId: asset.id, status: "validating" }
      }

      const updated = await deps.repo.setStatusByUploadId(input.uploadId, "validating", "validating")
      if (updated === null) {
        return { mediaId: asset.id, status: "validating" }
      }
      const mediaId = updated.id

      try {
        await deps.jobs.enqueue(
          MEDIA_CHECKS_JOB,
          {
            mediaId,
            uploadId: input.uploadId,
            r2Key: asset.r2Key,
            kind: asset.kind,
          } satisfies MediaChecksJob,
          { singletonKey: input.uploadId },
        )
      } catch (err) {
        deps.logger?.warn({ err, uploadId: input.uploadId, mediaId }, "media.checks enqueue failed")
        throw err
      }

      return { mediaId, status: "validating" }
    },

    async getMedia(id: string, _viewer: MediaOwner): Promise<MediaDTO> {
      const asset = await deps.repo.findById(id)
      if (!asset || asset.status !== "ready") {
        throw AppError.notFound("Media not found")
      }
      if (asset.purpose === "verification") {
        throw AppError.notFound("Media not found")
      }

      const { url, thumbUrl } = await presign(asset.r2Key, asset.thumbKey)

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
