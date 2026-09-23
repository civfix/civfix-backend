import {
  ReportChatHistoryRequestSchema,
  DeleteReportMessageRequestSchema,
  ToggleReportMessageReactionRequestSchema,
  JoinReportChatRequestSchema,
  LeaveReportChatRequestSchema,
  IdSchema,
  AppError,
  type ChatMessageDTO,
  type ChatHistoryResponse,
  type ReportChatParticipantsResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import { perIdentity } from "../plugins/rate-limit.js"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { parse } from "./_validate.js"
import { route } from "../versioning/route.js"
import { roomKeyFor } from "../ws/gateway.js"
import {
  chatHistoryPayload,
  clampChatHistoryLimit,
  deleteMessageWithPowers,
  REPORT_NOT_FOUND,
} from "./chat-route-helpers.js"
import { neutralizeChatViewerFields } from "../services/chat-viewer-fields.js"
import {
  makeDrizzleChatRepository,
  type ChatRepository,
} from "../services/chat-repository.drizzle.js"
import {
  makeReportChatRepository,
  type ReportChatRepository,
} from "../services/report-chat-repository.drizzle.js"
import { makeDrizzleDiscussionRepository } from "../services/discussion-repository.drizzle.js"
import type { DiscussionRepository } from "../services/discussion-types.js"
import { isReportVisibleTo } from "../services/report-visibility.js"
import { makePrivateMediaPresigner } from "../services/media-presign.js"
import { withAffiliation } from "../services/affiliation.js"
import { makeChatReactionService } from "../services/chat-reaction-service.js"
import { nudgeThreads } from "../services/threads-nudge.js"
import { wireChatPowers } from "./chat-powers-wiring.js"

export interface DiscussionServiceOverrides {
  repo?: DiscussionRepository
}

declare module "fastify" {
  interface FastifyInstance {
    discussionOverrides?: DiscussionServiceOverrides
  }
}

const ReportChatIdParamsSchema = z.object({ id: IdSchema }).strict()
const ReportChatMessageParamsSchema = z.object({ id: IdSchema, messageId: IdSchema }).strict()

export const REPORT_REACTION_RATE_LIMIT = perIdentity({ max: 60, timeWindow: "1 minute" })

export const REPORT_DELETE_RATE_LIMIT = perIdentity({ max: 30, timeWindow: "1 minute" })

export const REPORT_CHAT_MEMBERSHIP_RATE_LIMIT = perIdentity({ max: 20, timeWindow: "1 minute" })

export async function registerReportChatRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  let chatRepo: ChatRepository | undefined
  const getChatRepo = (): ChatRepository =>
    app.chatOverrides?.chatRepo ??
    (chatRepo ??= makeDrizzleChatRepository(
      container.getDb().sql,
      makePrivateMediaPresigner(container.storage),
    ))

  let reportChatRepo: ReportChatRepository | undefined
  const getReportChatRepo = (): ReportChatRepository =>
    app.chatOverrides?.reportChat ??
    (reportChatRepo ??= makeReportChatRepository(container.getDb().sql))

  let discussionRepo: DiscussionRepository | undefined
  const getReportRepo = (): DiscussionRepository =>
    app.discussionOverrides?.repo ??
    (discussionRepo ??= makeDrizzleDiscussionRepository(container.getDb().sql))

  const requireVisibleReport = async (
    reportId: string,
    viewerUserId: string | null,
  ): Promise<void> => {
    const report = await getReportRepo().findReportForDiscussion(reportId)
    if (!isReportVisibleTo(report, viewerUserId)) throw AppError.notFound(REPORT_NOT_FOUND)
  }

  route(app, "reportMessages", async (request, reply) => {
    const { id } = parse(ReportChatIdParamsSchema, request.params)
    const q = parse(ReportChatHistoryRequestSchema, { ...(request.query as object), id })
    const limit = clampChatHistoryLimit(q.limit)
    const viewerUserId = request.auth?.userId ?? null
    await requireVisibleReport(id, viewerUserId)
    const payload: ChatHistoryResponse = await chatHistoryPayload(
      {
        history: (before, pageLimit, around) =>
          getChatRepo().reportHistory(id, before, pageLimit, viewerUserId, around),
        listPins: () => getChatRepo().listReportPins(id, viewerUserId),
      },
      q,
      limit,
    )
    reply.status(200).send(payload)
  })

  const resolveChatPowers = wireChatPowers(app, container)

  route(
    app,
    "deleteReportMessage",
    { preHandler: csrfProtect, config: { rateLimit: REPORT_DELETE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id, messageId } = parse(ReportChatMessageParamsSchema, request.params)
      parse(DeleteReportMessageRequestSchema, { id, messageId })
      await requireVisibleReport(id, userId)
      const chatRepo = getChatRepo()
      const tombstone = await deleteMessageWithPowers({
        roomKind: "report",
        roomId: id,
        messageId,
        userId,
        senderPath: await getReportChatRepo().isMember(id, userId),
        softDelete: (opts) => chatRepo.softDeleteReport(id, messageId, userId, opts),
        findMessageMeta: (mid) => chatRepo.findMessageMeta(mid),
        resolveChatPowers,
        chat: container.chatService,
        legacyBroadcast: true,
      })
      reply.status(200).send(tombstone)
    },
  )

  route(
    app,
    "toggleReportMessageReaction",
    { preHandler: csrfProtect, config: { rateLimit: REPORT_REACTION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id, messageId } = parse(ReportChatMessageParamsSchema, request.params)
      const body = parse(ToggleReportMessageReactionRequestSchema, {
        ...(request.body as object),
        id,
        messageId,
      })
      const reactions = makeChatReactionService({
        chat: getChatRepo(),
        isReportChatMember: (reportId, uid) => getReportChatRepo().isMember(reportId, uid),
        isReportVisible: async (reportId, uid) =>
          isReportVisibleTo(await getReportRepo().findReportForDiscussion(reportId), uid),
      })
      const updated: ChatMessageDTO = await reactions.toggleReportReaction(
        id,
        messageId,
        userId,
        body.emoji,
      )
      void Promise.resolve(
        container.chatService.broadcastEvent?.(roomKeyFor("report", id), {
          type: "reaction",
          cleanupId: id,
          roomKind: "report",
          message: neutralizeChatViewerFields(updated),
        }),
      ).catch(() => {})
      reply.status(200).send(updated)
    },
  )

  route(
    app,
    "joinReportChat",
    { preHandler: csrfProtect, config: { rateLimit: REPORT_CHAT_MEMBERSHIP_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(ReportChatIdParamsSchema, request.params)
      parse(JoinReportChatRequestSchema, { id })
      await requireVisibleReport(id, userId)
      await getReportChatRepo().join(id, userId, "member")
      nudgeThreads(container.userChannel, userId)
      reply.status(200).send({ ok: true })
    },
  )

  route(app, "getReportChatParticipants", async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(ReportChatIdParamsSchema, request.params)
    await requireVisibleReport(id, userId)
    const repo = getReportChatRepo()
    const [members, total] = await Promise.all([
      repo.listMembers(id, userId),
      repo.countMembers(id),
    ])
    const affiliations =
      app.chatOverrides?.reportChat === undefined
        ? await container.getAffiliationLoader()(
            members.map((m) => m.user.id),
            userId,
          )
        : new Map()
    const participants = members.map((m) => ({
      ...m,
      user: withAffiliation(m.user, affiliations),
    }))
    const payload: ReportChatParticipantsResponse = { participants, total }
    reply.status(200).send(payload)
  })

  route(
    app,
    "leaveReportChat",
    { preHandler: csrfProtect, config: { rateLimit: REPORT_CHAT_MEMBERSHIP_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(ReportChatIdParamsSchema, request.params)
      parse(LeaveReportChatRequestSchema, { id })
      await getReportChatRepo().leave(id, userId)
      nudgeThreads(container.userChannel, userId)
      reply.status(200).send({ ok: true })
    },
  )
}
