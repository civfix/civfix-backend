/**
 * Offline media-intake test helper: an in-memory MediaRepository.
 *
 * Mirrors the auth step's in-memory stores so the media-intake service AND the media HTTP routes can be
 * exercised with NO database (no Docker). The Drizzle-backed repository (media-repository.drizzle.ts)
 * is covered by the Docker-gated integration test; this fake exercises the same MediaRepository seam.
 */

import type {
  MediaAssetView,
  MediaRepository,
  NewMediaAsset,
} from "../../src/services/media-intake-service.js"
import type { MediaStatus } from "@civfix/shared"

/** A stored media row, kept as the structural view the service reads. */
type StoredMedia = MediaAssetView

export class InMemoryMediaRepository implements MediaRepository {
  /** Keyed by media id. */
  readonly byId = new Map<string, StoredMedia>()
  /** Secondary index: uploadId -> media id. */
  private readonly uploadIndex = new Map<string, string>()

  insert(row: NewMediaAsset): Promise<void> {
    if (this.uploadIndex.has(row.uploadId)) {
      // The DB has a UNIQUE(upload_id) constraint; surface a comparable conflict in the fake.
      return Promise.reject(new Error(`duplicate uploadId: ${row.uploadId}`))
    }
    const stored: StoredMedia = {
      id: row.id,
      uploadId: row.uploadId,
      kind: row.kind,
      codec: null,
      r2Key: row.r2Key,
      thumbKey: null,
      status: row.status,
      width: null,
      height: null,
      byteSize: row.byteSize,
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

  setStatusByUploadId(uploadId: string, status: MediaStatus): Promise<MediaAssetView | null> {
    const id = this.uploadIndex.get(uploadId)
    if (!id) return Promise.resolve(null)
    const row = this.byId.get(id)
    if (!row) return Promise.resolve(null)
    row.status = status
    return Promise.resolve({ ...row })
  }

  /**
   * Test helper: directly mutate a stored row (e.g. mark it "ready" or attach a thumb_key) to set up a
   * getMedia visibility scenario without going through the worker.
   */
  patch(id: string, patch: Partial<MediaAssetView>): void {
    const row = this.byId.get(id)
    if (row) Object.assign(row, patch)
  }
}
