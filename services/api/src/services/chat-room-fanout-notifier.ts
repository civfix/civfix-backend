
import type { ChatMessageDTO } from "@civfix/shared"
import type { NotificationService } from "./notification-service.js"
import type { MessageKey } from "../i18n/renderMessage.js"
import { CONVERSATION_BELL } from "./conversation-bell.js"
import { textPreview } from "../routes/chat-notify-copy.js"
import { mapWithLimit } from "./media-presign.js"

export type RoomFanoutKind = "report" | "group"

const FANOUT_CONCURRENCY = 8

export const ROOM_FANOUT_MEMBER_CAP = 2000

export const ROOM_ACTIVITY_COALESCE_WINDOW_MS = 10 * 60 * 1000

const FANOUT_MARKER_SWEEP_THRESHOLD = 5000

export interface RoomFanoutNotifierDeps {
  notificationService: Pick<NotificationService, "createNotifications">
  listMemberIds: (roomId: string) => Promise<string[]>
  isMuted: (userId: string, roomId: string) => Promise<boolean>
  mutedUserIdsFor?: (roomId: string, userIds: string[]) => Promise<Set<string>>
  presence?: { online(roomKey: string): Promise<string[]> } | undefined
  roomKey: (roomId: string) => string
  isBlockedEitherWay: (a: string, b: string) => Promise<boolean>
  blockedIdsFor?: (actorId: string, candidateIds: string[]) => Promise<Set<string>>
  coalesceWindowMs?: number
  now?: () => number
}

export interface RoomFanoutSpec {
  kind: RoomFanoutKind
  titleFallbackKey: MessageKey
}

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

export function makeRoomFanoutNotifier(
  spec: RoomFanoutSpec,
  deps: RoomFanoutNotifierDeps,
): (roomId: string, message: ChatMessageDTO) => Promise<void> {
  const bell = CONVERSATION_BELL[spec.kind]
  const coalesceWindowMs = deps.coalesceWindowMs ?? ROOM_ACTIVITY_COALESCE_WINDOW_MS
  const clock = deps.now ?? (() => Date.now())
  const lastFanoutAt = new Map<string, number>()

  function fannedOutRecently(roomId: string, at: number): boolean {
    const previous = lastFanoutAt.get(roomId)
    return previous !== undefined && at - previous < coalesceWindowMs
  }

  function markFannedOut(roomId: string, at: number): void {
    if (lastFanoutAt.size >= FANOUT_MARKER_SWEEP_THRESHOLD) {
      for (const [id, seenAt] of lastFanoutAt) {
        if (at - seenAt >= coalesceWindowMs) lastFanoutAt.delete(id)
      }
    }
    lastFanoutAt.set(roomId, at)
  }

  return async (roomId, message) => {
    const at = clock()
    if (fannedOutRecently(roomId, at)) return

    const actorId = message.from?.id ?? null
    const memberIds = (await deps.listMemberIds(roomId)).slice(0, ROOM_FANOUT_MEMBER_CAP)

    let present: string[] = []
    if (deps.presence) {
      try {
        present = await deps.presence.online(deps.roomKey(roomId))
      } catch {
        present = []
      }
    }
    const presentSet = new Set(present)

    const replyTargetId = message.replyTo?.from?.id ?? null
    const mentionedIds = new Set(message.mentions.map((m) => m.id))

    const candidates = memberIds.filter(
      (m) => m !== actorId && m !== replyTargetId && !mentionedIds.has(m) && !presentSet.has(m),
    )
    if (candidates.length === 0) return

    const blocked = await blockedIds(deps, actorId, candidates)
    const unblocked = candidates.filter((id) => !blocked.has(id))
    if (unblocked.length === 0) return
    const muted = await mutedIds(deps, roomId, unblocked)
    const recipients = unblocked.filter((id) => !muted.has(id))
    if (recipients.length === 0) return

    const name = message.from?.name?.trim() ? message.from.name : null
    const preview = textPreview(message)

    markFannedOut(roomId, at)

    await deps.notificationService
      .createNotifications(recipients, {
        type: bell.type,
        ...(name !== null ? { title: name } : { titleKey: spec.titleFallbackKey }),
        ...(preview !== null ? { body: preview } : { bodyKey: "notification.message.no_preview" }),
        link: bell.link(roomId),
        coalesceWindowMs,
      })
      .catch(() => {})
  }
}
