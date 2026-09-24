/**
 * Where each "no double bell" decision lives:
 *   - reply target also @-mentioned: ws/frame-handler fireMentionBells skips the mention bell for the
 *     reply target (the reply bell wins).
 *   - report and group member fan-out: report-chat-notifier and group-chat-notifier exclude the reply
 *     target and the @-mentioned members, who get the richer reply or mention bell instead.
 *   - dm reply vs dm delivered bell: makeDmBellNotifier is the single dm bell site, so one bell by
 *     construction.
 */
import type { NotificationType, RoomKind } from "@civfix/shared"
import type { NotificationService } from "./notification-service.js"
import { CONVERSATION_BELL } from "./conversation-bell.js"
import { dmAuthorName, mentionAuthorName, textPreview } from "../routes/chat-notify-copy.js"
import type { GatewayChatMentions, OnChatReply, OnDmDelivered } from "../ws/types.js"

/**
 * Straight off CONVERSATION_BELL: clear-on-open (clearByTypeAndLink) matches on exactly these two
 * strings, so a second hand-written copy of the map would silently strand bells once either side changed.
 */
function groupBellRoute(
  kind: "cleanup" | "report" | "group",
  roomId: string,
): { type: NotificationType; link: string } {
  const spec = CONVERSATION_BELL[kind]
  return { type: spec.type, link: spec.link(roomId) }
}

export interface ChatBellDeps {
  notificationService: Pick<NotificationService, "createNotification" | "getPrefs">
  /** Best-effort: an absent store or a lookup error reads as not muted. */
  isMutedFor(
    userId: string,
    kind: "dm" | "cleanup" | "report" | "group",
    roomId: string,
  ): Promise<boolean>
  isCleanupMember(cleanupId: string, userId: string): Promise<boolean>
  isReportChatMember(reportId: string, userId: string): Promise<boolean>
  /** Fails closed (false) when the group repo is unwired. */
  isChatGroupMember(groupId: string, userId: string): Promise<boolean>
  isBlockedEitherWay(a: string, b: string): Promise<boolean>
  /** Optional presence source; when absent no one is treated as present. */
  presence?: { online(roomKey: string): Promise<string[]> } | undefined
  roomKeyFor(kind: RoomKind, id: string): string
}

async function isGroupMember(
  deps: ChatBellDeps,
  kind: "cleanup" | "report" | "group",
  roomId: string,
  userId: string,
): Promise<boolean> {
  if (kind === "report") return deps.isReportChatMember(roomId, userId)
  if (kind === "group") return deps.isChatGroupMember(roomId, userId)
  return deps.isCleanupMember(roomId, userId)
}

/** A dm message already bells through makeDmBellNotifier, so dm mentions are a no-op here. */
export function makeChatMentionNotifier(
  deps: ChatBellDeps,
): GatewayChatMentions["notifyChatMention"] {
  return async (input) => {
    const { kind, roomId, actorUserId, mentionedUserId, message } = input
    if (kind === "dm") return
    if (await deps.isMutedFor(mentionedUserId, kind, roomId)) return
    if (!(await isGroupMember(deps, kind, roomId, mentionedUserId))) return
    if (await deps.isBlockedEitherWay(actorUserId, mentionedUserId)) return
    if (!(await deps.notificationService.getPrefs(mentionedUserId)).mentions) return
    const name = mentionAuthorName(message)
    const preview = textPreview(message)
    const { type, link } = groupBellRoute(kind, roomId)
    await deps.notificationService.createNotification(mentionedUserId, {
      type,
      titleKey: "notification.chat_mention.title",
      vars: { name },
      ...(preview !== null ? { body: preview } : { bodyKey: "notification.message.no_preview" }),
      link,
    })
  }
}

/**
 * No isMutedFor gate by design: a reply to your message pierces the room mute, which is the point of
 * this bell. A target watching the room live sees the reply as it lands and needs no bell.
 */
export function makeChatReplyNotifier(deps: ChatBellDeps): OnChatReply {
  return async (input) => {
    const { kind, roomId, actorUserId, targetUserId, message } = input
    if (kind === "dm") return
    if (!(await isGroupMember(deps, kind, roomId, targetUserId))) return
    if (await deps.isBlockedEitherWay(actorUserId, targetUserId)) return
    // Reply urgency is mention-class, so the mentions pref gates the bell entirely (row and push).
    if (!(await deps.notificationService.getPrefs(targetUserId)).mentions) return
    if (deps.presence) {
      let online: string[] = []
      try {
        online = await deps.presence.online(deps.roomKeyFor(kind, roomId))
      } catch {
        online = [] // a presence lookup failure never suppresses the bell
      }
      if (online.includes(targetUserId)) return
    }
    const name = mentionAuthorName(message)
    const preview = textPreview(message)
    const { type, link } = groupBellRoute(kind, roomId)
    await deps.notificationService.createNotification(targetUserId, {
      type,
      titleKey: "notification.chat_reply.title",
      vars: { name },
      ...(preview !== null ? { body: preview } : { bodyKey: "notification.message.no_preview" }),
      link,
    })
  }
}

export type DmBellDeps = Pick<ChatBellDeps, "notificationService" | "isMutedFor">

/**
 * The caller (frame-handler fireDmBell) already applies presence suppression and never fires for the
 * sender, and the send path already rejects blocked pairs, so this owns only mute, reply and copy.
 * In a muted thread only a reply to the recipient bells, and only when `prefs.mentions` allows it
 * (mute-piercing is mention-class urgency); in an unmuted thread a reply only swaps the title copy.
 */
export function makeDmBellNotifier(deps: DmBellDeps): OnDmDelivered {
  return async (threadId, recipientId, message) => {
    const isReplyToRecipient = message.replyTo?.from?.id === recipientId
    if (await deps.isMutedFor(recipientId, "dm", threadId)) {
      if (!isReplyToRecipient) return
      if (!(await deps.notificationService.getPrefs(recipientId)).mentions) return
    }
    const name = dmAuthorName(message)
    const preview = textPreview(message)
    await deps.notificationService.createNotification(recipientId, {
      type: "dm",
      ...(isReplyToRecipient && name !== ""
        ? { titleKey: "notification.chat_reply.title" as const, vars: { name } }
        : name !== ""
          ? { title: name }
          : { titleKey: "notification.dm.title_fallback" as const }),
      ...(preview !== null ? { body: preview } : { bodyKey: "notification.message.no_preview" }),
      link: `/messages/dm/${threadId}`,
    })
  }
}
