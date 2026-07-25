/**
 * The per-member ROOM FAN-OUT bell, shared by the report-chat and group-chat lanes.
 *
 * When a member posts into a report or group room, every OTHER member gets exactly one bell
 * (`report_chat` -> /messages/report/:id, `group_chat` -> /messages/group/:id) — except:
 *   - the sender (they wrote it),
 *   - anyone currently PRESENT in the room (they see it live; mirrors the DM presence suppression),
 *   - anyone who MUTED this room (conversation_mutes),
 *   - anyone BLOCKED either way with the author (M11),
 *   - the REPLY TARGET and any @-MENTIONED member (ROOM DEDUPE POINT, see chat-bells' DEDUPE MAP: they
 *     get the richer, mute-piercing reply / mention bell from the same send instead — excluding them here
 *     keeps it to exactly one bell per member per message).
 *
 * The two lanes differed only in notification type, deep link, title fallback key and member-list dep, so
 * the pipeline lives here once; report-chat-notifier.ts / group-chat-notifier.ts are thin lane binders
 * that keep their published dep shapes (the WS wiring, the poll notifier and the report system-message
 * emitter all construct through them).
 *
 * `createNotification` itself applies the push master switch + quiet hours (typeAllowedByPrefs groups both
 * types under `prefs.cleanupChat`), so this module owns only the sender/presence/mute/block/dedupe
 * filtering. Fully best-effort: a failed send for one recipient never blocks the others or the send path.
 *
 * ROUND TRIPS: the block and mute verdicts for the WHOLE candidate set are resolved before any bell is
 * created — in one query each when the caller wires the batch seams (blockedIdsFor / mutedUserIdsFor),
 * else per candidate under a concurrency cap; the bells fan out under the same cap. The per-recipient
 * "block, then mute, then create, awaited one at a time" loop this replaces cost a 200-member room ~600
 * strictly sequential round trips per message.
 */

import type { ChatMessageDTO } from "@civfix/shared"
import type { NotificationService } from "./notification-service.js"
import type { MessageKey } from "../i18n/renderMessage.js"
import { CONVERSATION_BELL } from "./conversation-bell.js"
import { textPreview } from "../routes/chat-notify-copy.js"
import { mapWithLimit } from "./media-presign.js"

/** The room kinds with an all-member fan-out (cleanup rooms bell mentions/replies only; dm has its own bell). */
export type RoomFanoutKind = "report" | "group"

/** Concurrency cap for the per-candidate gate lookups and the bell fan-out. */
const FANOUT_CONCURRENCY = 8

export interface RoomFanoutNotifierDeps {
  notificationService: Pick<NotificationService, "createNotification">
  /** The room's member ids (the fan-out universe). */
  listMemberIds: (roomId: string) => Promise<string[]>
  /** True when `userId` has muted THIS room. Already scoped to the lane's roomKind by the binder. */
  isMuted: (userId: string, roomId: string) => Promise<boolean>
  /**
   * Optional batch mute lookup for one room and many users (the inverse shape of the threads inbox's
   * mutedRoomIdsFor). When wired the whole candidate set costs ONE query; when absent the per-user
   * `isMuted` runs under the concurrency cap instead.
   */
  mutedUserIdsFor?: (roomId: string, userIds: string[]) => Promise<Set<string>>
  /** Optional presence source; when absent no one is treated as present. */
  presence?: { online(roomKey: string): Promise<string[]> } | undefined
  /** The presence key for this room (the binder closes over the lane's kind). */
  roomKey: (roomId: string) => string
  /** M11 blocked-either-way check, per candidate. */
  isBlockedEitherWay: (a: string, b: string) => Promise<boolean>
  /**
   * Optional batch block lookup: of `candidateIds`, which are blocked either way with `actorId`. One query
   * for the whole set. Falls back to `isBlockedEitherWay` per candidate when absent.
   */
  blockedIdsFor?: (actorId: string, candidateIds: string[]) => Promise<Set<string>>
}

/** What distinguishes a lane: its bell kind (type + link come from CONVERSATION_BELL) and title fallback. */
export interface RoomFanoutSpec {
  kind: RoomFanoutKind
  /** Localized title used when the author has no display name (a system message has no author at all). */
  titleFallbackKey: MessageKey
}

/**
 * M11 gate, FAIL-CLOSED: a lookup error marks the candidate blocked rather than delivering a push that may
 * be from a blocked user. (The other best-effort lookups here fail OPEN; a block is the one thing worth
 * losing a bell over.) An anonymous/sender-less message carries no actor, so nobody can be blocked with it.
 */
async function blockedIds(
  deps: RoomFanoutNotifierDeps,
  actorId: string | null,
  candidates: string[],
): Promise<Set<string>> {
  if (actorId === null || candidates.length === 0) return new Set()
  if (deps.blockedIdsFor) {
    try {
      return await deps.blockedIdsFor(actorId, candidates)
    } catch {
      return new Set(candidates)
    }
  }
  const verdicts = await mapWithLimit(candidates, FANOUT_CONCURRENCY, async (recipientId) => {
    try {
      return await deps.isBlockedEitherWay(actorId, recipientId)
    } catch {
      return true
    }
  })
  return new Set(candidates.filter((_, i) => verdicts[i] === true))
}

/** Mute gate, FAIL-OPEN: a missing/erroring mute store must not silence the room. */
async function mutedIds(
  deps: RoomFanoutNotifierDeps,
  roomId: string,
  candidates: string[],
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set()
  if (deps.mutedUserIdsFor) {
    try {
      return await deps.mutedUserIdsFor(roomId, candidates)
    } catch {
      return new Set()
    }
  }
  const verdicts = await mapWithLimit(candidates, FANOUT_CONCURRENCY, async (recipientId) => {
    try {
      return await deps.isMuted(recipientId, roomId)
    } catch {
      return false
    }
  })
  return new Set(candidates.filter((_, i) => verdicts[i] === true))
}

/**
 * Build a lane's member notifier. The returned `notify(roomId, message)` is fully fire-and-forget: it
 * swallows every per-recipient error so a bell failure never surfaces on the send path. Callers may still
 * `void notify(...).catch(() => {})` for the (already best-effort) member-list / presence lookups.
 */
export function makeRoomFanoutNotifier(
  spec: RoomFanoutSpec,
  deps: RoomFanoutNotifierDeps,
): (roomId: string, message: ChatMessageDTO) => Promise<void> {
  const bell = CONVERSATION_BELL[spec.kind]
  return async (roomId, message) => {
    const actorId = message.from?.id ?? null
    const memberIds = await deps.listMemberIds(roomId)

    let present: string[] = []
    if (deps.presence) {
      try {
        present = await deps.presence.online(deps.roomKey(roomId))
      } catch {
        present = []
      }
    }
    const presentSet = new Set(present)

    // ROOM DEDUPE POINT (see module banner): the replied-to user gets the mute-piercing REPLY bell and
    // @-mentioned members the MENTION bell, both fired from the same send. (If their `prefs.mentions` is
    // off, that richer bell is suppressed and they get no bell at all — their choice.)
    const replyTargetId = message.replyTo?.from?.id ?? null
    const mentionedIds = new Set(message.mentions.map((m) => m.id))

    const candidates = memberIds.filter(
      (m) => m !== actorId && m !== replyTargetId && !mentionedIds.has(m) && !presentSet.has(m),
    )
    if (candidates.length === 0) return

    // Blocks first — a blocked pair must never bell each other, whatever their mute state. Both verdicts
    // are resolved for the whole set before any bell is created (see ROUND TRIPS in the banner).
    const blocked = await blockedIds(deps, actorId, candidates)
    const unblocked = candidates.filter((id) => !blocked.has(id))
    if (unblocked.length === 0) return
    const muted = await mutedIds(deps, roomId, unblocked)
    const recipients = unblocked.filter((id) => !muted.has(id))
    if (recipients.length === 0) return

    // Title: the sender's display name, or the lane's localized fallback for no-name / sender-less messages.
    const name = message.from?.name?.trim() ? message.from.name : null
    const preview = textPreview(message)

    await mapWithLimit(recipients, FANOUT_CONCURRENCY, (recipientId) =>
      deps.notificationService
        .createNotification(recipientId, {
          type: bell.type,
          ...(name !== null ? { title: name } : { titleKey: spec.titleFallbackKey }),
          ...(preview !== null ? { body: preview } : { bodyKey: "notification.message.no_preview" }),
          link: bell.link(roomId),
        })
        .catch(() => {}),
    )
  }
}
