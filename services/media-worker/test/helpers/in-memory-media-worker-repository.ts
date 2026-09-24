import type {
  LeakedObjectRow,
  LegacyServedKeyAdoption,
  MediaResultPatch,
  MediaWorkerAsset,
  MediaWorkerRepository,
  NewAbuseFlag,
  OrphanRow,
  StuckMediaRow,
} from "@civfix/api/media-worker-repository"

export interface StoredWorkerMedia extends MediaWorkerAsset {
  createdAt: Date
  chatMessageId: string | null
  postId: string | null
  purpose: "report" | "verification" | "post"
  finalizedAt: Date | null
  stuckCheckedAt: Date | null
  stuckCheckCount: number
  uploadEtag: string | null
}

export interface RecordedFlag {
  subjectId: string
  reason: NewAbuseFlag["reason"]
  source: NonNullable<NewAbuseFlag["source"]>
}

export interface RecordedModerationEnqueue {
  reportId: string
  reason: string
  kind?: "image" | "duplicate"
  note?: string | null
}

export class InMemoryMediaWorkerRepository implements MediaWorkerRepository {
  readonly byId = new Map<string, StoredWorkerMedia>()
  readonly flags: RecordedFlag[] = []
  readonly moderationEnqueues: RecordedModerationEnqueue[] = []
  failApplyResult: Error | null = null
  failModerationEnqueue: Error | null = null
  readonly tombstones = new Map<string, LeakedObjectRow>()
  failRecordLeaked: Error | null = null
  readonly avatarMediaIds = new Set<string>()
  now: () => Date = () => new Date()
  refreshAvatarUrls?: (mediaId: string, avatarUrl: string) => Promise<number>

  seed(
    row: Partial<StoredWorkerMedia> & Pick<MediaWorkerAsset, "id" | "uploadId" | "kind" | "r2Key">,
  ): StoredWorkerMedia {
    const stored: StoredWorkerMedia = {
      id: row.id,
      uploadId: row.uploadId,
      reportId: row.reportId ?? null,
      chatMessageId: row.chatMessageId ?? null,
      postId: row.postId ?? null,
      purpose: row.purpose ?? "report",
      kind: row.kind,
      r2Key: row.r2Key,
      servedKey: row.servedKey ?? null,
      thumbKey: row.thumbKey ?? null,
      status: row.status ?? "validating",
      byteSize: row.byteSize ?? null,
      createdAt: row.createdAt ?? new Date(),
      finalizedAt: row.finalizedAt ?? null,
      stuckCheckedAt: row.stuckCheckedAt ?? null,
      stuckCheckCount: row.stuckCheckCount ?? 0,
      uploadEtag: row.uploadEtag ?? null,
    }
    this.byId.set(stored.id, stored)
    return stored
  }

  seedAvatarReference(mediaId: string): void {
    this.avatarMediaIds.add(mediaId)
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
    if (!row || row.status !== "validating") return Promise.resolve(null)
    row.status = patch.status
    if (patch.servedKey !== undefined) row.servedKey = patch.servedKey
    if (patch.thumbKey !== undefined) row.thumbKey = patch.thumbKey
    if (patch.byteSize !== undefined) row.byteSize = patch.byteSize
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

  private isOrphan(row: StoredWorkerMedia, olderThan: Date): boolean {
    if (row.reportId !== null) return false
    if (row.chatMessageId !== null) return false
    if (row.postId !== null) return false
    if (this.avatarMediaIds.has(row.id)) return false
    if (row.purpose === "verification") return false
    return row.createdAt < olderThan
  }

  findOrphans(olderThan: Date, limit: number): Promise<OrphanRow[]> {
    const out: OrphanRow[] = []
    for (const row of this.byId.values()) {
      if (!this.isOrphan(row, olderThan)) continue
      out.push({
        id: row.id,
        r2Key: row.r2Key,
        servedKey: row.servedKey,
        thumbKey: row.thumbKey,
      })
      if (out.length >= limit) break
    }
    return Promise.resolve(out)
  }

  adoptLegacyServedKeys(olderThan: Date, limit: number): Promise<LegacyServedKeyAdoption> {
    let adopted = 0
    for (const row of this.byId.values()) {
      if (adopted >= limit) break
      if (row.status !== "ready") continue
      if (row.servedKey !== null) continue
      if (!(row.createdAt < olderThan)) continue
      row.servedKey = row.r2Key
      adopted += 1
    }
    if (adopted > 0) return Promise.resolve({ adopted, remaining: adopted })
    let remaining = 0
    for (const row of this.byId.values()) {
      if (row.status === "ready" && row.servedKey === null) {
        remaining = 1
        break
      }
    }
    return Promise.resolve({ adopted: 0, remaining })
  }

  deleteOrphan(id: string, olderThan: Date): Promise<OrphanRow | null> {
    const row = this.byId.get(id)
    if (!row || !this.isOrphan(row, olderThan)) return Promise.resolve(null)
    this.byId.delete(id)
    return Promise.resolve({
      id: row.id,
      r2Key: row.r2Key,
      servedKey: row.servedKey,
      thumbKey: row.thumbKey,
    })
  }

  findStuckValidating(olderThan: Date, limit: number): Promise<StuckMediaRow[]> {
    const candidates = [...this.byId.values()]
      .filter(
        (row) =>
          row.status === "validating" && row.finalizedAt !== null && row.finalizedAt < olderThan,
      )
      .sort((a, b) => {
        const at = a.stuckCheckedAt?.getTime() ?? -Infinity
        const bt = b.stuckCheckedAt?.getTime() ?? -Infinity
        return at === bt ? a.finalizedAt!.getTime() - b.finalizedAt!.getTime() : at - bt
      })
      .slice(0, limit)

    const stampedAt = this.now()
    return Promise.resolve(
      candidates.map((row) => {
        row.stuckCheckedAt = stampedAt
        row.stuckCheckCount += 1
        return {
          id: row.id,
          uploadId: row.uploadId,
          r2Key: row.r2Key,
          servedKey: row.servedKey,
          thumbKey: row.thumbKey,
          kind: row.kind,
          checkCount: row.stuckCheckCount,
          uploadEtag: row.uploadEtag,
        }
      }),
    )
  }

  terminalizeStuck(id: string): Promise<MediaWorkerAsset | null> {
    if (this.failApplyResult) return Promise.reject(this.failApplyResult)
    const row = this.byId.get(id)
    if (!row || row.status !== "validating") return Promise.resolve(null)
    row.status = "rejected"
    return Promise.resolve({ ...row })
  }

  r2KeyReferencedByOthers(id: string, r2Key: string): Promise<boolean> {
    for (const row of this.byId.values()) {
      if (row.id !== id && row.r2Key === r2Key) return Promise.resolve(true)
    }
    return Promise.resolve(false)
  }

  enqueueHeldModerationItem(input: {
    reportId: string
    reason: string
    kind?: "image" | "duplicate"
    note?: string | null
  }): Promise<void> {
    if (this.failModerationEnqueue) return Promise.reject(this.failModerationEnqueue)
    this.moderationEnqueues.push({ ...input })
    return Promise.resolve()
  }

  recordLeakedObjects(input: {
    mediaId: string | null
    keys: string[]
    error?: string | null
  }): Promise<void> {
    if (this.failRecordLeaked) return Promise.reject(this.failRecordLeaked)
    for (const r2Key of new Set(input.keys)) {
      const existing = this.tombstones.get(r2Key)
      if (existing) {
        existing.attempts += 1
      } else {
        this.tombstones.set(r2Key, { r2Key, mediaId: input.mediaId, attempts: 1 })
      }
    }
    return Promise.resolve()
  }

  listLeakedObjects(limit: number, maxAttempts: number): Promise<LeakedObjectRow[]> {
    const out: LeakedObjectRow[] = []
    for (const row of this.tombstones.values()) {
      if (row.attempts >= maxAttempts) continue
      out.push({ ...row })
      if (out.length >= limit) break
    }
    return Promise.resolve(out)
  }

  clearLeakedObject(r2Key: string): Promise<void> {
    this.tombstones.delete(r2Key)
    return Promise.resolve()
  }

  get(id: string): (StoredWorkerMedia & Record<string, unknown>) | undefined {
    return this.byId.get(id) as (StoredWorkerMedia & Record<string, unknown>) | undefined
  }
}
