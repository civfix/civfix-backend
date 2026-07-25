/**
 * P2 Task 2.5: post-send BELL notifiers for the chat rooms, extracted from chat-gateway-wiring so the
 * gate logic is single-sourced and testable (unit + pg-integration) instead of living in inline
 * closures. Three factories, one per bell shape:
 *
 *   - makeChatMentionNotifier — the @-mention bell for GROUP rooms (cleanup + report + group; dm is a
 *     no-op: a dm message already bells via the delivered-bell). Mute-gated, membership-gated,
 *     block-gated, and `prefs.mentions`-gated. Report rooms bell as `report_chat` ->
 *     /messages/report/:id, cleanup rooms as `cleanup_chat` -> /cleanups/:id, group rooms (P4 4.5) as
 *     `group_chat` -> /messages/group/:id (D11 re-enables report mentions; the resolver in
 *     chat-mention-resolver.ts scopes WHO can be mentioned).
 *   - makeChatReplyNotifier — the reply bell for GROUP rooms: when a sent message replies to YOUR
 *     message you get a bell EVEN IF you muted the room. This is deliberately the ONE bell path with
 *     no conversation-mute gate (replies pierce room mutes). Reply urgency is mention-class, so
 *     `prefs.mentions` still gates it; membership, blocks, and presence (target watching the room
 *     live) still suppress; push master + quiet hours ride createNotification as everywhere else.
 *   - makeDmBellNotifier — the DM delivered bell (previously inline `onDmDelivered`), now carrying the
 *     reply override: a reply TO the recipient pierces a MUTED thread (again `prefs.mentions`-gated);
 *     an unmuted thread takes the normal path. Because this is the SINGLE dm bell site, a dm reply can
 *     never double-bell — the reply flavor only changes the title copy and the mute behavior.
 *
 * DEDUPE MAP (where each "no double bell" decision lives):
 *   - reply target also @-mentioned        -> ws/frame-handler fireMentionBells skips the mention bell
 *                                             for the reply target (reply bell preferred).
 *   - report-room member fan-out           -> report-chat-notifier excludes the reply target and the
 *                                             @-mentioned members from the fan-out set (they get the
 *                                             richer reply/mention bell instead).
 *   - group-room member fan-out (P4 4.5)   -> group-chat-notifier excludes the reply target and the
 *                                             @-mentioned members from the fan-out set (same shape as
 *                                             the report fan-out; one bell per member per message).
 *   - dm reply vs dm delivered bell        -> one call site (makeDmBellNotifier), one bell by
 *                                             construction.
 */

import type { NotificationType, RoomKind } from "@civfix/shared"
import type { NotificationService } from "./notification-service.js"
import { CONVERSATION_BELL } from "./conversation-bell.js"
import { dmAuthorName, mentionAuthorName, textPreview } from "../routes/chat-notify-copy.js"
import type { GatewayChatMentions, OnChatReply, OnDmDelivered } from "../ws/types.js"

/**
 * Notification type + deep link for a group-room bell, per room kind. Straight off CONVERSATION_BELL —
 * clear-on-open (clearByTypeAndLink) matches on exactly these two strings, so a second hand-written copy
 * of the map would silently strand bells the moment either side changed.
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
  /** Best-effort "has this user muted this room?" (absent store / lookup error => false). */
  isMutedFor(userId: string, kind: "dm" | "cleanup" | "report" | "group", roomId: string): Promise<boolean>
  isCleanupMember(cleanupId: string, userId: string): Promise<boolean>
  isReportChatMember(reportId: string, userId: string): Promise<boolean>
  /** P4 4.5: chat_group_members membership (fail-closed false when the group repo is unwired). */
  isChatGroupMember(groupId: string, userId: string): Promise<boolean>
  isBlockedEitherWay(a: string, b: string): Promise<boolean>
  /** Optional presence source; when absent no one is treated as present. */
  presence?: { online(roomKey: string): Promise<string[]> } | undefined
  roomKeyFor(kind: RoomKind, id: string): string
}

/** True when `userId` is a member of the group room (kind-aware). */
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

/**
 * The @-mention bell (GROUP rooms only). Same gate order the pre-2.5 inline closure applied for
 * cleanup rooms — mute, membership, blocks, mentions pref — now kind-aware for report rooms (D11).
 */
export function makeChatMentionNotifier(deps: ChatBellDeps): GatewayChatMentions["notifyChatMention"] {
  return async (input) => {
    const { kind, roomId, actorUserId, mentionedUserId, message } = input
    // dm bells ride makeDmBellNotifier (a dm message already bells via the delivered bell).
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
 * The reply bell (GROUP rooms only; dm replies ride makeDmBellNotifier). NO isMutedFor gate BY
 * DESIGN: a reply to your message pierces the room mute — that is the entire point of this bell.
 * Everything else mirrors the mention bell (membership, blocks, mentions pref) plus presence
 * suppression: a target watching the room live sees the reply as it lands and needs no bell.
 */
export function makeChatReplyNotifier(deps: ChatBellDeps): OnChatReply {
  return async (input) => {
    const { kind, roomId, actorUserId, targetUserId, message } = input
    // dm replies ride makeDmBellNotifier (the single dm bell site owns dm reply flavor).
    if (kind === "dm") return
    if (!(await isGroupMember(deps, kind, roomId, targetUserId))) return
    if (await deps.isBlockedEitherWay(actorUserId, targetUserId)) return
    // Reply urgency is mention-class: the mentions pref gates the bell entirely (row + push); push
    // master switch + quiet hours are applied inside createNotification as for every other bell.
    if (!(await deps.notificationService.getPrefs(targetUserId)).mentions) return
    if (deps.presence) {
      let online: string[] = []
      try {
        online = await deps.presence.online(deps.roomKeyFor(kind, roomId))
      } catch {
        online = [] // best-effort presence: a lookup failure never suppresses the bell
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

/** The (much smaller) dep set the dm delivered bell needs. */
export type DmBellDeps = Pick<ChatBellDeps, "notificationService" | "isMutedFor">

/**
 * The DM delivered bell (the wiring's `onDmDelivered`), with the P2 2.5 reply override. The caller
 * (frame-handler fireDmBell) already applies presence suppression and never fires for the sender, and
 * the send path already rejects blocked pairs — so this owns only the mute/reply/copy logic.
 *
 * Reply semantics: `message.replyTo.from.id === recipientId` marks "this dm replies to YOU".
 *   - MUTED thread: only such a reply bells (pierces the mute), and only when `prefs.mentions` allows
 *     (mute-piercing is mention-class urgency). Everything else stays silent.
 *   - UNMUTED thread: the normal single bell fires either way — being a reply only swaps the title to
 *     the reply-flavored copy. One call site => never two bells for one dm message.
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
