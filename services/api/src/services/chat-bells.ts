/**
 * Where each "no double bell" decision lives:
 *   - reply target also @-mentioned: ws/frame-handler fireMentionBells skips the mention bell for the
 *     reply target (the reply bell wins).
 *   - report and group member fan-out: report-chat-notifier and group-chat-notifier exclude the reply
 *     target and the @-mentioned members, who get the richer reply or mention bell instead.
 *   - dm reply vs dm delivered bell: makeDmBellNotifier is the single dm bell site, so one bell by
 *     construction.
 */
import type { ChatMessageDTO, RoomKind } from "@civfix/contract"
import type { FastifyBaseLogger } from "fastify"
import type { NotificationService } from "./notification-service.js"
import { CONVERSATION_BELL } from "./conversation-bell.js"
import { messageAuthorName, textPreview } from "./chat-notify-copy.js"
import type { MessageKey } from "../i18n/renderMessage.js"
import type { GatewayChatMentions, OnChatReply, OnDmDelivered } from "../ws/types.js"
import { conversationNameOf, type ConversationNameLookups } from "./conversation-names.js"

type GroupRoomKind = "cleanup" | "report" | "group"

const NO_PREVIEW_BODY_KEY = "notification.message.no_preview" satisfies MessageKey

const CHAT_MENTION_TITLE_KEY = "notification.chat_mention.title" satisfies MessageKey

const CHAT_REPLY_TITLE_KEY = "notification.chat_reply.title" satisfies MessageKey

const DM_TITLE_FALLBACK_KEY = "notification.dm.title_fallback" satisfies MessageKey

function previewBody(message: ChatMessageDTO): { body: string } | { bodyKey: MessageKey } {
  const preview = textPreview(message)
  return preview !== null ? { body: preview } : { bodyKey: NO_PREVIEW_BODY_KEY }
}

export interface ChatBellDeps {
  notificationService: Pick<NotificationService, "createNotification" | "categorySetting">
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
  conversationNames?: ConversationNameLookups
  logger?: Pick<FastifyBaseLogger, "warn">
}

async function isGroupMember(
  deps: ChatBellDeps,
  kind: GroupRoomKind,
  roomId: string,
  userId: string,
): Promise<boolean> {
  if (kind === "report") return deps.isReportChatMember(roomId, userId)
  if (kind === "group") return deps.isChatGroupMember(roomId, userId)
  return deps.isCleanupMember(roomId, userId)
}

async function bellGroupMember(
  deps: ChatBellDeps,
  recipientId: string,
  kind: GroupRoomKind,
  roomId: string,
  message: ChatMessageDTO,
  titleKey: MessageKey,
): Promise<void> {
  const conversationName = await conversationNameOf(
    deps.conversationNames,
    kind,
    roomId,
    deps.logger,
  )
  // The link comes straight off CONVERSATION_BELL: clear-on-open matches chat_mention rows on the room's
  // own link, so a hand-written copy would strand them once either side changed.
  await deps.notificationService.createNotification(recipientId, {
    type: "chat_mention",
    titleKey,
    vars: { name: messageAuthorName(message) },
    ...previewBody(message),
    link: CONVERSATION_BELL[kind].link(roomId),
    ...(conversationName !== undefined ? { conversationName } : {}),
  })
}

function dmBellTitle(
  name: string,
  isReplyToRecipient: boolean,
): { titleKey: MessageKey; vars?: { name: string } } | { title: string } {
  if (name === "") return { titleKey: DM_TITLE_FALLBACK_KEY }
  if (isReplyToRecipient) return { titleKey: CHAT_REPLY_TITLE_KEY, vars: { name } }
  return { title: name }
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
    await bellGroupMember(deps, mentionedUserId, kind, roomId, message, CHAT_MENTION_TITLE_KEY)
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
    if (deps.presence) {
      let online: string[] = []
      try {
        online = await deps.presence.online(deps.roomKeyFor(kind, roomId))
      } catch {
        online = [] // a presence lookup failure never suppresses the bell
      }
      if (online.includes(targetUserId)) return
    }
    await bellGroupMember(deps, targetUserId, kind, roomId, message, CHAT_REPLY_TITLE_KEY)
  }
}

export type DmBellDeps = Pick<ChatBellDeps, "notificationService" | "isMutedFor">

/**
 * The caller (frame-handler fireDmBell) already applies presence suppression and never fires for the
 * sender, and the send path already rejects blocked pairs, so this owns only mute, reply and copy.
 * In a muted thread only a reply to the recipient bells, and only with Mentions and replies on
 * (mute-piercing is mention-class urgency); the row stays a dm, so Direct messages gates it too. In an
 * unmuted thread a reply only swaps the title copy.
 */
export function makeDmBellNotifier(deps: DmBellDeps): OnDmDelivered {
  return async (threadId, recipientId, message) => {
    const isReplyToRecipient = message.replyTo?.from?.id === recipientId
    if (await deps.isMutedFor(recipientId, "dm", threadId)) {
      if (!isReplyToRecipient) return
      if (!(await deps.notificationService.categorySetting(recipientId, "mentions")).enabled) return
    }
    const bell = CONVERSATION_BELL.dm
    const name = messageAuthorName(message)
    await deps.notificationService.createNotification(recipientId, {
      type: bell.type,
      ...dmBellTitle(name, isReplyToRecipient),
      ...previewBody(message),
      link: bell.link(threadId),
      ...(name !== "" ? { conversationName: name } : {}),
    })
  }
}
