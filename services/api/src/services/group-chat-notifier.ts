import type { ChatMessageDTO } from "@civfix/shared"
import type { NotificationService } from "./notification-service.js"
import { makeRoomFanoutNotifier } from "./chat-room-fanout-notifier.js"

export interface GroupChatNotifierDeps {
  notificationService: Pick<NotificationService, "createNotifications">
  groupRepo: { listMemberIds(groupId: string): Promise<string[]> }
  isMuted: (userId: string, roomId: string) => Promise<boolean>
  mutedUserIdsFor?: (roomId: string, userIds: string[]) => Promise<Set<string>>
  presence?: { online(roomKey: string): Promise<string[]> }
  roomKeyFor: (kind: "group", id: string) => string
  isBlockedEitherWay: (a: string, b: string) => Promise<boolean>
  blockedIdsFor?: (actorId: string, candidateIds: string[]) => Promise<Set<string>>
  coalesceWindowMs?: number
  now?: () => number
  claimWindow?: (roomId: string, windowMs: number) => Promise<boolean>
  dispatchToJob?: (roomId: string, messageId: string) => Promise<void>
}

export function makeGroupChatNotifier(
  deps: GroupChatNotifierDeps,
): (groupId: string, message: ChatMessageDTO) => Promise<void> {
  return makeRoomFanoutNotifier(
    { kind: "group", titleFallbackKey: "notification.group_chat.title_fallback" },
    {
      notificationService: deps.notificationService,
      listMemberIds: (groupId) => deps.groupRepo.listMemberIds(groupId),
      isMuted: deps.isMuted,
      ...(deps.mutedUserIdsFor ? { mutedUserIdsFor: deps.mutedUserIdsFor } : {}),
      presence: deps.presence,
      roomKey: (groupId) => deps.roomKeyFor("group", groupId),
      isBlockedEitherWay: deps.isBlockedEitherWay,
      ...(deps.blockedIdsFor ? { blockedIdsFor: deps.blockedIdsFor } : {}),
      ...(deps.coalesceWindowMs !== undefined ? { coalesceWindowMs: deps.coalesceWindowMs } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.claimWindow !== undefined ? { claimWindow: deps.claimWindow } : {}),
      ...(deps.dispatchToJob !== undefined ? { dispatchToJob: deps.dispatchToJob } : {}),
    },
  )
}
