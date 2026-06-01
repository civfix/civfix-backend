/**
 * In-memory MediaWorkerRepo for offline unit tests (no database / no Docker).
 *
 * Mirrors the production Drizzle repo's surface (find / applyResult / insertAbuseFlag / findOrphans /
 * deleteById) so the job handlers and the orphan sweep can be exercised with NO Postgres. Records the
 * abuse_flags it is asked to insert so tests can assert the flag-and-hold flow.
 */

import type {
  MediaResultPatch,
  MediaWorkerAsset,
  MediaWorkerRepo,
  NewAbuseFlag,
  OrphanRow,
} from "@civfix/api/media-repo"

/** A stored media row plus the createdAt the orphan sweep filters on. */
export interface StoredWorkerMedia extends MediaWorkerAsset {
  createdAt: Date
}

/** A recorded abuse_flag insert (subject_type is always "media" here). */
export interface RecordedFlag {
  subjectId: string
  reason: NewAbuseFlag["reason"]
  source: NonNullable<NewAbuseFlag["source"]>
}

export class InMemoryWorkerRepo implements MediaWorkerRepo {
  readonly byId = new Map<string, StoredWorkerMedia>()
  readonly flags: RecordedFlag[] = []
  /** Set to a non-null Error to make a method reject (simulate an infra failure). */
  failApplyResult: Error | null = null

  /** Seed a media row. Returns the stored row. */
  seed(
    row: Partial<StoredWorkerMedia> & Pick<MediaWorkerAsset, "id" | "uploadId" | "kind" | "r2Key">,
  ): StoredWorkerMedia {
    const stored: StoredWorkerMedia = {
      id: row.id,
      uploadId: row.uploadId,
      reportId: row.reportId ?? null,
      kind: row.kind,
      r2Key: row.r2Key,
      thumbKey: row.thumbKey ?? null,
      status: row.status ?? "validating",
      byteSize: row.byteSize ?? null,
      createdAt: row.createdAt ?? new Date(),
    }
    this.byId.set(stored.id, stored)
    return stored
  }

  findById(id: string): Promise<MediaWorkerAsset | null> {
    const row = this.byId.get(id)
    return Promise.resolve(row ? { ...row } : null)
  }

  findByUploadId(uploadId: string): Promise<MediaWorkerAsset | null> {
    for (const row of this.byId.values()) {
      if (row.uploadId === uploadId) return Promise.resolve({ ...row })
    }
    return Promise.resolve(null)
  }

  applyResult(id: string, patch: MediaResultPatch): Promise<MediaWorkerAsset | null> {
    if (this.failApplyResult) return Promise.reject(this.failApplyResult)
    const row = this.byId.get(id)
    if (!row) return Promise.resolve(null)
    row.status = patch.status
    if (patch.thumbKey !== undefined) row.thumbKey = patch.thumbKey
    if (patch.byteSize !== undefined) row.byteSize = patch.byteSize
    // width/height/phash/codec are not part of MediaWorkerAsset's read shape; store them loosely on
    // the same object so tests can assert what the worker wrote.
    const loose = row as StoredWorkerMedia & {
      width?: number | null
      height?: number | null
      phash?: string | null
      codec?: string | null
    }
    if (patch.codec !== undefined) loose.codec = patch.codec
    if (patch.width !== undefined) loose.width = patch.width
    if (patch.height !== undefined) loose.height = patch.height
    if (patch.phash !== undefined) loose.phash = patch.phash
    return Promise.resolve({ ...row })
  }

  insertAbuseFlag(flag: NewAbuseFlag): Promise<void> {
    this.flags.push({
      subjectId: flag.subjectId,
      reason: flag.reason,
      source: flag.source ?? "worker",
    })
    return Promise.resolve()
  }

  findOrphans(olderThan: Date, limit: number): Promise<OrphanRow[]> {
    const out: OrphanRow[] = []
    for (const row of this.byId.values()) {
      if (row.reportId === null && row.createdAt < olderThan) {
        out.push({ id: row.id, r2Key: row.r2Key, thumbKey: row.thumbKey })
        if (out.length >= limit) break
      }
    }
    return Promise.resolve(out)
  }

  deleteById(id: string): Promise<void> {
    this.byId.delete(id)
    return Promise.resolve()
  }

  /** Test accessor: read the full stored row (including loose width/height/phash/codec). */
  get(id: string): (StoredWorkerMedia & Record<string, unknown>) | undefined {
    return this.byId.get(id) as (StoredWorkerMedia & Record<string, unknown>) | undefined
  }
}
