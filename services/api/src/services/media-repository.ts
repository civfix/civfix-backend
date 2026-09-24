import type { MediaKind, MediaStatus } from "@civfix/shared"
import type { MEDIA_PURPOSE_VALUES } from "../db/schema/types-host.js"

export type MediaPurpose = (typeof MEDIA_PURPOSE_VALUES)[number]

export interface MediaAssetView {
  id: string
  uploadId: string
  kind: MediaKind
  codec: string | null
  r2Key: string
  servedKey: string | null
  thumbKey: string | null
  status: MediaStatus
  width: number | null
  height: number | null
  byteSize: number | null
  purpose?: MediaPurpose
  reportId?: string | null
  chatMessageId?: string | null
  postId?: string | null
  createdAt?: Date | null
  finalizedAt?: Date | null
  uploader?: string | null
}

export interface NewMediaAsset {
  id: string
  uploadId: string
  kind: MediaKind
  r2Key: string
  status: MediaStatus
  byteSize: number
  uploader: string
}

export interface MediaRepository {
  insert(row: NewMediaAsset): Promise<void>
  findByUploadId(uploadId: string): Promise<MediaAssetView | null>
  findById(id: string): Promise<MediaAssetView | null>
  markFinalized(uploadId: string, uploadEtag: string | null): Promise<MediaAssetView | null>
}
