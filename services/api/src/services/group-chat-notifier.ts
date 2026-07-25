/**
 * P4 Task 4.5: per-member bell for a group-chat message (the report-chat-notifier twin over
 * chat_group_members).
 *
 * When a member posts into a group room, every OTHER member should get a `group_chat` notification
 * (link /messages/group/:id) -- except:
 *   - the sender (they wrote it),
 *   - anyone currently PRESENT in the room (they see it live; mirrors the DM presence-suppression),
 *   - anyone who MUTED this group (conversation_mutes room_kind 'group'),
 *   - the REPLY TARGET and any @-MENTIONED member (GROUP-ROOM DEDUPE POINT: they get the richer,
 *     mute-piercing reply / mention bell from chat-bells instead — excluding them here keeps it to
 *     exactly one bell per member per message, the same contract as the report fan-out).
 *
 * `createNotification` itself applies the push master switch + quiet hours (typeAllowedByPrefs groups
 * `group_chat` under `prefs.cleanupChat` per plan D8), so this module only owns the
 * mute/presence/sender/dedupe filtering. Fully best-effort: a failed send for one recipient never
 * blocks the others or the send path.
 */

import type { ChatMessageDTO } from "@civfix/shared"
import type { NotificationService } from "./notification-service.js"
import { textPreview } from "../routes/chat-notify-copy.js"

export interface GroupChatNotifierDeps {
  notificationService: Pick<NotificationService, "createNotification">
  groupRepo: { listMemberIds(groupId: string): Promise<string[]> }
  /** True when `userId` has muted THIS group. Already scoped to roomKind "group" by the caller. */
  isMuted: (userId: string, roomId: string) => Promise<boolean>
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
}

/**
 * M11 gate: is this recipient blocked either way with the message's author? FAILS CLOSED — a lookup
 * error suppresses the bell rather than delivering a push that may be from a blocked user (the twin of
 * the report fan-out's helper).
 */
async function isBlocked(
  deps: Pick<GroupChatNotifierDeps, "isBlockedEitherWay">,
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

/**
 * Build the group-chat member notifier. The returned `notify(groupId, message)` is fully
 * fire-and-forget: it swallows every per-recipient error so a bell failure never surfaces on the send
 * path. Callers may still `void notify(...).catch(() => {})` for the (already best-effort)
 * member-list / presence lookups.
 */
export function makeGroupChatNotifier(
  deps: GroupChatNotifierDeps,
): (groupId: string, message: ChatMessageDTO) => Promise<void> {
  return async (groupId, message) => {
    const actorId = message.from?.id ?? null
    const memberIds = await deps.groupRepo.listMemberIds(groupId)

    let present: string[] = []
    if (deps.presence) {
      try {
        present = await deps.presence.online(deps.roomKeyFor("group", groupId))
      } catch {
        present = []
      }
    }
    const presentSet = new Set(present)

    // GROUP-ROOM DEDUPE POINT (see module banner + chat-bells' DEDUPE MAP): the replied-to user gets
    // the mute-piercing REPLY bell and @-mentioned members the MENTION bell — both fired from the same
    // send. (If their `prefs.mentions` is off, that richer bell is suppressed and they get no bell at
    // all — their choice; mirrors the report fan-out.)
    const replyTargetId = message.replyTo?.from?.id ?? null
    const mentionedIds = new Set(message.mentions.map((m) => m.id))

    // Skip the sender, the reply target, mentioned members, and anyone watching the room live.
    const candidates = memberIds.filter(
      (m) => m !== actorId && m !== replyTargetId && !mentionedIds.has(m) && !presentSet.has(m),
    )
    if (candidates.length === 0) return

    // Title: the sender's display name, or the localized fallback for no-name senders.
    const name = message.from?.name?.trim() ? message.from.name : null
    const preview = textPreview(message)

    for (const recipientId of candidates) {
      // M11: blocks first — a blocked pair must never bell each other, whatever their mute state.
      if (await isBlocked(deps, actorId, recipientId)) continue

      // Per-recipient mute check (the report-fan-out stance: the mute store is keyed
      // (userId, roomKind, roomId); the batch `mutedRoomIdsFor` is one-user-many-rooms — wrong shape).
      let muted = false
      try {
        muted = await deps.isMuted(recipientId, groupId)
      } catch {
        muted = false
      }
      if (muted) continue

      await deps.notificationService
        .createNotification(recipientId, {
          type: "group_chat",
          ...(name !== null ? { title: name } : { titleKey: "notification.group_chat.title_fallback" }),
          ...(preview !== null ? { body: preview } : { bodyKey: "notification.message.no_preview" }),
          link: `/messages/group/${groupId}`,
        })
        .catch(() => {})
    }
  }
}
