
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
}

/**
 * M11 gate: is this recipient blocked either way with the message's author? FAILS CLOSED — a lookup
 * error suppresses the bell rather than delivering a push that may be from a blocked user. (The other
 * best-effort lookups in this module fail OPEN; a block is the one thing worth losing a bell over.)
 * True for an anonymous/sender-less message is impossible: those carry no actor to be blocked with.
 */
async function isBlocked(
  deps: Pick<ReportChatNotifierDeps, "isBlockedEitherWay">,
  actorId: string | null,
  recipientId: string,
): Promise<boolean> {
  if (actorId === null) return false
  try {
    return await deps.isBlockedEitherWay(actorId, recipientId)
  } catch {
    return true
  }
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
      // M11: blocks first — a blocked pair must never bell each other, whatever their mute state.
      if (await isBlocked(deps, actorId, recipientId)) continue

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
