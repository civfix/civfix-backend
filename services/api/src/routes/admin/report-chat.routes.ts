import {
  AdminRemoveReportMessageRequestSchema,
  AdminReportMessagesRequestSchema,
  AdminSendReportMessageRequestSchema,
  type AdminSendReportMessageResponse,
  type ChatHistoryResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import { perIdentity } from "../../plugins/rate-limit.js"
import type { Container } from "../../di.js"
import { route } from "../../versioning/route.js"
import { idParam, overridableService, parse, sendOk, twoIdParams } from "./_route-utils.js"
import { requireOperator } from "../../auth/admin-guard.js"
import {
  makeAdminReportChatService,
  type AdminReportChatService,
} from "../../services/admin/admin-report-chat-service.js"
import {
  makeDrizzleAdminReportChatRepository,
  type AdminReportChatRepository,
} from "../../services/admin/admin-report-chat-repository.drizzle.js"
import { makeDrizzleChatRepository, type ChatRepository } from "../../services/chat-repository.drizzle.js"
import type { ChatHistorySource } from "../chat-route-helpers.js"
import { makePrivateMediaPresigner } from "../../services/media-presign.js"
import { makeContainerReportChatSendDeps } from "../../services/report-chat-send-wiring.js"
import { chatMentionDeps } from "../chat-gateway-wiring.js"
import type { ReportChatSendDeps } from "../../services/report-chat-send.js"

export interface AdminReportChatRouteOverrides {
  repo: AdminReportChatRepository
  chatRepo: ChatRepository
  send: ReportChatSendDeps
}

declare module "fastify" {
  interface FastifyInstance {
    adminReportChatOverrides?: AdminReportChatRouteOverrides
  }
}

export const ADMIN_REPORT_CHAT_SEND_RATE_LIMIT = perIdentity({
  max: 60,
  timeWindow: "1 minute",
  skipOnError: false,
})

export const ADMIN_REPORT_CHAT_REMOVE_RATE_LIMIT = perIdentity({
  max: 60,
  timeWindow: "1 minute",
  skipOnError: false,
})

export async function registerAdminReportChatRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  const service = overridableService(
    app,
    "adminReportChatOverrides",
    (overrides) =>
      makeAdminReportChatService({
        repo: overrides.repo,
        historySource: historySourceFrom(() => overrides.chatRepo),
        send: overrides.send,
      }),
    () => (containerService ??= buildContainerService()),
  )

  let containerService: AdminReportChatService | undefined
  let chatRepo: ChatRepository | undefined

  function buildContainerService(): AdminReportChatService {
    const sql = container.getDb().sql
    const getChatRepo = (): ChatRepository =>
      (chatRepo ??= makeDrizzleChatRepository(sql, makePrivateMediaPresigner(container.storage)))
    return makeAdminReportChatService({
      repo: makeDrizzleAdminReportChatRepository(sql),
      historySource: historySourceFrom(getChatRepo),
      send: makeContainerReportChatSendDeps(container, {
        mentions: chatMentionDeps(app, container),
        logger: app.log,
      }),
    })
  }

  route(app, "adminReportMessages", async (request, reply) => {
    requireOperator(request)
    const { id } = idParam(request)
    const query = parse(AdminReportMessagesRequestSchema, { ...(request.query as object), id })
    const viewerUserId = request.auth?.userId ?? null
    const payload: ChatHistoryResponse = await service().history(id, query, viewerUserId)
    reply.status(200).send(payload)
  })

  route(
    app,
    "adminSendReportMessage",
    { preHandler: csrfProtect, config: { rateLimit: ADMIN_REPORT_CHAT_SEND_RATE_LIMIT } },
    async (request, reply) => {
      const actorId = requireOperator(request)
      const { id } = idParam(request)
      const body = parse(AdminSendReportMessageRequestSchema, {
        ...(request.body as object),
        id,
      })
      const payload: AdminSendReportMessageResponse = await service().sendMessage(id, {
        body: body.body,
        actorId,
      })
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "adminRemoveReportMessage",
    { preHandler: csrfProtect, config: { rateLimit: ADMIN_REPORT_CHAT_REMOVE_RATE_LIMIT } },
    async (request, reply) => {
      const actorId = requireOperator(request)
      const { id, messageId } = twoIdParams(request, "messageId")
      const body = parse(AdminRemoveReportMessageRequestSchema, {
        ...(request.body as object),
        id,
        messageId,
      })
      await service().removeMessage(id, messageId, {
        reason: body.reason ?? null,
        actorId,
      })
      sendOk(reply)
    },
  )
}

function historySourceFrom(
  getChatRepo: () => ChatRepository,
): (reportId: string, viewerUserId: string | null) => ChatHistorySource {
  return (reportId, viewerUserId) => ({
    history: (before, pageLimit, around) =>
      getChatRepo().reportHistory(reportId, before, pageLimit, viewerUserId, around),
    listPins: () => getChatRepo().listReportPins(reportId, viewerUserId),
  })
}
