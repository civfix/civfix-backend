export interface RemoveReportMessageInput {
  reason: string | null
  actorId: string | null
}

export interface AdminReportChatRepository {
  reportExists(reportId: string): Promise<boolean>
  removeMessage(
    reportId: string,
    messageId: string,
    input: RemoveReportMessageInput,
  ): Promise<boolean>
}
