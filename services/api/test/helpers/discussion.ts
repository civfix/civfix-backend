/**
 * Offline discussion test helper: an in-memory DiscussionRepository (messages + reactions + mentions +
 * a tiny media/report store).
 *
 * Mirrors the Drizzle/PostGIS impl's OBSERVABLE contract so the discussion SERVICE (and later its HTTP
 * routes) can be exercised with NO database (no Docker), faithful to:
 *   - createMessage inserts the message, attaches media (bind only an upload whose discussionMessageId is
 *     null/own AND reportId is null AND status ready|validating; never steal a foreign asset), and records
 *     the @mention row when present - all "atomically".
 *   - listTopLevel / listReplies page NON-deleted messages oldest-first with an "<iso>|<id>" keyset cursor.
 *   - replyCount counts NON-deleted direct children; reactions aggregate per emoji with a per-viewer `mine`.
 *   - toggleReaction inserts/deletes one (message,user,emoji) row (idempotent insert via the composite PK).
 *   - softDelete stamps deletedAt once (idempotent: a second call on an already-deleted row is a no-op).
 *
 * The Drizzle-backed repository is covered by the Docker-gated integration test; this fake exercises the
 * same DiscussionRepository seam.
 */

import { randomUUID } from "node:crypto"
import type {
  CreateDiscussionMessageTxArgs,
  DiscussionMediaView,
  DiscussionMessageRecord,
  DiscussionReactionView,
  DiscussionReportView,
  DiscussionRepository,
} from "../../src/services/discussion-service.js"
import { jurisdictionHandle } from "../../src/services/discussion-service.js"
import type { ReactionEmoji, UserMentionDTO } from "@civfix/shared"

/** A stored discussion message (the raw row the fake holds). */
interface StoredMessage {
  id: string
  reportId: string
  parentId: string | null
  authorUserId: string | null
  body: string
  forwardedToCity: boolean
  createdAt: Date
  editedAt: Date | null
  deletedAt: Date | null
}

/** A stored media asset (the subset discussion linking reads + the discussionMessageId binding). */
export interface StoredDiscussionMedia {
  id: string
  uploadId: string
  reportId: string | null
  discussionMessageId: string | null
  kind: "image" | "video"
  codec: string | null
  r2Key: string
  thumbKey: string | null
  status: "validating" | "ready" | "rejected" | "held"
  width: number | null
  height: number | null
  createdAt: Date
}

interface StoredReaction {
  messageId: string
  userId: string
  emoji: string
  createdAt: Date
}

interface StoredMention {
  messageId: string
  geoid: string
  forwardedAt: Date | null
}

/** A stored USER @-mention row (report_message_user_mentions). */
interface StoredUserMention {
  messageId: string
  mentionedUserId: string
}

/** A seeded author (the users join the Drizzle impl performs). */
export interface SeededDiscussionAuthor {
  id: string
  displayName: string
  handle: string | null
}

/** A seeded jurisdiction (name/handle/contact resolved for a report). */
export interface SeededJurisdiction {
  geoid: string
  name: string
  handle: string | null
  contactEmail: string | null
}

/** An in-memory DiscussionRepository faithful to the Drizzle impl's observable behavior. */
export class InMemoryDiscussionRepository implements DiscussionRepository {
  readonly messages = new Map<string, StoredMessage>()
  readonly media: StoredDiscussionMedia[] = []
  readonly reactions: StoredReaction[] = []
  readonly mentions: StoredMention[] = []
  /** Persisted USER @-mention rows (report_message_user_mentions). */
  readonly userMentions: StoredUserMention[] = []
  /** Reports keyed by id (the visibility handle + resolved jurisdiction). */
  readonly reports = new Map<string, DiscussionReportView>()
  /** Authors keyed by id (the users join). */
  readonly authors = new Map<string, SeededDiscussionAuthor>()

  /** Monotonic clock so created_at ordering is deterministic across inserts in a single test. */
  private tick = 0
  private nextDate(): Date {
    this.tick += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, this.tick))
  }

  /** Seed an author the createMessage read can join. */
  seedAuthor(over: Partial<SeededDiscussionAuthor> & { id?: string } = {}): SeededDiscussionAuthor {
    const author: SeededDiscussionAuthor = {
      id: over.id ?? randomUUID(),
      displayName: over.displayName ?? "Jane Neighbor",
      handle: over.handle ?? "jane",
    }
    this.authors.set(author.id, author)
    return author
  }

  /** Seed a report's visibility handle + (optional) resolved jurisdiction. */
  seedReport(
    over: Partial<DiscussionReportView> & { id?: string; jurisdiction?: SeededJurisdiction | null },
  ): DiscussionReportView {
    const report: DiscussionReportView = {
      id: over.id ?? randomUUID(),
      reporterUserId: over.reporterUserId ?? null,
      status: over.status ?? "published",
      visibility: over.visibility ?? "public",
      deletedAt: over.deletedAt ?? null,
      jurisdiction: over.jurisdiction ?? null,
      category: over.category ?? "trash",
      place: over.place ?? "Somewhere, ST",
    }
    this.reports.set(report.id, report)
    return report
  }

  /** Seed a finalized media asset (as media-intake would have, both link columns still null). */
  seedMedia(over: Partial<StoredDiscussionMedia> = {}): StoredDiscussionMedia {
    const asset: StoredDiscussionMedia = {
      id: over.id ?? randomUUID(),
      uploadId: over.uploadId ?? randomUUID(),
      reportId: over.reportId ?? null,
      discussionMessageId: over.discussionMessageId ?? null,
      kind: over.kind ?? "image",
      codec: over.codec ?? null,
      r2Key: over.r2Key ?? `uploads/2026/01/${"a".repeat(64)}`,
      thumbKey: over.thumbKey ?? null,
      status: over.status ?? "ready",
      width: over.width ?? null,
      height: over.height ?? null,
      createdAt: over.createdAt ?? this.nextDate(),
    }
    this.media.push(asset)
    return asset
  }

  findReportForDiscussion(reportId: string): Promise<DiscussionReportView | null> {
    const r = this.reports.get(reportId)
    return Promise.resolve(r ? { ...r } : null)
  }

  findMessage(
    reportId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<DiscussionMessageRecord | null> {
    const m = this.messages.get(messageId)
    if (!m || m.reportId !== reportId) return Promise.resolve(null)
    return Promise.resolve(this.toRecord(m, viewerUserId))
  }

  listTopLevel(
    reportId: string,
    viewerUserId: string | null,
    cursor: string | null,
    limit: number,
    includeDeleted = false,
  ): Promise<{ records: DiscussionMessageRecord[]; nextCursor: string | null }> {
    return Promise.resolve(
      this.page(
        (m) =>
          m.reportId === reportId &&
          m.parentId === null &&
          (includeDeleted || m.deletedAt === null),
        viewerUserId,
        cursor,
        limit,
      ),
    )
  }

  listReplies(
    reportId: string,
    parentId: string,
    viewerUserId: string | null,
    cursor: string | null,
    limit: number,
    includeDeleted = false,
  ): Promise<{ records: DiscussionMessageRecord[]; nextCursor: string | null }> {
    return Promise.resolve(
      this.page(
        (m) =>
          m.reportId === reportId &&
          m.parentId === parentId &&
          (includeDeleted || m.deletedAt === null),
        viewerUserId,
        cursor,
        limit,
      ),
    )
  }

  createMessage(args: CreateDiscussionMessageTxArgs): Promise<DiscussionMessageRecord> {
    const stored: StoredMessage = {
      id: args.messageId,
      reportId: args.reportId,
      parentId: args.parentId,
      authorUserId: args.authorUserId,
      body: args.body,
      forwardedToCity: args.forwardedToCity,
      createdAt: args.createdAt,
      editedAt: null,
      deletedAt: null,
    }
    this.messages.set(stored.id, stored)

    // Attach media: bind only unattached/own AND report-unbound AND ready|validating assets.
    for (const uploadId of args.mediaUploadIds) {
      const asset = this.media.find((m) => m.uploadId === uploadId)
      if (
        asset &&
        (asset.discussionMessageId === null || asset.discussionMessageId === stored.id) &&
        asset.reportId === null &&
        (asset.status === "ready" || asset.status === "validating")
      ) {
        asset.discussionMessageId = stored.id
      }
    }

    // Record the @mention (composite PK de-dupes a repeat geoid for this message).
    if (args.mention !== null) {
      const exists = this.mentions.some(
        (x) => x.messageId === stored.id && x.geoid === args.mention!.geoid,
      )
      if (!exists) {
        this.mentions.push({
          messageId: stored.id,
          geoid: args.mention.geoid,
          forwardedAt: args.mention.forwardedAt,
        })
      }
    }

    // Record the resolved USER @-mentions (composite PK de-dupes).
    for (const mentionedUserId of args.mentionedUserIds) {
      const exists = this.userMentions.some(
        (x) => x.messageId === stored.id && x.mentionedUserId === mentionedUserId,
      )
      if (!exists) this.userMentions.push({ messageId: stored.id, mentionedUserId })
    }

    return Promise.resolve(this.toRecord(stored, args.authorUserId))
  }

  editMessage(
    reportId: string,
    messageId: string,
    authorId: string,
    body: string,
    editedAt: Date,
    mediaUploadIds: string[] | undefined,
    mentionedUserIds: string[],
  ): Promise<DiscussionMessageRecord | null> {
    const m = this.messages.get(messageId)
    // Match only this report's message authored by authorId and not soft-removed (else "no editable row").
    if (
      !m ||
      m.reportId !== reportId ||
      m.authorUserId !== authorId ||
      m.deletedAt !== null
    ) {
      return Promise.resolve(null)
    }
    m.body = body
    m.editedAt = editedAt

    // Optional attachment REPLACEMENT (omit to leave the set untouched): detach the message's current
    // attachments, then bind the given uploads under the same unattached/own + report-unbound + ready rule.
    if (mediaUploadIds !== undefined) {
      for (const asset of this.media) {
        if (asset.discussionMessageId === messageId) asset.discussionMessageId = null
      }
      for (const uploadId of mediaUploadIds) {
        const asset = this.media.find((a) => a.uploadId === uploadId)
        if (
          asset &&
          (asset.discussionMessageId === null || asset.discussionMessageId === messageId) &&
          asset.reportId === null &&
          (asset.status === "ready" || asset.status === "validating")
        ) {
          asset.discussionMessageId = messageId
        }
      }
    }

    // REPLACE the USER @-mention set: drop the message's current rows, then insert the new resolved set.
    for (let i = this.userMentions.length - 1; i >= 0; i--) {
      if (this.userMentions[i]!.messageId === messageId) this.userMentions.splice(i, 1)
    }
    for (const mentionedUserId of mentionedUserIds) {
      const exists = this.userMentions.some(
        (x) => x.messageId === messageId && x.mentionedUserId === mentionedUserId,
      )
      if (!exists) this.userMentions.push({ messageId, mentionedUserId })
    }

    return Promise.resolve(this.toRecord(m, authorId))
  }

  toggleReaction(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean> {
    const idx = this.reactions.findIndex(
      (r) => r.messageId === messageId && r.userId === userId && r.emoji === emoji,
    )
    if (idx >= 0) {
      this.reactions.splice(idx, 1)
      return Promise.resolve(false)
    }
    this.reactions.push({ messageId, userId, emoji, createdAt: this.nextDate() })
    return Promise.resolve(true)
  }

  softDelete(messageId: string, deletedAt: Date): Promise<boolean> {
    const m = this.messages.get(messageId)
    if (!m || m.deletedAt !== null) return Promise.resolve(false)
    m.deletedAt = deletedAt
    return Promise.resolve(true)
  }

  countTopLevel(reportId: string): Promise<number> {
    const count = [...this.messages.values()].filter(
      (m) => m.reportId === reportId && m.parentId === null && m.deletedAt === null,
    ).length
    return Promise.resolve(count)
  }

  // --- internals ---------------------------------------------------------

  private page(
    pred: (m: StoredMessage) => boolean,
    viewerUserId: string | null,
    cursor: string | null,
    limit: number,
  ): { records: DiscussionMessageRecord[]; nextCursor: string | null } {
    const anchor = parseCursor(cursor)
    const after = (m: StoredMessage): boolean => {
      if (anchor === null) return true
      const t = m.createdAt.getTime()
      if (t !== anchor.at) return t > anchor.at
      return m.id > anchor.id // oldest-first: strictly greater id on a created_at tie
    }
    const all = [...this.messages.values()]
      .filter(pred)
      .filter(after)
      .sort((a, b) => {
        const cmp = a.createdAt.getTime() - b.createdAt.getTime()
        if (cmp !== 0) return cmp
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
    const hasMore = all.length > limit
    const pageRows = hasMore ? all.slice(0, limit) : all
    const last = pageRows[pageRows.length - 1]
    const nextCursor =
      hasMore && last ? `${last.createdAt.toISOString()}|${last.id}` : null
    return { records: pageRows.map((m) => this.toRecord(m, viewerUserId)), nextCursor }
  }

  private toRecord(m: StoredMessage, viewerUserId: string | null): DiscussionMessageRecord {
    const author =
      m.authorUserId !== null ? (this.authors.get(m.authorUserId) ?? null) : null
    const replyCount = [...this.messages.values()].filter(
      (c) => c.parentId === m.id && c.deletedAt === null,
    ).length
    const attachments: DiscussionMediaView[] = this.media
      .filter((a) => a.discussionMessageId === m.id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((a) => ({
        id: a.id,
        kind: a.kind,
        codec: a.codec,
        r2Key: a.r2Key,
        thumbKey: a.thumbKey,
        status: a.status,
        width: a.width,
        height: a.height,
      }))
    // Aggregate reactions per emoji, with a per-viewer `mine`.
    const byEmoji = new Map<string, { count: number; mine: boolean }>()
    for (const r of this.reactions.filter((x) => x.messageId === m.id)) {
      const bucket = byEmoji.get(r.emoji) ?? { count: 0, mine: false }
      bucket.count += 1
      if (viewerUserId !== null && r.userId === viewerUserId) bucket.mine = true
      byEmoji.set(r.emoji, bucket)
    }
    const reactions: DiscussionReactionView[] = [...byEmoji.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([emoji, v]) => ({ emoji, count: v.count, mine: v.mine }))
    // Resolve the USER @-mentions to UserMentionDTO (handle/displayName from the seeded authors store; the
    // Drizzle impl joins users). Ordered by handle then id, mirroring the SQL ORDER BY.
    const userMentions: UserMentionDTO[] = this.userMentions
      .filter((x) => x.messageId === m.id)
      .map((x) => {
        const u = this.authors.get(x.mentionedUserId)
        return {
          id: x.mentionedUserId,
          handle: u?.handle ?? "",
          displayName: u?.displayName ?? `User ${x.mentionedUserId.slice(0, 4)}`,
        }
      })
      .sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : a.id < b.id ? -1 : 1))
    const mentionRow = this.mentions.find((x) => x.messageId === m.id) ?? null
    const report = this.reports.get(m.reportId)
    const jurisdiction =
      mentionRow !== null && report?.jurisdiction?.geoid === mentionRow.geoid
        ? report.jurisdiction
        : null
    const mention =
      mentionRow !== null
        ? {
            geoid: mentionRow.geoid,
            name: jurisdiction?.name ?? mentionRow.geoid,
            handle: jurisdiction?.handle ?? jurisdictionHandle(jurisdiction?.name ?? null),
            forwarded: mentionRow.forwardedAt !== null,
          }
        : null
    return {
      id: m.id,
      reportId: m.reportId,
      parentId: m.parentId,
      authorUserId: m.authorUserId,
      author:
        author !== null
          ? { id: author.id, displayName: author.displayName, handle: author.handle }
          : null,
      body: m.body,
      forwardedToCity: m.forwardedToCity,
      createdAt: m.createdAt,
      editedAt: m.editedAt,
      deletedAt: m.deletedAt,
      replyCount,
      attachments,
      reactions,
      userMentions,
      mention,
    }
  }
}

/** Parse a "<iso>|<id>" oldest-first cursor into { at(ms), id }; null when absent/malformed. */
function parseCursor(cursor: string | null): { at: number; id: string } | null {
  if (cursor === null) return null
  const idx = cursor.indexOf("|")
  if (idx < 0) return null
  const at = new Date(cursor.slice(0, idx)).getTime()
  const id = cursor.slice(idx + 1)
  if (Number.isNaN(at) || id.length === 0) return null
  return { at, id }
}
