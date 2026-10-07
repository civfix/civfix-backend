import type { MediaKind, MediaStatus } from "@civfix/shared"
import type { NearDuplicateResult } from "@civfix/shared/interfaces"

export type WorkerAbuseReason = "nsfw" | "phash_dup" | "gps"

export interface MediaWorkerAsset {
  id: string
  uploadId: string
  reportId: string | null
  kind: MediaKind
  r2Key: string
  servedKey: string | null
  thumbKey: string | null
  status: MediaStatus
  byteSize: number | null
}

export interface MediaResultPatch {
  status: MediaStatus
  codec?: string | null
  width?: number | null
  height?: number | null
  phash?: string | null
  servedKey?: string | null
  thumbKey?: string | null
  byteSize?: number | null
}

export interface NewAbuseFlag {
  subjectId: string
  reason: WorkerAbuseReason
  source?: "worker" | "api" | "user_report"
}

export interface OrphanRow {
  id: string
  r2Key: string
  servedKey: string | null
  thumbKey: string | null
}

export interface StuckMediaRow {
  id: string
  uploadId: string
  r2Key: string
  servedKey: string | null
  thumbKey: string | null
  kind: MediaKind
  checkCount: number
  uploadEtag: string | null
}

export interface LeakedObjectRow {
  r2Key: string
  mediaId: string | null
  attempts: number
}

export interface LegacyServedKeyAdoption {
  adopted: number
  remaining: number
}

export interface MediaWorkerRepository {
  findById(id: string): Promise<MediaWorkerAsset | null>
  findByUploadId(uploadId: string): Promise<MediaWorkerAsset | null>
  applyResult(id: string, patch: MediaResultPatch): Promise<MediaWorkerAsset | null>
  insertAbuseFlag(flag: NewAbuseFlag): Promise<void>
  findOrphans(olderThan: Date, limit: number): Promise<OrphanRow[]>
  findStuckValidating(olderThan: Date, limit: number): Promise<StuckMediaRow[]>
  terminalizeStuck(id: string): Promise<MediaWorkerAsset | null>
  deleteOrphan(id: string, olderThan: Date): Promise<OrphanRow | null>
  adoptLegacyServedKeys(olderThan: Date, limit: number): Promise<LegacyServedKeyAdoption>
  r2KeyReferencedByOthers(id: string, r2Key: string): Promise<boolean>
  findPhashDuplicate?(
    hash: string,
    opts?: { excludeAssetId?: string; excludeReportId?: string },
  ): Promise<NearDuplicateResult>
  enqueueHeldModerationItem(input: {
    reportId: string
    reason: string
    kind?: "image" | "duplicate"
    note?: string | null
  }): Promise<void>
  refreshAvatarUrls?(mediaId: string, avatarUrl: string): Promise<number>

  recordLeakedObjects(input: {
    mediaId: string | null
    keys: string[]
    error?: string | null
  }): Promise<void>
  listLeakedObjects(limit: number, maxAttempts: number): Promise<LeakedObjectRow[]>
  clearLeakedObject(r2Key: string): Promise<void>
}
