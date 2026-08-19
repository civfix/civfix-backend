/**
 * P4 Task 4.5: the group-room member fan-out — the `group_chat` lane binder over the shared pipeline in
 * chat-room-fanout-notifier.ts (which owns the sender/presence/mute/block/dedupe gates and the batching).
 * The report lane is the twin binder (report-chat-notifier.ts); both keep their published dep shapes
 * because the WS gateway wiring and the poll notifier construct through them.
 */

import type { ChatMessageDTO } from "@civfix/shared"
import type { NotificationService } from "./notification-service.js"
import { makeRoomFanoutNotifier } from "./chat-room-fanout-notifier.js"

export interface GroupChatNotifierDeps {
  notificationService: Pick<NotificationService, "createNotifications">
  groupRepo: { listMemberIds(groupId: string): Promise<string[]> }
  /** True when `userId` has muted THIS group. Already scoped to roomKind "group" by the caller. */
  isMuted: (userId: string, roomId: string) => Promise<boolean>
  /** Optional one-room-many-users mute lookup; when wired the whole candidate set costs ONE query. */
  mutedUserIdsFor?: (roomId: string, userIds: string[]) => Promise<Set<string>>
  /** Optional presence source; when absent no one is treated as present. */
  presence?: { online(roomKey: string): Promise<string[]> }
  roomKeyFor: (kind: "group", id: string) => string
  /**
   * SECURITY (M11): blocked-either-way check, the same gate chat-bells applies to the mention and reply
   * bells. Without it this fan-out was a BLOCK BYPASS: a blocked user joins a public group their target
   * is in and pushes a notification per message — their display name plus an 80-char preview of their
   * text — to the target's lock screen at message-rate.
   *
   * REQUIRED, deliberately — see the twin note in report-chat-notifier.ts. The optional-with-fail-open
   * default it started as was itself the source of a second bypass (the poll fan-out never passed it),
   * so a caller with no blocks store must now spell that out (`() => Promise.resolve(false)`) rather
   * than degrading silently by omission.
   */
  isBlockedEitherWay: (a: string, b: string) => Promise<boolean>
  /** Optional batch form of the M11 gate (one query for the whole candidate set). */
  blockedIdsFor?: (actorId: string, candidateIds: string[]) => Promise<Set<string>>
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
    },
  )
}
