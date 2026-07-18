/**
 * Task D-E2: per-member bell for a report-chat message.
 *
 * A report chat is a group conversation (report_chat_members). When a user (or a SYSTEM timeline event)
 * posts, every OTHER member should get a `report_chat` notification -- except:
 *   - the sender (they wrote it),
 *   - anyone currently PRESENT in the room (they see it live; mirrors the DM presence-suppression),
 *   - anyone who MUTED this report chat (per-conversation mute, D-E1).
 *
 * `createNotification` itself applies the push master switch + quiet hours (typeAllowedByPrefs groups
 * `report_chat` under `reportUpdates`), so this module only owns the mute/presence/sender filtering.
 * Fully best-effort: a failed send for one recipient never blocks the others or the send path.
 *
 * Exported as a factory so Task D-D1 (report status/timeline SYSTEM messages) can reuse the exact same
 * fan-out for its sender-less system posts (`message.from` undefined -> the title fallback path).
 */

import type { ChatMessageDTO } from "@civfix/shared"
import type { NotificationService } from "./notification-service.js"
import { textPreview } from "../routes/chat-notify-copy.js"

export interface ReportChatNotifierDeps {
  notificationService: Pick<NotificationService, "createNotification">
  reportChatRepo: { listMemberIds(reportId: string): Promise<string[]> }
  /** True when `userId` has muted THIS report chat. Already scoped to roomKind "report" by the caller. */
  isMuted: (userId: string, roomId: string) => Promise<boolean>
  /** Optional presence source; when absent no one is treated as present. */
  presence?: { online(roomKey: string): Promise<string[]> }
  roomKeyFor: (kind: "report", id: string) => string
}

/**
 * Build the report-chat member notifier. The returned `notify(reportId, message)` is fully
 * fire-and-forget: it swallows every per-recipient error so a bell failure never surfaces on the send
 * path. Callers may still `void notify(...).catch(() => {})` for the (already best-effort) member-list /
 * presence lookups.
 */
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

    // Title: the sender's display name, or the localized fallback for SYSTEM / no-name messages.
    const name = message.from?.name?.trim() ? message.from.name : null
    const preview = textPreview(message)

    for (const recipientId of candidates) {
      // Per-recipient mute check: E1's mute store is keyed (userId, roomKind, roomId), so we ask
      // per-user for THIS one report -- the batch `mutedRoomIdsFor` is one-user-many-rooms (wrong shape).
      let muted = false
      try {
        muted = await deps.isMuted(recipientId, reportId)
      } catch {
        muted = false
      }
      if (muted) continue

      await deps.notificationService
        .createNotification(recipientId, {
          type: "report_chat",
          ...(name !== null ? { title: name } : { titleKey: "notification.report_chat.title_fallback" }),
          ...(preview !== null ? { body: preview } : { bodyKey: "notification.message.no_preview" }),
          link: `/messages/report/${reportId}`,
        })
        .catch(() => {})
    }
  }
}
