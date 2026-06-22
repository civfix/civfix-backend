/**
 * Discussion service: the per-report public comment thread (top-level messages + one level of replies),
 * lightweight emoji reactions, attachments, and the @city-mention -> best-effort city-forward path.
 *
 * CITY MENTION + FORWARD (createMessage): the report has (at most) one OWN jurisdiction. If the body
 * @mentions THAT handle we attempt a best-effort forward via OutboundMailService.sendToCity and record a
 * mention row. CRUCIALLY, when no contact email is on file we STILL POST the message (forwardedToCity=false,
 * forwarded_at=null) — we do NOT 422. This DIFFERS from the admin sendFollowup-to-city path, which rejects
 * when no contact exists; a citizen comment is a public post first and a forward second.
 *
 * REPLY DEPTH: one level deep. A parentId must reference a TOP-LEVEL (parent_id IS NULL), non-deleted
 * message of THIS SAME report; a reply-of-a-reply or a cross-report parent is rejected (422).
 *
 * SOFT DELETE: deleteMessage sets deleted_at (a tombstone) so reply subtrees + reaction counts survive
 * moderation. The author OR an operator may delete; the returned DTO is the tombstoned message (author
 * nulled, body blanked) so a caller can render "[removed]" without a refetch.
 */

import { randomUUID } from "node:crypto"
import { AppError } from "@civfix/shared"
import type { DiscussionMessageDTO, MediaDTO, UserMentionDTO } from "@civfix/shared"
import { assertNoSlur } from "../abuse/slur-filter.js"
import { parseCityMention, parseUserMentions } from "./discussion-mentions.js"
import { mapWithLimit, PRESIGN_CONCURRENCY } from "./media-presign.js"
import {
  DISCUSSION_MEDIA_MAX,
  type CreateDiscussionMessageTxArgs,
  type DiscussionEvent,
  type DiscussionMediaView,
  type DiscussionMessageRecord,
  type DiscussionReportView,
  type DiscussionService,
  type DiscussionServiceDeps,
} from "./discussion-types.js"
import {
  clampLimit,
  effectiveJurisdictionHandle,
  toMediaDTO,
  toMessageDTO,
} from "./discussion-projection.js"

export * from "./discussion-types.js"
export { parseCityMention, jurisdictionHandle } from "./discussion-mentions.js"
export { effectiveJurisdictionHandle } from "./discussion-projection.js"

export function makeDiscussionService(deps: DiscussionServiceDeps): DiscussionService {
  const newId = deps.newId ?? (() => randomUUID())
  const now = deps.now ?? (() => new Date())

  function fanOut(reportId: string, event: DiscussionEvent): void {
    deps.broadcast?.(reportId, event)
  }

  // Resolve a message's USER @-mentions: parse @handles from the body + the request's explicit ids, resolve
  // to real, mentionable users (self excluded). Un-wired resolver (offline tests) => no mention rows.
  async function resolveUserMentions(
    body: string,
    mentionedUserIds: string[] | undefined,
    authorUserId: string,
  ): Promise<UserMentionDTO[]> {
    if (!deps.resolveMentions) return []
    const handles = parseUserMentions(body)
    const userIds = mentionedUserIds ?? []
    if (handles.length === 0 && userIds.length === 0) return []
    return deps.resolveMentions({ handles, userIds, authorUserId })
  }

  // VISIBILITY GATE: a mention on a NON-public report must not bell a user who would 404 the report on tap,
  // so a bell fires only when the report is public OR the mentioned user owns the report (mirroring
  // loadVisibleReport's read rule). The mention row itself is recorded regardless; this gates only the bell.
  function notifyMentions(
    reportId: string,
    actorUserId: string,
    mentions: UserMentionDTO[],
    report: DiscussionReportView,
  ): void {
    if (!deps.notifyMention) return
    const isPublic = report.status === "published" && report.visibility === "public"
    for (const m of mentions) {
      if (m.id === actorUserId) continue
      if (!isPublic && m.id !== report.reporterUserId) continue
      deps.notifyMention({ reportId, actorUserId, mentionedUserId: m.id })
    }
  }

  // Bound the per-message presign fan-out so a 50-record page x 5 attachments can't fire hundreds of
  // concurrent SigV4 signings; passed into the projector so the cap lives in one place.
  function presignAttachments(views: DiscussionMediaView[]): Promise<MediaDTO[]> {
    return mapWithLimit(views, PRESIGN_CONCURRENCY, (v) => toMediaDTO(v, deps.presignMedia))
  }

  // Bounded per-page projection: cap the number of records presigned concurrently AND (inside each record)
  // the attachment presigns, so neither dimension fans out unbounded.
  function projectPage(
    records: DiscussionMessageRecord[],
    viewerUserId: string | null,
  ): Promise<DiscussionMessageDTO[]> {
    return mapWithLimit(records, PRESIGN_CONCURRENCY, (r) =>
      toMessageDTO(r, viewerUserId, presignAttachments),
    )
  }

  function projectOne(
    record: DiscussionMessageRecord,
    viewerUserId: string | null,
  ): Promise<DiscussionMessageDTO> {
    return toMessageDTO(record, viewerUserId, presignAttachments)
  }

  // A missing / soft-deleted report, and any report that is not (published AND public) UNLESS the viewer
  // owns it, yields a 404 (never a 403 that would leak existence) — mirroring report-service.getReport.
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

  // Resolve the @city mention + best-effort forward for a new message. Only the report's OWN jurisdiction is
  // mentionable/forwardable. A mention with no contact on file is STILL recorded (and the message still
  // posts) — we just do not forward; we never 422 here (unlike the admin city follow-up path).
  async function resolveCityForward(
    report: DiscussionReportView,
    body: string,
    reportId: string,
    createdAt: Date,
  ): Promise<{ mention: CreateDiscussionMessageTxArgs["mention"]; forwardedToCity: boolean }> {
    const jurisdiction = report.jurisdiction
    if (jurisdiction === null) return { mention: null, forwardedToCity: false }
    const handle = effectiveJurisdictionHandle(jurisdiction)
    if (handle === null || parseCityMention(body, handle) === null) {
      return { mention: null, forwardedToCity: false }
    }
    const contact = jurisdiction.contactEmail
    let forwarded = false
    let forwardedAt: Date | null = null
    if (contact !== null && contact !== "") {
      // A delivery failure must NOT block the post: a thrown sendToCity is swallowed so the comment still
      // lands (forwardedToCity stays false).
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
    return { mention: { geoid: jurisdiction.geoid, forwarded, forwardedAt }, forwardedToCity: forwarded }
  }

  // A reply must target a TOP-LEVEL, non-deleted message of THIS report (one level deep, same report).
  // Returns the parent's author id (for the best-effort reply bell) or null for a top-level message.
  async function assertValidParent(
    reportId: string,
    parentId: string | null,
    userId: string,
  ): Promise<string | null> {
    if (parentId === null) return null
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
    return parent.authorUserId
  }

  return {
    async list(reportId, viewerUserId, cursor, limit) {
      await loadVisibleReport(reportId, viewerUserId)
      const { records, nextCursor } = await deps.repo.listTopLevel(
        reportId,
        viewerUserId,
        cursor,
        clampLimit(limit),
      )
      return { items: await projectPage(records, viewerUserId), nextCursor }
    },

    async listForOperator(reportId, cursor, limit) {
      // Operator scope already gates the route; we do NOT run loadVisibleReport (an operator can read the
      // discussion of a held/hidden report). includeDeleted=true so removed rows are returned; toMessageDTO
      // still tombstones them so their body/author never leak.
      const { records, nextCursor } = await deps.repo.listTopLevel(
        reportId,
        null,
        cursor,
        clampLimit(limit),
        true,
      )
      return { items: await projectPage(records, null), nextCursor }
    },

    async listReplies(reportId, messageId, viewerUserId, cursor, limit) {
      await loadVisibleReport(reportId, viewerUserId)
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
      return { items: await projectPage(records, viewerUserId), nextCursor }
    },

    async createMessage(reportId, userId, input) {
      const report = await loadVisibleReport(reportId, userId)

      const body = input.body.trim()
      if (body === "") {
        throw AppError.validation({ body: "Message body is required" })
      }
      // Hate-slur content gate (App Store 1.2). Slurs only; general profanity passes.
      assertNoSlur(body, "body")

      const parentId = input.parentId ?? null
      const parentAuthorUserId = await assertValidParent(reportId, parentId, userId)

      const mediaUploadIds = (input.mediaUploadIds ?? []).slice(0, DISCUSSION_MEDIA_MAX)
      const messageId = newId()
      const createdAt = now()

      const userMentions = await resolveUserMentions(body, input.mentionedUserIds, userId)
      const { mention, forwardedToCity } = await resolveCityForward(report, body, reportId, createdAt)

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
        mentionedUserIds: userMentions.map((m) => m.id),
      })
      const dto = await projectOne(record, userId)

      const isReply = parentId !== null
      fanOut(reportId, isReply ? "reply" : "message")
      deps.notifyOnMessage?.({
        reportId,
        actorUserId: userId,
        reportOwnerUserId: report.reporterUserId,
        parentAuthorUserId,
        isReply,
      })
      notifyMentions(reportId, userId, userMentions, report)
      return dto
    },

    async editMessage(reportId, messageId, userId, input) {
      const report = await loadVisibleReport(reportId, userId)

      const body = input.body.trim()
      if (body === "") {
        throw AppError.validation({ body: "Message body is required" })
      }
      // Hate-slur content gate (App Store 1.2) on the edited body too. Slurs only; profanity passes.
      assertNoSlur(body, "body")
      const mediaUploadIds =
        input.mediaUploadIds !== undefined
          ? input.mediaUploadIds.slice(0, DISCUSSION_MEDIA_MAX)
          : undefined

      const userMentions = await resolveUserMentions(body, input.mentionedUserIds, userId)

      // The repo's UPDATE is itself the author + not-deleted gate (WHERE author_user_id = userId AND
      // deleted_at IS NULL); no editable row matched => null => 404. So a missing / foreign / already-removed
      // message all 404 identically without a pre-read, and a concurrent delete races to the same 404.
      const editedAt = now()
      const record = await deps.repo.editMessage(
        reportId,
        messageId,
        userId,
        body,
        editedAt,
        mediaUploadIds,
        userMentions.map((m) => m.id),
      )
      if (!record) throw AppError.notFound("Message not found")
      const dto = await projectOne(record, userId)
      // Re-notify a still-mentioned user on every edit is acceptable + bounded by the write rate limit.
      notifyMentions(reportId, userId, userMentions, report)
      // An edit reuses the generic "message" change event (no new WS frame type); subscribers refetch + upsert.
      fanOut(reportId, "message")
      return dto
    },

    async toggleReaction(reportId, messageId, userId, emoji) {
      await loadVisibleReport(reportId, userId)
      const message = await deps.repo.findMessage(reportId, messageId, userId)
      if (!message || message.deletedAt !== null) {
        throw AppError.notFound("Message not found")
      }
      await deps.repo.toggleReaction(messageId, userId, emoji)
      // Re-read so the returned DTO reflects the recomputed reaction counts + the viewer's `mine` flags.
      const updated = await deps.repo.findMessage(reportId, messageId, userId)
      if (!updated) throw AppError.notFound("Message not found")
      const dto = await projectOne(updated, userId)
      fanOut(reportId, "reaction")
      return dto
    },

    async deleteMessage(reportId, messageId, actor) {
      await loadVisibleReport(reportId, actor.userId)
      const message = await deps.repo.findMessage(reportId, messageId, actor.userId)
      if (!message) throw AppError.notFound("Message not found")
      const isAuthor = message.authorUserId !== null && message.authorUserId === actor.userId
      if (!isAuthor && !actor.isOperator) {
        throw AppError.forbidden("You cannot delete this message")
      }
      // Idempotent re-delete: return the existing tombstone without re-stamping deleted_at, and fan out a
      // "remove" only when this call ACTUALLY removed the message.
      if (message.deletedAt === null) {
        const deletedAt = now()
        const ok = await deps.repo.softDelete(messageId, deletedAt)
        if (!ok) throw AppError.notFound("Message not found")
        message.deletedAt = deletedAt
        fanOut(reportId, "remove")
      }
      return projectOne(message, actor.userId)
    },
  }
}
