import type { ChatMessageDTO } from "@civfix/shared"
import type { FastifyBaseLogger } from "fastify"
import type { NotificationService } from "./notification-service.js"
import { makeRoomFanoutNotifier, ROOM_FANOUT_SPEC } from "./chat-room-fanout-notifier.js"

export { REPORT_CHAT_FANOUT_MEMBER_CAP } from "./chat-room-fanout-notifier.js"

export interface ReportChatNotifierDeps {
  notificationService: Pick<NotificationService, "createNotificationsReportingFailures">
  reportChatRepo: { listMemberIds(reportId: string, limit: number): Promise<string[]> }
  isMuted: (userId: string, roomId: string) => Promise<boolean>
  mutedUserIdsFor?: (roomId: string, userIds: string[]) => Promise<Set<string>>
  presence?: { online(roomKey: string): Promise<string[]> }
  roomKeyFor: (kind: "report", id: string) => string
  isBlockedEitherWay: (a: string, b: string) => Promise<boolean>
  blockedIdsFor?: (actorId: string, candidateIds: string[]) => Promise<Set<string>>
  coalesceWindowMs?: number
  now?: () => number
  claimWindow?: (roomId: string, windowMs: number) => Promise<boolean>
  dispatchToJob?: (roomId: string, messageId: string) => Promise<void>
  logger?: Pick<FastifyBaseLogger, "warn" | "error"> | undefined
}

export function makeReportChatNotifier(
  deps: ReportChatNotifierDeps,
): (reportId: string, message: ChatMessageDTO) => Promise<void> {
  return makeRoomFanoutNotifier(ROOM_FANOUT_SPEC.report, {
    notificationService: deps.notificationService,
    listMemberIds: (reportId, limit) => deps.reportChatRepo.listMemberIds(reportId, limit),
    isMuted: deps.isMuted,
    ...(deps.mutedUserIdsFor ? { mutedUserIdsFor: deps.mutedUserIdsFor } : {}),
    presence: deps.presence,
    roomKey: (reportId) => deps.roomKeyFor("report", reportId),
    isBlockedEitherWay: deps.isBlockedEitherWay,
    ...(deps.blockedIdsFor ? { blockedIdsFor: deps.blockedIdsFor } : {}),
    ...(deps.coalesceWindowMs !== undefined ? { coalesceWindowMs: deps.coalesceWindowMs } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.claimWindow !== undefined ? { claimWindow: deps.claimWindow } : {}),
    ...(deps.dispatchToJob !== undefined ? { dispatchToJob: deps.dispatchToJob } : {}),
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  })
}
