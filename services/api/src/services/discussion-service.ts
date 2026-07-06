
import { randomUUID } from "node:crypto"
import { AppError } from "@civfix/shared"
import type { DiscussionMessageDTO, MediaDTO, UserMentionDTO } from "@civfix/shared"
import { assertNoSlur } from "../abuse/slur-filter.js"
import { forwardReportCityMention } from "./report-city-forward.js"
import { isReportVisibleTo } from "./report-visibility.js"
import { parseUserMentions } from "./discussion-mentions.js"
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
import { clampLimit, toMediaDTO, toMessageDTO } from "./discussion-projection.js"

export * from "./discussion-types.js"
export { parseCityMention, jurisdictionHandle } from "./discussion-mentions.js"
export { effectiveJurisdictionHandle } from "./discussion-projection.js"

const CITY_FORWARD_DEDUP_MS = 10 * 60 * 1000

const CITY_FORWARD_DEDUP_MAX_KEYS = 5000

export type CityForwardGuard = (reportId: string, geoid: string) => boolean

export function makeCityForwardDedup(): CityForwardGuard {
  const seen = new Map<string, number>()
  return (reportId, geoid) => {
    const key = `${reportId}:${geoid}`
    const t = Date.now()
    const until = seen.get(key)
    if (until !== undefined && until > t) return false
    seen.set(key, t + CITY_FORWARD_DEDUP_MS)
    if (seen.size > CITY_FORWARD_DEDUP_MAX_KEYS) {
      for (const [k, exp] of seen) if (exp <= t) seen.delete(k)
    }
    return true
  }
}

const defaultCityForwardGuard = makeCityForwardDedup()

export function makeDiscussionService(
  deps: DiscussionServiceDeps & { canForwardCity?: CityForwardGuard },
): DiscussionService {
  const newId = deps.newId ?? (() => randomUUID())
  const now = deps.now ?? (() => new Date())
  const canForwardCity = deps.canForwardCity ?? defaultCityForwardGuard

  function fanOut(reportId: string, event: DiscussionEvent): void {
    deps.broadcast?.(reportId, event)
  }

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

  function presignAttachments(views: DiscussionMediaView[]): Promise<MediaDTO[]> {
    return mapWithLimit(views, PRESIGN_CONCURRENCY, (v) => toMediaDTO(v, deps.presignMedia))
  }

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

  async function loadVisibleReport(
    reportId: string,
    viewerUserId: string | null,
  ): Promise<DiscussionReportView> {
    const report = await deps.repo.findReportForDiscussion(reportId)
    if (report === null || !isReportVisibleTo(report, viewerUserId)) {
      throw AppError.notFound("Report not found")
    }
    return report
  }

  async function resolveCityForward(
    report: DiscussionReportView,
    body: string,
    reportId: string,
    createdAt: Date,
  ): Promise<{ mention: CreateDiscussionMessageTxArgs["mention"]; forwardedToCity: boolean }> {
    const result = await forwardReportCityMention(
      deps.outboundMail,
      {
        reportId,
        category: report.category,
        place: report.place,
        jurisdiction: report.jurisdiction,
      },
      body,
      createdAt,
      { canForward: canForwardCity },
    )
    if (!result.mentioned) return { mention: null, forwardedToCity: false }
    return {
      mention: { geoid: result.geoid!, forwarded: result.forwarded, forwardedAt: result.forwardedAt },
      forwardedToCity: result.forwarded,
    }
  }

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
      assertNoSlur(body, "body")
      const mediaUploadIds =
        input.mediaUploadIds !== undefined
          ? input.mediaUploadIds.slice(0, DISCUSSION_MEDIA_MAX)
          : undefined

      const existing = await deps.repo.findMessage(reportId, messageId, userId)
      const alreadyMentioned = new Set((existing?.userMentions ?? []).map((m) => m.id))

      const userMentions = await resolveUserMentions(body, input.mentionedUserIds, userId)

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
      const newlyMentioned = userMentions.filter((m) => !alreadyMentioned.has(m.id))
      notifyMentions(reportId, userId, newlyMentioned, report)
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
