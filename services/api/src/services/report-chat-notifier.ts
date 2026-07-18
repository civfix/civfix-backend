
import type { ChatMessageDTO } from "@civfix/shared"
import type { NotificationService } from "./notification-service.js"
import { CONVERSATION_BELL } from "./conversation-bell.js"
import { textPreview } from "../routes/chat-notify-copy.js"

export interface ReportChatNotifierDeps {
  notificationService: Pick<NotificationService, "createNotification">
  reportChatRepo: { listMemberIds(reportId: string): Promise<string[]> }
  isMuted: (userId: string, roomId: string) => Promise<boolean>
  presence?: { online(roomKey: string): Promise<string[]> }
  roomKeyFor: (kind: "report", id: string) => string
}

export function makeReportChatNotifier(
  deps: ReportChatNotifierDeps,
): (reportId: string, message: ChatMessageDTO) => Promise<void> {
  return async (reportId, message) => {
    const actorId = message.from?.id ?? null
    const memberIds = await deps.reportChatRepo.listMemberIds(reportId)

    let present: string[] = []
    if (deps.presence) {
      try {
        present = await deps.presence.online(deps.roomKeyFor("report", reportId))
      } catch {
        present = []
      }
    }
    const presentSet = new Set(present)

    // GROUP-ROOM DEDUPE POINT (P2 2.5): the replied-to user gets the richer, mute-piercing REPLY bell
    // (chat-bells makeChatReplyNotifier) and @-mentioned members get the MENTION bell (D11) — both
    // fired from the same send. Excluding them from THIS fan-out keeps it to exactly one bell per
    // member per message. (If their `prefs.mentions` is off, that richer bell is suppressed and they
    // get no bell at all — their choice; mirrors how a mention-only message behaves.)
    const replyTargetId = message.replyTo?.from?.id ?? null
    const mentionedIds = new Set(message.mentions.map((m) => m.id))

    // Skip the sender, the reply target, mentioned members, and anyone watching the room live.
    const candidates = memberIds.filter(
      (m) => m !== actorId && m !== replyTargetId && !mentionedIds.has(m) && !presentSet.has(m),
    )
    if (candidates.length === 0) return

    const name = message.from?.name?.trim() ? message.from.name : null
    const preview = textPreview(message)

    for (const recipientId of candidates) {
      let muted = false
      try {
        muted = await deps.isMuted(recipientId, reportId)
      } catch {
        muted = false
      }
      if (muted) continue

      await deps.notificationService
        .createNotification(recipientId, {
          type: CONVERSATION_BELL.report.type,
          ...(name !== null ? { title: name } : { titleKey: "notification.report_chat.title_fallback" }),
          ...(preview !== null ? { body: preview } : { bodyKey: "notification.message.no_preview" }),
          link: CONVERSATION_BELL.report.link(reportId),
        })
        .catch(() => {})
    }
  }
}
