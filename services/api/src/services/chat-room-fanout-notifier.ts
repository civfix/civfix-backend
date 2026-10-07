import type { ChatMessageDTO } from "@civfix/shared"
import type { FastifyBaseLogger } from "fastify"
import type { NotificationService } from "./notification-service.js"
import type { MessageKey } from "../i18n/renderMessage.js"
import { CONVERSATION_BELL } from "./conversation-bell.js"
import { textPreview } from "./chat-notify-copy.js"
import { mapWithLimit } from "../lib/concurrency.js"

export type RoomFanoutKind = "report" | "group"

const FANOUT_CONCURRENCY = 8

export const ROOM_FANOUT_MEMBER_CAP = 2000

export const REPORT_CHAT_FANOUT_MEMBER_CAP = 500

// The fan-out owns the cap: a wiring that forwards a one-argument listMemberIds still type-checks, so a
// cap passed only through the adapter is silently dropped.
const MEMBER_CAP_BY_KIND: Record<RoomFanoutKind, number> = {
  report: REPORT_CHAT_FANOUT_MEMBER_CAP,
  group: ROOM_FANOUT_MEMBER_CAP,
}

export const ROOM_ACTIVITY_COALESCE_WINDOW_MS = 10 * 60 * 1000

export const ROOM_FANOUT_THROTTLE_MS = 15 * 1000

const FANOUT_MARKER_SWEEP_THRESHOLD = 5000

const NO_PREVIEW_BODY_KEY = "notification.message.no_preview" satisfies MessageKey

export interface RoomFanoutNotifierDeps {
  notificationService: Pick<NotificationService, "createNotificationsReportingFailures">
  listMemberIds: (roomId: string, limit: number) => Promise<string[]>
  // May reject: the fan-out fails open per recipient and logs one line per fan-out, so a wiring
  // that wraps this in its own fail-open check brings back one warning per member.
  isMuted: (userId: string, roomId: string) => Promise<boolean>
  mutedUserIdsFor?: (roomId: string, userIds: string[]) => Promise<Set<string>>
  presence?: { online(roomKey: string): Promise<string[]> } | undefined
  roomKey: (roomId: string) => string
  isBlockedEitherWay: (a: string, b: string) => Promise<boolean>
  blockedIdsFor?: (actorId: string, candidateIds: string[]) => Promise<Set<string>>
  coalesceWindowMs?: number
  throttleMs?: number
  now?: () => number
  claimWindow?: (roomId: string, windowMs: number) => Promise<boolean>
  dispatchToJob?: (roomId: string, messageId: string) => Promise<void>
  logger?: Pick<FastifyBaseLogger, "warn" | "error">
}

export interface RoomFanoutSpec {
  kind: RoomFanoutKind
  titleFallbackKey: MessageKey
}

export const ROOM_FANOUT_SPEC: Record<RoomFanoutKind, RoomFanoutSpec> = {
  report: { kind: "report", titleFallbackKey: "notification.report_chat.title_fallback" },
  group: { kind: "group", titleFallbackKey: "notification.group_chat.title_fallback" },
}

interface LookupFailures {
  record(err: unknown): void
  report(msg: string): void
}

// A store outage fails every per-recipient lookup of a fan-out, so one line per fan-out carries the
// count instead of one warning per member.
function tallyLookupFailures(
  deps: RoomFanoutNotifierDeps,
  kind: RoomFanoutKind,
  candidates: number,
): LookupFailures {
  let failed = 0
  let first: unknown
  return {
    record(err) {
      if (failed === 0) first = err
      failed += 1
    },
    report(msg) {
      if (failed === 0) return
      deps.logger?.warn({ err: first, kind, failed, candidates }, msg)
    },
  }
}

async function blockedIds(
  deps: RoomFanoutNotifierDeps,
  kind: RoomFanoutKind,
  actorId: string | null,
  candidates: string[],
): Promise<Set<string>> {
  if (actorId === null || candidates.length === 0) return new Set()
  if (deps.blockedIdsFor) {
    try {
      return await deps.blockedIdsFor(actorId, candidates)
    } catch (err) {
      deps.logger?.warn({ err, kind }, "room fan-out block lookup failed; skipping the room")
      return new Set(candidates)
    }
  }
  const failures = tallyLookupFailures(deps, kind, candidates.length)
  const verdicts = await mapWithLimit(candidates, FANOUT_CONCURRENCY, async (recipientId) => {
    try {
      return await deps.isBlockedEitherWay(actorId, recipientId)
    } catch (err) {
      failures.record(err)
      return true
    }
  })
  failures.report("room fan-out block lookup failed; skipping those recipients")
  return new Set(candidates.filter((_, i) => verdicts[i] === true))
}

async function mutedIds(
  deps: RoomFanoutNotifierDeps,
  kind: RoomFanoutKind,
  roomId: string,
  candidates: string[],
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set()
  if (deps.mutedUserIdsFor) {
    try {
      return await deps.mutedUserIdsFor(roomId, candidates)
    } catch (err) {
      deps.logger?.warn({ err, kind }, "room fan-out mute lookup failed; notifying anyway")
      return new Set()
    }
  }
  const failures = tallyLookupFailures(deps, kind, candidates.length)
  const verdicts = await mapWithLimit(candidates, FANOUT_CONCURRENCY, async (recipientId) => {
    try {
      return await deps.isMuted(recipientId, roomId)
    } catch (err) {
      failures.record(err)
      return false
    }
  })
  failures.report("room fan-out mute lookup failed; notifying those recipients anyway")
  return new Set(candidates.filter((_, i) => verdicts[i] === true))
}

async function presentIds(
  deps: RoomFanoutNotifierDeps,
  kind: RoomFanoutKind,
  roomId: string,
): Promise<string[]> {
  if (!deps.presence) return []
  try {
    return await deps.presence.online(deps.roomKey(roomId))
  } catch (err) {
    deps.logger?.warn({ err, kind }, "room fan-out presence lookup failed")
    return []
  }
}

export function makeRoomFanoutNotifier(
  spec: RoomFanoutSpec,
  deps: RoomFanoutNotifierDeps,
): (roomId: string, message: ChatMessageDTO) => Promise<void> {
  const throttleMs = deps.throttleMs ?? ROOM_FANOUT_THROTTLE_MS
  const clock = deps.now ?? (() => Date.now())
  const lastFanoutAt = new Map<string, number>()

  function fannedOutRecently(roomId: string, at: number): boolean {
    const previous = lastFanoutAt.get(roomId)
    return previous !== undefined && at - previous < throttleMs
  }

  function markFannedOut(roomId: string, at: number): void {
    if (lastFanoutAt.size >= FANOUT_MARKER_SWEEP_THRESHOLD) {
      for (const [id, seenAt] of lastFanoutAt) {
        if (at - seenAt >= throttleMs) lastFanoutAt.delete(id)
      }
    }
    lastFanoutAt.set(roomId, at)
  }

  return async (roomId, message) => {
    const at = clock()
    if (fannedOutRecently(roomId, at)) return
    markFannedOut(roomId, at)

    if (deps.claimWindow !== undefined && !(await deps.claimWindow(roomId, throttleMs))) return

    if (deps.dispatchToJob !== undefined) {
      try {
        await deps.dispatchToJob(roomId, message.id)
        return
      } catch (err) {
        deps.logger?.warn(
          { err, kind: spec.kind },
          "chat.room.fanout enqueue failed; fanning out inline",
        )
      }
    }
    try {
      await runRoomFanout(spec, deps, roomId, message)
    } catch (err) {
      deps.logger?.error({ err, kind: spec.kind }, "chat.room.fanout inline fan-out failed")
    }
  }
}

export async function runRoomFanout(
  spec: RoomFanoutSpec,
  deps: RoomFanoutNotifierDeps,
  roomId: string,
  message: ChatMessageDTO,
): Promise<void> {
  const bell = CONVERSATION_BELL[spec.kind]
  const coalesceWindowMs = deps.coalesceWindowMs ?? ROOM_ACTIVITY_COALESCE_WINDOW_MS
  const actorId = message.from?.id ?? null
  const cap = MEMBER_CAP_BY_KIND[spec.kind]
  const memberIds = (await deps.listMemberIds(roomId, cap)).slice(0, cap)

  const presentSet = new Set(await presentIds(deps, spec.kind, roomId))

  const replyTargetId = message.replyTo?.from?.id ?? null
  const mentionedIds = new Set(message.mentions.map((m) => m.id))

  const candidates = memberIds.filter(
    (m) => m !== actorId && m !== replyTargetId && !mentionedIds.has(m) && !presentSet.has(m),
  )
  if (candidates.length === 0) return

  const blocked = await blockedIds(deps, spec.kind, actorId, candidates)
  const unblocked = candidates.filter((id) => !blocked.has(id))
  if (unblocked.length === 0) return
  const muted = await mutedIds(deps, spec.kind, roomId, unblocked)
  const recipients = unblocked.filter((id) => !muted.has(id))
  if (recipients.length === 0) return

  const name = message.from?.name?.trim() ? message.from.name : null
  const preview = textPreview(message)

  const { failed } = await deps.notificationService.createNotificationsReportingFailures(
    recipients,
    {
      type: bell.type,
      ...(name !== null ? { title: name } : { titleKey: spec.titleFallbackKey }),
      ...(preview !== null ? { body: preview } : { bodyKey: NO_PREVIEW_BODY_KEY }),
      link: bell.link(roomId),
      coalesceWindowMs,
    },
  )
  if (failed.length === 0) return
  // A total failure fails the chat.room.fanout job so pg-boss retries it. Re-running the whole fan-out
  // is safe because room bells coalesce into the recipient's unread row inside the coalesce window,
  // which is far longer than pg-boss's immediate retries. A partial failure completes: the room's next
  // message bells the missed members again.
  if (failed.length === recipients.length) {
    throw new Error(`room fan-out wrote no bell for ${failed.length} recipients`)
  }
  deps.logger?.warn(
    { kind: spec.kind, recipients: recipients.length, failed: failed.length },
    "room fan-out: some bells were not written",
  )
}
