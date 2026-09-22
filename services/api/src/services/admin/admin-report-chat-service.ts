import {
  AppError,
  type ChatHistoryResponse,
  type ChatMessageDTO,
  type ReportChatHistoryRequest,
} from "@civfix/shared"
import type { ChatHistorySource } from "../../routes/chat-route-helpers.js"
import { chatHistoryPayload } from "../../routes/chat-route-helpers.js"
import {
  sendReportChatMessage,
  type ReportChatSendDeps,
} from "../report-chat-send.js"
import type { AdminReportChatRepository } from "./admin-report-chat-repository.drizzle.js"

export const ADMIN_REPORT_CHAT_HISTORY_DEFAULT = 30
export const ADMIN_REPORT_CHAT_HISTORY_MAX = 50

export interface AdminReportChatServiceDeps {
  repo: AdminReportChatRepository
  historySource: (reportId: string, viewerUserId: string | null) => ChatHistorySource
  send: ReportChatSendDeps
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
      const limit = Math.min(
        Math.max(query.limit ?? ADMIN_REPORT_CHAT_HISTORY_DEFAULT, 1),
        ADMIN_REPORT_CHAT_HISTORY_MAX,
      )
      return chatHistoryPayload(deps.historySource(reportId, viewerUserId), query, limit)
    },

    async sendMessage(reportId, input): Promise<{ message: ChatMessageDTO }> {
      await assertReportExists(reportId)
      const message = await sendReportChatMessage(deps.send, {
        reportId,
        senderId: input.actorId,
        body: input.body,
      })
      return { message }
    },

    async removeMessage(reportId, messageId, input): Promise<void> {
      await assertReportExists(reportId)
      const removed = await deps.repo.removeMessage(reportId, messageId, input)
      if (!removed) throw AppError.notFound("Message not found")
    },
  }
}
