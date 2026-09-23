import type {
  MediaAssetView,
  MediaRepository,
  NewMediaAsset,
} from "../../src/services/media-intake-service.js"

type StoredMedia = MediaAssetView

export class InMemoryMediaRepository implements MediaRepository {
  readonly byId = new Map<string, StoredMedia>()
  private readonly uploadIndex = new Map<string, string>()

  insert(row: NewMediaAsset): Promise<void> {
    if (this.uploadIndex.has(row.uploadId)) {
      return Promise.reject(new Error(`duplicate uploadId: ${row.uploadId}`))
    }
    const stored: StoredMedia = {
      id: row.id,
      uploadId: row.uploadId,
      kind: row.kind,
      codec: null,
      r2Key: row.r2Key,
      servedKey: null,
      thumbKey: null,
      status: row.status,
      width: null,
      height: null,
      byteSize: row.byteSize,
      reportId: null,
      chatMessageId: null,
      postId: null,
      finalizedAt: null,
      createdAt: new Date(),
      uploader: row.uploader,
    }
    this.byId.set(row.id, stored)
    this.uploadIndex.set(row.uploadId, row.id)
    return Promise.resolve()
  }

  findByUploadId(uploadId: string): Promise<MediaAssetView | null> {
    const id = this.uploadIndex.get(uploadId)
    if (!id) return Promise.resolve(null)
    const row = this.byId.get(id)
    return Promise.resolve(row ? { ...row } : null)
  }

  findById(id: string): Promise<MediaAssetView | null> {
    const row = this.byId.get(id)
    return Promise.resolve(row ? { ...row } : null)
  }

  markFinalized(uploadId: string): Promise<MediaAssetView | null> {
    const id = this.uploadIndex.get(uploadId)
    if (!id) return Promise.resolve(null)
    const row = this.byId.get(id)
    if (!row) return Promise.resolve(null)
    if (row.finalizedAt != null) return Promise.resolve(null)
    row.finalizedAt = new Date()
    return Promise.resolve({ ...row })
  }

  patch(id: string, patch: Partial<MediaAssetView>): void {
    const row = this.byId.get(id)
    if (row) Object.assign(row, patch)
  }
}
