/**
 * Discussion service: the per-report public comment thread (top-level messages + one level of replies),
 * lightweight emoji reactions, attachments, and the @city-mention -> best-effort city-forward path.
 *
 * It ties together the discussion tables (report_discussion_messages / report_message_reactions /
 * report_message_mentions), the report's visibility rules (reused from the reports domain), the media
 * presign helper (the SAME url-pair signer the report service uses), the report's resolved jurisdiction
 * (geoid -> name/handle/contact_emails), and the OutboundMailService city-forward seam. All DB access sits
 * behind a DiscussionRepository seam (Drizzle impl in discussion-repository.drizzle.ts; an in-memory fake in
 * test/helpers/discussion.ts), mirroring the reports/admin pattern so the service is unit-testable with no
 * database and no Docker.
 *
 * CITY MENTION + FORWARD (createMessage): the message's report has (at most) one OWN jurisdiction. We
 * resolve that jurisdiction's name + handle (handle derived on the fly via jurisdictionHandle when the
 * column is NULL) + first contact email. If the body @mentions THAT handle (parseCityMention, word-boundary,
 * case-insensitive) we attempt a best-effort forward via OutboundMailService.sendToCity and record a
 * report_message_mentions row with forwarded_to_city=true + forwarded_at. CRUCIALLY, when no contact email
 * is on file we STILL POST the message (forwardedToCity=false, mention recorded with forwarded_at=null) - we
 * do NOT throw a 422. This DIFFERS from the admin sendFollowup-to-city path, which rejects when no contact
 * exists; a citizen comment is a public post first and a forward second.
 *
 * REPLY DEPTH: replies are ONE level deep. A parentId must reference a TOP-LEVEL (parent_id IS NULL),
 * non-deleted message of THIS SAME report; a reply-of-a-reply or a cross-report parent is rejected (422).
 *
 * SOFT DELETE: deleteMessage sets deleted_at (a tombstone) so reply subtrees + reaction counts survive
 * moderation. The author OR an operator may delete; the returned DTO is the tombstoned message (author
 * nulled, body blanked) so a caller can render "[removed]" without a refetch.
 */

import { randomUUID } from "node:crypto"
import { AppError } from "@civfix/shared"
import { avatarGradient } from "@civfix/shared"
import type {
  DiscussionAuthorDTO,
  DiscussionMessageDTO,
  DiscussionPageResponse,
  MediaDTO,
  ReactionEmoji,
  ReactionSummaryDTO,
} from "@civfix/shared"
import { jurisdictionHandle, parseCityMention } from "./discussion-mentions.js"
import type { OutboundMailService } from "./admin/outbound-mail-service.js"

// ---------------------------------------------------------------------------
// Config constants
// ---------------------------------------------------------------------------

/** Default page size for a discussion page when the request omits `limit`. Matches the shared cap of 50. */
export const DISCUSSION_DEFAULT_LIMIT = 20

/** Max attachments a single discussion message may carry (mirrors report media's cap of 5). */
export const DISCUSSION_MEDIA_MAX = 5

// ---------------------------------------------------------------------------
// Repository seam (structural views; faked in tests)
// ---------------------------------------------------------------------------

/** The author (a claimed user) of a discussion message, as the repo resolves it. NULL for system rows. */
export interface DiscussionAuthorView {
  id: string
  displayName: string
  handle: string | null
}

/** A media row attached to a discussion message (raw object-store keys; the service presigns them). */
export interface DiscussionMediaView {
  id: string
  kind: "image" | "video"
  codec: string | null
  r2Key: string
  thumbKey: string | null
  status: "validating" | "ready" | "rejected" | "held"
  width: number | null
  height: number | null
}

/** One reaction bucket on a message as the repo aggregates it (emoji + count + whether the viewer reacted). */
export interface DiscussionReactionView {
  emoji: string
  count: number
  mine: boolean
}

/** The jurisdiction @mention recorded on a message (the geoid + whether it was forwarded). */
export interface DiscussionMentionView {
  geoid: string
  name: string
  /** Stored handle (jurisdictions.handle); NULL when never set -> the service derives one on the fly. */
  handle: string | null
  forwarded: boolean
}

/**
 * A discussion message row joined with everything a DTO needs EXCEPT the presigned media URLs (the service
 * presigns the raw keys) and the per-emoji `mine` (computed against the viewer). `authorUserId` is the raw
 * author id (null for a system row); `author` is the resolved person view (null when the message is
 * soft-removed OR system-authored). `deletedAt` non-null marks a tombstone.
 */
export interface DiscussionMessageRecord {
  id: string
  reportId: string
  parentId: string | null
  authorUserId: string | null
  author: DiscussionAuthorView | null
  body: string
  forwardedToCity: boolean
  createdAt: Date
  editedAt: Date | null
  deletedAt: Date | null
  /** Count of NON-deleted direct children (replies). Always 0 for a reply (replies are one level deep). */
  replyCount: number
  attachments: DiscussionMediaView[]
  reactions: DiscussionReactionView[]
  /** The single @city mention on this message, or null. */
  mention: DiscussionMentionView | null
}

/** The report's own jurisdiction routing the city-forward path needs (resolved from the report's geoid). */
export interface ReportJurisdictionView {
  geoid: string
  name: string
  /** Stored jurisdictions.handle; NULL -> derive via jurisdictionHandle(name). */
  handle: string | null
  /** First usable contact email on file (per-category -> default -> legacy), or null when none. */
  contactEmail: string | null
}

/** A report's minimal visibility handle (mirrors the reports domain's visibility rule, faked in tests). */
export interface DiscussionReportView {
  id: string
  reporterUserId: string | null
  status: string
  visibility: string
  deletedAt: Date | null
  /** The report's resolved jurisdiction (name/handle/contact), or null when the report is Unmapped. */
  jurisdiction: ReportJurisdictionView | null
  /** Report context the city-forward email carries (for the operator trail). */
  category: string
  place: string | null
}

/** Args the repo's createMessage persists (mention + forward already decided by the service). */
export interface CreateDiscussionMessageTxArgs {
  messageId: string
  reportId: string
  parentId: string | null
  authorUserId: string
  body: string
  createdAt: Date
  /** Finalized upload ids to attach to this message (set discussion_message_id; unattached/own only). */
  mediaUploadIds: string[]
  /** When the body @mentioned the report's own jurisdiction, the mention to record (else null). */
  mention: {
    geoid: string
    /** Whether the forward actually went out (a contact existed + sendToCity succeeded). */
    forwarded: boolean
    forwardedAt: Date | null
  } | null
  /** Set report_discussion_messages.forwarded_to_city (true only when the forward actually went out). */
  forwardedToCity: boolean
}

/**
 * Persistence seam for the discussion domain. The Drizzle impl runs raw SQL; the offline tests pass an
 * in-memory impl. Keeping every read/write here is what makes the service unit-testable with no DB.
 */
export interface DiscussionRepository {
  /** Load a report's visibility handle + its resolved jurisdiction, or null when the report does not exist. */
  findReportForDiscussion(reportId: string): Promise<DiscussionReportView | null>
  /** Load a single message record (any parent_id, including deleted), or null. Used by reaction/delete. */
  findMessage(
    reportId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<DiscussionMessageRecord | null>
  /**
   * Page top-level (parent_id IS NULL) messages of a report, oldest-first keyset. Each record carries
   * replyCount, reactions (with `mine` resolved for the viewer), attachments, and its mention. By default
   * NON-deleted messages only (the public read); pass includeDeleted=true (the operator read) to ALSO
   * return soft-removed (tombstoned) rows so moderation can see them — the service still blanks the body /
   * nulls the author when projecting a tombstone, so removed content never leaks even to an operator.
   */
  listTopLevel(
    reportId: string,
    viewerUserId: string | null,
    cursor: string | null,
    limit: number,
    includeDeleted?: boolean,
  ): Promise<{ records: DiscussionMessageRecord[]; nextCursor: string | null }>
  /**
   * Page the replies (children) of a top-level message, same shape + keyset as listTopLevel. NON-deleted by
   * default; includeDeleted=true (operator) ALSO returns tombstones.
   */
  listReplies(
    reportId: string,
    parentId: string,
    viewerUserId: string | null,
    cursor: string | null,
    limit: number,
    includeDeleted?: boolean,
  ): Promise<{ records: DiscussionMessageRecord[]; nextCursor: string | null }>
  /**
   * Insert a message (+ attach media, + record a mention row when present) atomically, then read it back as
   * a record for the viewer (the author). Mirrors the report-create media-attach rule: bind only an upload
   * whose discussion_message_id is NULL (unattached) or already this message; never steal a foreign one.
   */
  createMessage(args: CreateDiscussionMessageTxArgs): Promise<DiscussionMessageRecord>
  /**
   * Toggle a reaction: insert (message,user,emoji) ON CONFLICT DO NOTHING, or DELETE it when already
   * present. Returns true when the reaction is now PRESENT (added), false when it was removed.
   */
  toggleReaction(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean>
  /** Soft-delete a message (set deleted_at = now). Returns false when the message does not exist. */
  softDelete(messageId: string, deletedAt: Date): Promise<boolean>
  /**
   * Count a report's NON-deleted TOP-LEVEL (parent_id IS NULL) discussion messages. Backs the report
   * DETAIL's `discussionCount` (replies are not counted, matching the thread's top-level render).
   */
  countTopLevel(reportId: string): Promise<number>
}

// ---------------------------------------------------------------------------
// Pure helpers (no DB, no IO) re-exported for callers/tests
// ---------------------------------------------------------------------------

export { parseCityMention, jurisdictionHandle } from "./discussion-mentions.js"

/** Resolve a jurisdiction's effective handle: the stored column, else derived from the name (may be null). */
export function effectiveJurisdictionHandle(j: {
  handle: string | null
  name: string
}): string | null {
  return j.handle ?? jurisdictionHandle(j.name)
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface DiscussionServiceDeps {
  repo: DiscussionRepository
  /**
   * Presign (or otherwise render) a media object's URL pair, wrapping the Storage seam - the SAME signer
   * the report service uses. The repo returns raw object-store KEYS; the service presigns them so the
   * client gets loadable URLs. Injected so the service stays free of the storage SDK and is fakeable.
   */
  presignMedia: (
    r2Key: string,
    thumbKey: string | null,
  ) => Promise<{ url: string; thumbUrl?: string }>
  /** The outbound-mail service used for the best-effort @city forward. */
  outboundMail: OutboundMailService
  /**
   * Best-effort live fan-out: after each successful write the service fires this with the report id + the
   * discussion event so subscribers of the report-discussion WS room learn "something changed" and refetch.
   * Wired in DI over ChatService.broadcastEvent + roomKeyFor("report_discussion", reportId). OPTIONAL and
   * fire-and-forget: a fan-out failure must NEVER affect the HTTP response (the caller already swallows it),
   * and an un-wired path (offline tests) simply skips the signal.
   */
  broadcast?: (reportId: string, event: DiscussionEvent) => void
  /**
   * Best-effort notification hook fired AFTER a top-level message or a reply is created. Lets the route
   * wire the report-owner / parent-author bell (a `report_update` notification + the inline push/signal)
   * WITHOUT the service importing the notification service. OPTIONAL and fully fire-and-forget: a notify
   * failure must NEVER affect the HTTP response, and an un-wired path skips it. The actor (author) is passed
   * so the hook can exclude self-notifications.
   */
  notifyOnMessage?: (input: DiscussionNotifyInput) => void
  /** Injectable id factory (defaults to crypto.randomUUID) for deterministic tests. */
  newId?: () => string
  /** Injectable clock (defaults to () => new Date()) so created_at/forwarded_at are deterministic in tests. */
  now?: () => Date
}

/** The discussion write events fanned out over the report-discussion WS room (matches the WS frame enum). */
export type DiscussionEvent = "message" | "reply" | "reaction" | "remove"

/** Input to the best-effort post-create notification hook (report-owner / parent-author bell). */
export interface DiscussionNotifyInput {
  reportId: string
  /** The author of the new message (excluded from self-notification). */
  actorUserId: string
  /** The report's owner (reporter) user id, or null for an anonymous report. */
  reportOwnerUserId: string | null
  /** For a reply, the parent message's author user id (or null); absent/null for a top-level message. */
  parentAuthorUserId: string | null
  /** Whether this was a reply (true) or a top-level message (false). */
  isReply: boolean
}

/** Who is acting on a delete: the message author themselves, or an operator (moderation). */
export interface DiscussionActor {
  userId: string
  isOperator: boolean
}

export interface DiscussionService {
  /** Page a report's top-level discussion messages (parent_id IS NULL), newest content excluded if deleted. */
  list(
    reportId: string,
    viewerUserId: string | null,
    cursor: string | null,
    limit: number,
  ): Promise<DiscussionPageResponse>
  /**
   * Operator view: page a report's top-level discussion messages INCLUDING soft-removed (tombstoned) ones,
   * so moderation can see what was removed. No report-visibility gate (the operator scope already gated the
   * route); a soft-removed row is still projected as a tombstone (body blanked, author nulled), so removed
   * content does not leak even to an operator — only its existence + reaction/reply counts.
   */
  listForOperator(
    reportId: string,
    cursor: string | null,
    limit: number,
  ): Promise<DiscussionPageResponse>
  /** Page the replies of a top-level message of this report. */
  listReplies(
    reportId: string,
    messageId: string,
    viewerUserId: string | null,
    cursor: string | null,
    limit: number,
  ): Promise<DiscussionPageResponse>
  /** Create a top-level message or a reply; resolves + best-effort forwards an @city mention. */
  createMessage(
    reportId: string,
    userId: string,
    input: { body: string; parentId?: string | undefined; mediaUploadIds?: string[] | undefined },
  ): Promise<DiscussionMessageDTO>
  /** Toggle one of the viewer's emoji reactions on a message; returns the updated message. */
  toggleReaction(
    reportId: string,
    messageId: string,
    userId: string,
    emoji: ReactionEmoji,
  ): Promise<DiscussionMessageDTO>
  /** Soft-delete a message (author or operator); returns the tombstoned message. */
  deleteMessage(
    reportId: string,
    messageId: string,
    actor: DiscussionActor,
  ): Promise<DiscussionMessageDTO>
}

export function makeDiscussionService(deps: DiscussionServiceDeps): DiscussionService {
  const newId = deps.newId ?? (() => randomUUID())
  const now = deps.now ?? (() => new Date())

  /**
   * Fire the best-effort live fan-out for a discussion write. Fully fire-and-forget: the broadcast dep is
   * already wrapped to swallow its own failures (a void/catch in DI), so an un-wired or failing fan-out can
   * never affect the HTTP response. No-op when no broadcast is wired (offline tests).
   */
  function fanOut(reportId: string, event: DiscussionEvent): void {
    deps.broadcast?.(reportId, event)
  }

  /** Render a stored media view into a presigned MediaDTO (only `ready` media reaches here). */
  async function toMediaDTO(view: DiscussionMediaView): Promise<MediaDTO> {
    const { url, thumbUrl } = await deps.presignMedia(view.r2Key, view.thumbKey)
    return {
      id: view.id,
      kind: view.kind,
      codec: view.codec,
      url,
      ...(thumbUrl !== undefined ? { thumbUrl } : {}),
      width: view.width,
      height: view.height,
      status: view.status,
    }
  }

  /** Project a resolved author view into the wire DiscussionAuthorDTO (avatar gradient derived from id). */
  function toAuthorDTO(view: DiscussionAuthorView): DiscussionAuthorDTO {
    return {
      id: view.id,
      displayName: view.displayName,
      handle: view.handle,
      avatar: avatarGradient(view.id),
    }
  }

  /** Project a reaction aggregate into the wire ReactionSummaryDTO. */
  function toReactionDTO(view: DiscussionReactionView): ReactionSummaryDTO {
    return { emoji: view.emoji, count: view.count, mine: view.mine }
  }

  /**
   * Assemble a full DiscussionMessageDTO from a record, presigning ready attachments. A soft-deleted
   * (tombstoned) record is rendered with a null author + blanked body + no attachments so a moderated
   * message cannot leak its original content, while its reply subtree + reaction counts survive.
   */
  async function toMessageDTO(
    record: DiscussionMessageRecord,
    viewerUserId: string | null,
  ): Promise<DiscussionMessageDTO> {
    const tombstoned = record.deletedAt !== null
    // Only `ready` attachments are served (held/rejected/validating are hidden), matching the report read.
    const readyMedia = tombstoned
      ? []
      : record.attachments.filter((m) => m.status === "ready")
    const attachments = await Promise.all(readyMedia.map(toMediaDTO))
    const mine = viewerUserId !== null && record.authorUserId === viewerUserId
    const cityMention =
      record.mention !== null
        ? {
            // Prefer the stored handle; derive on the fly when NULL (the column may be unset at read time).
            handle: effectiveJurisdictionHandle(record.mention) ?? record.mention.geoid,
            geoid: record.mention.geoid,
            name: record.mention.name,
            forwarded: record.mention.forwarded,
          }
        : null
    return {
      id: record.id,
      reportId: record.reportId,
      parentId: record.parentId,
      author: tombstoned || record.author === null ? null : toAuthorDTO(record.author),
      body: tombstoned ? "" : record.body,
      attachments,
      reactions: record.reactions.map(toReactionDTO),
      replyCount: record.replyCount,
      cityMention,
      forwardedToCity: record.forwardedToCity,
      createdAt: record.createdAt.toISOString(),
      ...(record.editedAt !== null ? { editedAt: record.editedAt.toISOString() } : {}),
      ...(record.deletedAt !== null ? { deletedAt: record.deletedAt.toISOString() } : {}),
      mine,
    }
  }

  /**
   * Load + visibility-check the report a discussion call targets. A missing / soft-deleted report, and any
   * report that is not (published AND public) UNLESS the viewer owns it, yields a 404 (notFound, never a
   * 403 that would leak existence) - mirroring report-service.getReport exactly.
   */
  async function loadVisibleReport(
    reportId: string,
    viewerUserId: string | null,
  ): Promise<DiscussionReportView> {
    const report = await deps.repo.findReportForDiscussion(reportId)
    if (!report || report.deletedAt !== null) {
      throw AppError.notFound("Report not found")
    }
    const mine = viewerUserId !== null && report.reporterUserId === viewerUserId
    const isPublic = report.status === "published" && report.visibility === "public"
    if (!isPublic && !mine) {
      throw AppError.notFound("Report not found")
    }
    return report
  }

  return {
    async list(
      reportId: string,
      viewerUserId: string | null,
      cursor: string | null,
      limit: number,
    ): Promise<DiscussionPageResponse> {
      await loadVisibleReport(reportId, viewerUserId)
      const { records, nextCursor } = await deps.repo.listTopLevel(
        reportId,
        viewerUserId,
        cursor,
        clampLimit(limit),
      )
      const items = await Promise.all(records.map((r) => toMessageDTO(r, viewerUserId)))
      return { items, nextCursor }
    },

    async listForOperator(
      reportId: string,
      cursor: string | null,
      limit: number,
    ): Promise<DiscussionPageResponse> {
      // Operator scope already gates the route; we do NOT run loadVisibleReport (an operator can read the
      // discussion of a held/hidden report). includeDeleted=true so soft-removed rows are returned; the
      // viewer is null (an operator has no personal `mine`/reaction state in this read), and toMessageDTO
      // still tombstones a removed row so its body/author never leak.
      const { records, nextCursor } = await deps.repo.listTopLevel(
        reportId,
        null,
        cursor,
        clampLimit(limit),
        true,
      )
      const items = await Promise.all(records.map((r) => toMessageDTO(r, null)))
      return { items, nextCursor }
    },

    async listReplies(
      reportId: string,
      messageId: string,
      viewerUserId: string | null,
      cursor: string | null,
      limit: number,
    ): Promise<DiscussionPageResponse> {
      await loadVisibleReport(reportId, viewerUserId)
      // The parent must be a TOP-LEVEL, non-deleted message of THIS report; otherwise 404 (treat a missing
      // or non-top-level parent as "no such thread" rather than leaking a reply/cross-report id).
      const parent = await deps.repo.findMessage(reportId, messageId, viewerUserId)
      if (!parent || parent.deletedAt !== null || parent.parentId !== null) {
        throw AppError.notFound("Message not found")
      }
      const { records, nextCursor } = await deps.repo.listReplies(
        reportId,
        messageId,
        viewerUserId,
        cursor,
        clampLimit(limit),
      )
      const items = await Promise.all(records.map((r) => toMessageDTO(r, viewerUserId)))
      return { items, nextCursor }
    },

    async createMessage(
      reportId: string,
      userId: string,
      input: {
        body: string
        parentId?: string | undefined
        mediaUploadIds?: string[] | undefined
      },
    ): Promise<DiscussionMessageDTO> {
      const report = await loadVisibleReport(reportId, userId)

      const body = input.body.trim()
      if (body === "") {
        throw AppError.validation({ body: "Message body is required" })
      }

      // A reply must target a TOP-LEVEL, non-deleted message of THIS report (one level deep, same report).
      const parentId = input.parentId ?? null
      let parentAuthorUserId: string | null = null
      if (parentId !== null) {
        const parent = await deps.repo.findMessage(reportId, parentId, userId)
        if (!parent || parent.deletedAt !== null) {
          throw AppError.validation({ parentId: "Parent message not found" })
        }
        if (parent.reportId !== reportId) {
          throw AppError.validation({ parentId: "Parent belongs to another report" })
        }
        if (parent.parentId !== null) {
          throw AppError.validation({ parentId: "Replies cannot be nested" })
        }
        // Captured for the best-effort reply notification (parent author, excluding the actor).
        parentAuthorUserId = parent.authorUserId
      }

      const mediaUploadIds = (input.mediaUploadIds ?? []).slice(0, DISCUSSION_MEDIA_MAX)
      const messageId = newId()
      const createdAt = now()

      // CITY MENTION: only the report's OWN jurisdiction is mentionable/forwardable. Resolve its effective
      // handle (stored or derived) and check the body for "@handle". A mention with no contact on file is
      // STILL recorded (and the message still posts) - we just do not forward; we never 422 here.
      let mention: CreateDiscussionMessageTxArgs["mention"] = null
      let forwardedToCity = false
      const jurisdiction = report.jurisdiction
      if (jurisdiction !== null) {
        const handle = effectiveJurisdictionHandle(jurisdiction)
        if (handle !== null && parseCityMention(body, handle) !== null) {
          const contact = jurisdiction.contactEmail
          let forwarded = false
          let forwardedAt: Date | null = null
          if (contact !== null && contact !== "") {
            // Best-effort forward. A delivery failure must NOT block the post: a thrown sendToCity is
            // swallowed so the comment still lands (forwardedToCity stays false), unlike the admin path
            // where a city follow-up with no contact is a hard 422.
            try {
              await deps.outboundMail.sendToCity({
                geoid: jurisdiction.geoid,
                toAddr: contact,
                subject: `civfix report ${reportId}`,
                body,
                reportContext: {
                  reportId,
                  category: report.category,
                  ...(report.place !== null ? { place: report.place } : {}),
                },
                org: jurisdiction.name,
              })
              forwarded = true
              forwardedAt = createdAt
            } catch {
              forwarded = false
              forwardedAt = null
            }
          }
          mention = { geoid: jurisdiction.geoid, forwarded, forwardedAt }
          forwardedToCity = forwarded
        }
      }

      const record = await deps.repo.createMessage({
        messageId,
        reportId,
        parentId,
        authorUserId: userId,
        body,
        createdAt,
        mediaUploadIds,
        mention,
        forwardedToCity,
      })
      const dto = await toMessageDTO(record, userId)
      // Best-effort live fan-out (a reply vs a top-level message), then the best-effort owner/parent bell.
      // Both are fire-and-forget and never affect this response.
      const isReply = parentId !== null
      fanOut(reportId, isReply ? "reply" : "message")
      deps.notifyOnMessage?.({
        reportId,
        actorUserId: userId,
        reportOwnerUserId: report.reporterUserId,
        parentAuthorUserId,
        isReply,
      })
      return dto
    },

    async toggleReaction(
      reportId: string,
      messageId: string,
      userId: string,
      emoji: ReactionEmoji,
    ): Promise<DiscussionMessageDTO> {
      await loadVisibleReport(reportId, userId)
      const message = await deps.repo.findMessage(reportId, messageId, userId)
      if (!message || message.deletedAt !== null) {
        throw AppError.notFound("Message not found")
      }
      await deps.repo.toggleReaction(messageId, userId, emoji)
      // Re-read so the returned DTO reflects the recomputed reaction counts + the viewer's `mine` flags.
      const updated = await deps.repo.findMessage(reportId, messageId, userId)
      if (!updated) throw AppError.notFound("Message not found")
      const dto = await toMessageDTO(updated, userId)
      // Best-effort live fan-out so other viewers refetch the recomputed reaction counts.
      fanOut(reportId, "reaction")
      return dto
    },

    async deleteMessage(
      reportId: string,
      messageId: string,
      actor: DiscussionActor,
    ): Promise<DiscussionMessageDTO> {
      // An operator can delete on any visible report; a regular author must own the message. We still gate
      // on report visibility for the author path (an operator caller has isOperator=true).
      await loadVisibleReport(reportId, actor.userId)
      const message = await deps.repo.findMessage(reportId, messageId, actor.userId)
      if (!message) throw AppError.notFound("Message not found")
      const isAuthor = message.authorUserId !== null && message.authorUserId === actor.userId
      if (!isAuthor && !actor.isOperator) {
        throw AppError.forbidden("You cannot delete this message")
      }
      // Already-deleted: return the existing tombstone (idempotent), do not re-stamp deleted_at; only fan out
      // a "remove" when this call ACTUALLY removed the message (avoid a redundant signal on an idempotent
      // re-delete).
      if (message.deletedAt === null) {
        const deletedAt = now()
        const ok = await deps.repo.softDelete(messageId, deletedAt)
        if (!ok) throw AppError.notFound("Message not found")
        message.deletedAt = deletedAt
        fanOut(reportId, "remove")
      }
      return toMessageDTO(message, actor.userId)
    },
  }
}

/** Clamp a requested page limit into [1, 50], defaulting to DISCUSSION_DEFAULT_LIMIT when undefined/<=0. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DISCUSSION_DEFAULT_LIMIT
  return Math.min(Math.floor(limit), 50)
}
