import {
  AppError,
  type ChatHistoryResponse,
  type ChatMessageDTO,
  type ReportChatHistoryRequest,
  type RoomKind,
} from "@civfix/shared"
import type { FastifyBaseLogger } from "fastify"
import { neutralizeChatViewerFields } from "../chat-viewer-fields.js"
import {
  chatHistoryPayload,
  clampChatHistoryLimit,
  type ChatHistorySource,
} from "../../routes/chat-route-helpers.js"
import { sendReportChatMessage, type ReportChatSendDeps } from "../report-chat-send.js"
import type { AdminReportChatRepository } from "./admin-report-chat-repository.drizzle.js"
import { CIVFIX_OFFICIAL_USER_ID } from "../../auth/official-account.js"

/** Called only after the operator's change committed; never throws. */
export type MessageUpdateAnnouncer = (messageId: string) => Promise<void>

export interface MessageUpdateAnnouncerDeps {
  findRoom(messageId: string): Promise<{ kind: RoomKind; id: string } | null>
  loadMessage(kind: RoomKind, roomId: string, messageId: string): Promise<ChatMessageDTO | null>
  broadcast(kind: RoomKind, roomId: string, message: ChatMessageDTO): void
  logger?: Pick<FastifyBaseLogger, "warn">
}

export function makeMessageUpdateAnnouncer(
  deps: MessageUpdateAnnouncerDeps,
): MessageUpdateAnnouncer {
  return async (messageId) => {
    try {
      const room = await deps.findRoom(messageId)
      if (room === null) return
      const message = await deps.loadMessage(room.kind, room.id, messageId)
      if (message === null) return
      deps.broadcast(room.kind, room.id, neutralizeChatViewerFields(message))
    } catch (err) {
      // The operator's change is already committed; a failed live update only delays what clients see
      // until their next history fetch, so it must not turn the request into an error.
      deps.logger?.warn({ err, messageId }, "admin message update broadcast failed")
    }
  }
}

export interface AdminReportChatServiceDeps {
  repo: AdminReportChatRepository
  historySource: (reportId: string, viewerUserId: string | null) => ChatHistorySource
  send: ReportChatSendDeps
  announceMessageUpdate?: MessageUpdateAnnouncer
}

export interface AdminReportChatService {
  history(
    reportId: string,
    query: ReportChatHistoryRequest,
    viewerUserId: string | null,
  ): Promise<ChatHistoryResponse>
  sendMessage(
    reportId: string,
    input: { body: string; actorId: string },
  ): Promise<{ message: ChatMessageDTO }>
  removeMessage(
    reportId: string,
    messageId: string,
    input: { reason: string | null; actorId: string | null },
  ): Promise<void>
}

export function makeAdminReportChatService(
  deps: AdminReportChatServiceDeps,
): AdminReportChatService {
  const assertReportExists = async (reportId: string): Promise<void> => {
    if (!(await deps.repo.reportExists(reportId))) throw AppError.notFound("Report not found")
  }

  return {
    async history(reportId, query, viewerUserId): Promise<ChatHistoryResponse> {
      await assertReportExists(reportId)
      const limit = clampChatHistoryLimit(query.limit)
      return chatHistoryPayload(deps.historySource(reportId, viewerUserId), query, limit)
    },

    async sendMessage(reportId, input): Promise<{ message: ChatMessageDTO }> {
      const body = input.body.trim()
      if (body === "") throw AppError.validation({ body: "A message needs text." })
      await assertReportExists(reportId)
      const message = await sendReportChatMessage(deps.send, {
        reportId,
        senderId: CIVFIX_OFFICIAL_USER_ID,
        actingUserId: input.actorId,
        body,
      })
      return { message }
    },

    async removeMessage(reportId, messageId, input): Promise<void> {
      await assertReportExists(reportId)
      const removed = await deps.repo.removeMessage(reportId, messageId, input)
      if (!removed) throw AppError.notFound("Message not found")
      await deps.announceMessageUpdate?.(messageId)
    },
  }
}
