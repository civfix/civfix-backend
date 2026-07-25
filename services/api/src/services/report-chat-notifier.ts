/**
 * D-E2: the report-room member fan-out — the `report_chat` lane binder over the shared pipeline in
 * chat-room-fanout-notifier.ts (which owns the sender/presence/mute/block/dedupe gates and the batching).
 * The dep shape below is the published one: the WS gateway wiring, the poll notifier and the report
 * system-message emitter all construct through it.
 */

import type { ChatMessageDTO } from "@civfix/shared"
import type { NotificationService } from "./notification-service.js"
import { makeRoomFanoutNotifier } from "./chat-room-fanout-notifier.js"

export interface ReportChatNotifierDeps {
  notificationService: Pick<NotificationService, "createNotification">
  reportChatRepo: { listMemberIds(reportId: string): Promise<string[]> }
  isMuted: (userId: string, roomId: string) => Promise<boolean>
  /** Optional one-room-many-users mute lookup; when wired the whole candidate set costs ONE query. */
  mutedUserIdsFor?: (roomId: string, userIds: string[]) => Promise<Set<string>>
  presence?: { online(roomKey: string): Promise<string[]> }
  roomKeyFor: (kind: "report", id: string) => string
  /**
   * SECURITY (M11): blocked-either-way check, the same gate chat-bells applies to the mention and reply
   * bells. Without it this fan-out was a BLOCK BYPASS: a blocked user joins a public report room their
   * target is also in and pushes a notification per message — carrying their own display name and an
   * 80-char preview of their text — straight to the target's lock screen, at message-rate.
   *
   * REQUIRED, deliberately. It was optional in the first cut of M11 ("absent means never blocked", so
   * the offline harnesses could skip it) and that default immediately cost us a second bypass: the poll
   * fan-out (chat-poll-notifier) simply never passed it, so every poll create/close in a shared public
   * room reproduced the exact scenario M11 was written to close — silently, with nothing in the type
   * system to catch it. A caller that genuinely has no blocks store must now say so out loud
   * (`isBlockedEitherWay: () => Promise.resolve(false)`); it can no longer happen by omission.
   */
  isBlockedEitherWay: (a: string, b: string) => Promise<boolean>
  /** Optional batch form of the M11 gate (one query for the whole candidate set). */
  blockedIdsFor?: (actorId: string, candidateIds: string[]) => Promise<Set<string>>
}

export function makeReportChatNotifier(
  deps: ReportChatNotifierDeps,
): (reportId: string, message: ChatMessageDTO) => Promise<void> {
  return makeRoomFanoutNotifier(
    { kind: "report", titleFallbackKey: "notification.report_chat.title_fallback" },
    {
      notificationService: deps.notificationService,
      listMemberIds: (reportId) => deps.reportChatRepo.listMemberIds(reportId),
      isMuted: deps.isMuted,
      ...(deps.mutedUserIdsFor ? { mutedUserIdsFor: deps.mutedUserIdsFor } : {}),
      presence: deps.presence,
      roomKey: (reportId) => deps.roomKeyFor("report", reportId),
      isBlockedEitherWay: deps.isBlockedEitherWay,
      ...(deps.blockedIdsFor ? { blockedIdsFor: deps.blockedIdsFor } : {}),
    },
  )
}
