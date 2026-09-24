import type {
  AdminReportChatRepository,
  RemoveReportMessageInput,
} from "../../../src/services/admin/admin-report-chat-repository.js"

export interface MemoryReportChatMessage {
  id: string
  reportId: string
  senderId: string | null
  deletedAt: Date | null
}

export interface MemoryReportChatAudit {
  actorId: string | null
  action: string
  target: string
  meta: Record<string, unknown>
}

export class InMemoryAdminReportChatRepository implements AdminReportChatRepository {
  readonly reports = new Set<string>()
  readonly messages = new Map<string, MemoryReportChatMessage>()
  readonly audits: MemoryReportChatAudit[] = []

  seedReport(reportId: string): void {
    this.reports.add(reportId)
  }

  seedMessage(message: {
    id: string
    reportId: string
    senderId?: string | null
    deletedAt?: Date | null
  }): void {
    this.messages.set(message.id, {
      id: message.id,
      reportId: message.reportId,
      senderId: message.senderId === undefined ? "author" : message.senderId,
      deletedAt: message.deletedAt ?? null,
    })
  }

  reportExists(reportId: string): Promise<boolean> {
    return Promise.resolve(this.reports.has(reportId))
  }

  removeMessage(
    reportId: string,
    messageId: string,
    input: RemoveReportMessageInput,
  ): Promise<boolean> {
    const found = this.messages.get(messageId)
    if (
      !found ||
      found.reportId !== reportId ||
      found.deletedAt !== null ||
      found.senderId === null
    ) {
      return Promise.resolve(false)
    }
    found.deletedAt = new Date()
    this.audits.push({
      actorId: input.actorId,
      action: "report_message.removed",
      target: `message:${messageId}`,
      meta: { reportId, reason: input.reason },
    })
    return Promise.resolve(true)
  }
}
