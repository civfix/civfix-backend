import type { ChatMessageDTO, ReportChatParticipantDTO } from "@civfix/shared"
import type { ReportChatMeta } from "./report-types.js"

export type ReportChatRole = "owner" | "member"

export interface ReportChatRepository {
  isMember(reportId: string, userId: string): Promise<boolean>
  roleOf(reportId: string, userId: string): Promise<ReportChatRole | null>
  join(reportId: string, userId: string, role?: ReportChatRole): Promise<void>
  leave(reportId: string, userId: string): Promise<void>
  advanceReadWatermark(reportId: string, userId: string, upToMessageId: string): Promise<void>
  markRead(reportId: string, userId: string, at: Date): Promise<void>
  insertSystemMessage(input: {
    reportId: string
    status: string
    kind?: string | null
    note?: string | null
    body?: string | null
  }): Promise<ChatMessageDTO>
  listMemberIds(reportId: string, limit?: number): Promise<string[]>
  countMembers(reportId: string): Promise<number>
  listMembers(reportId: string, viewerId: string): Promise<ReportChatParticipantDTO[]>
}

export interface ReportChatMetaQueries {
  loadChatMeta(reportId: string, viewerUserId: string | null): Promise<ReportChatMeta>
  isReportVerified(userId: string): Promise<boolean>
}
