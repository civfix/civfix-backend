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

/**
 * A stored media row plus the columns the ORPHAN PREDICATE reads.
 *
 * MediaWorkerAsset is the worker's PROCESSING view (what it needs to fetch/transform bytes) and does not
 * carry the other binding columns, but the fake's findOrphans has to mirror the production predicate in
 * MediaWorkerRepo.findOrphans exactly — a fake with a looser predicate is a suite that reports green
 * while the real sweep deletes user data. So they are modelled here.
 */
export interface StoredWorkerMedia extends MediaWorkerAsset {
  createdAt: Date
  /** FORWARD binding: chat + DM attachments (media_assets.chat_message_id). */
  chatMessageId: string | null
  /** FORWARD binding: social-feed post media (media_assets.post_id). */
  postId: string | null
  /** media_assets.purpose. 'verification' rows are referenced from user_verification.documents jsonb. */
  purpose: "report" | "verification" | "post"
}

/** A recorded abuse_flag insert (subject_type is always "media" here). */
export interface RecordedFlag {
  subjectId: string
  reason: NewAbuseFlag["reason"]
  source: NonNullable<NewAbuseFlag["source"]>
}

/** A recorded held-media moderation enqueue (M3), inspectable by tests. */
export interface RecordedModerationEnqueue {
  reportId: string
  reason: string
  kind?: "image" | "duplicate"
  note?: string | null
}

export class InMemoryWorkerRepo implements MediaWorkerRepo {
  readonly byId = new Map<string, StoredWorkerMedia>()
  readonly flags: RecordedFlag[] = []
  /** Recorded enqueueHeldModerationItem calls (M3: the held media -> moderation queue producer). */
  readonly moderationEnqueues: RecordedModerationEnqueue[] = []
  /** Set to a non-null Error to make a method reject (simulate an infra failure). */
  failApplyResult: Error | null = null
  /** Set to a non-null Error to make enqueueHeldModerationItem reject (assert it is non-fatal). */
  failModerationEnqueue: Error | null = null
  /**
   * REVERSE bindings: media ids referenced by users.avatar_media_id / chat_groups.avatar_media_id. The
   * binding points AT the media row, so the row's own columns look unbound — exactly the shape the old
   * `report_id IS NULL` predicate mistook for an orphan. Stands in for the production NOT EXISTS probes.
   */
  readonly avatarMediaIds = new Set<string>()

  /** Seed a media row. Returns the stored row. */
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
      thumbKey: row.thumbKey ?? null,
      status: row.status ?? "validating",
      byteSize: row.byteSize ?? null,
      createdAt: row.createdAt ?? new Date(),
    }
    this.byId.set(stored.id, stored)
    return stored
  }

  /** Point an avatar at an existing media row (users/chat_groups avatar_media_id). */
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

  /**
   * MIRRORS MediaWorkerRepo.findOrphans EXACTLY. This fake previously tested only `reportId === null`,
   * which is why the suite stayed green while the production predicate would have reaped every avatar,
   * chat/DM attachment and post photo older than the TTL. Keep the two in lockstep: if a binding lane is
   * added to the real predicate, add it here in the same change.
   */
  findOrphans(olderThan: Date, limit: number): Promise<OrphanRow[]> {
    const out: OrphanRow[] = []
    for (const row of this.byId.values()) {
      if (row.reportId !== null) continue // forward: report
      if (row.chatMessageId !== null) continue // forward: chat / DM message
      if (row.postId !== null) continue // forward: social post
      if (this.avatarMediaIds.has(row.id)) continue // reverse: user / group avatar
      if (row.purpose === "verification") continue // out-of-band: user_verification.documents
      if (row.createdAt < olderThan) {
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

  /** Test accessor: read the full stored row (including loose width/height/phash/codec). */
  get(id: string): (StoredWorkerMedia & Record<string, unknown>) | undefined {
    return this.byId.get(id) as (StoredWorkerMedia & Record<string, unknown>) | undefined
  }
}
