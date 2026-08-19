
import type { ChatMessageDTO } from "@civfix/shared"
import type { NotificationService } from "./notification-service.js"
import { makeRoomFanoutNotifier } from "./chat-room-fanout-notifier.js"

export const REPORT_CHAT_FANOUT_MEMBER_CAP = 500

export interface ReportChatNotifierDeps {
  notificationService: Pick<NotificationService, "createNotifications">
  reportChatRepo: { listMemberIds(reportId: string, limit?: number): Promise<string[]> }
  isMuted: (userId: string, roomId: string) => Promise<boolean>
  mutedUserIdsFor?: (roomId: string, userIds: string[]) => Promise<Set<string>>
  presence?: { online(roomKey: string): Promise<string[]> }
  roomKeyFor: (kind: "report", id: string) => string
  isBlockedEitherWay: (a: string, b: string) => Promise<boolean>
  blockedIdsFor?: (actorId: string, candidateIds: string[]) => Promise<Set<string>>
}

export function makeReportChatNotifier(
  deps: ReportChatNotifierDeps,
): (reportId: string, message: ChatMessageDTO) => Promise<void> {
  return makeRoomFanoutNotifier(
    { kind: "report", titleFallbackKey: "notification.report_chat.title_fallback" },
    {
      notificationService: deps.notificationService,
      listMemberIds: (reportId) =>
        deps.reportChatRepo.listMemberIds(reportId, REPORT_CHAT_FANOUT_MEMBER_CAP),
      isMuted: deps.isMuted,
      ...(deps.mutedUserIdsFor ? { mutedUserIdsFor: deps.mutedUserIdsFor } : {}),
      presence: deps.presence,
      roomKey: (reportId) => deps.roomKeyFor("report", reportId),
      isBlockedEitherWay: deps.isBlockedEitherWay,
      ...(deps.blockedIdsFor ? { blockedIdsFor: deps.blockedIdsFor } : {}),
    },
  )
}
