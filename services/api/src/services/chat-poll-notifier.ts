/**
 * P6 Task 6.3: the poll-create member fan-out, built from CONTAINER PRIMITIVES so the REST poll route can
 * raise "the same bells a normal send gets" without reaching into the chat-gateway wiring (whose
 * onGroupMessage / onReportMessage hooks are gateway-only). Same construction stance as
 * report-chat-emitter.ts: the notifier factories (makeReportChatNotifier / makeGroupChatNotifier) are
 * assembled over the container's notification service + conversation-mutes repo + chat repos.
 *
 * WHICH ROOMS FAN OUT: a group room's normal send fans a `group_chat` bell to every other member
 * (onGroupMessage); a report room's send fans a `report_chat` bell (onReportMessage's member half). A
 * CLEANUP room has NO all-member fan-out — a plain cleanup send only bells @-mentions / reply targets
 * (chat-bells), and a poll carries neither — so a cleanup poll bells no one, exactly matching a normal
 * cleanup send. So this notifier fires for report + group and is a no-op for cleanup.
 *
 * BLOCKS: NOT omitted — see the M11 note at the isBlockedEitherWay wiring below. Every bell this module
 * can raise carries the poll author's name to another member of a room that may be PUBLIC, so the block
 * gate is as load-bearing here as it is on the gateway's message fan-out.
 *
 * PRESENCE: omitted (same as report-chat-emitter) — the room presence adapter is built in the gateway
 * wiring and isn't reachable here, so a member currently VIEWING the room also gets a push for a new poll
 * (minor over-notification; the live broadcast already delivers the poll instantly regardless).
 *
 * FAKE-CHAT: degrades to a no-op (no DB / notification service), mirroring the other best-effort chat
 * side effects gated off under USE_FAKE_CHAT.
 */

import type { FastifyBaseLogger } from "fastify"
import type { ChatMessageDTO } from "@civfix/shared"
import type { Container } from "../di.js"
import type { PollRoomKind } from "./chat-poll-service.js"
import { makeReportChatRepository } from "./report-chat-repository.drizzle.js"
import { makeChatGroupRepository } from "./chat-group-repository.drizzle.js"
import { makeReportChatNotifier } from "./report-chat-notifier.js"
import { makeGroupChatNotifier } from "./group-chat-notifier.js"
import { makeNotificationService } from "./notification-service.js"
import { makeDrizzleNotificationRepository } from "./notification-repository.drizzle.js"
import { makeConversationMutesRepository } from "./conversation-mutes-repository.drizzle.js"
import { roomKeyFor } from "../ws/gateway.js"

/** notify(roomKind, roomId, message): best-effort fan-out; swallows all errors. */
export type PollRoomNotifier = (
  roomKind: PollRoomKind,
  roomId: string,
  message: ChatMessageDTO,
) => void

const NOOP_POLL_NOTIFIER: PollRoomNotifier = () => {}

export function makeContainerPollNotifier(
  container: Container,
  logger?: FastifyBaseLogger,
): PollRoomNotifier {
  if (container.env.USE_FAKE_CHAT) return NOOP_POLL_NOTIFIER

  const sql = container.getDb().sql
  const reportChatRepo = makeReportChatRepository(sql)
  const groupRepo = makeChatGroupRepository(sql)

  const notificationService = makeNotificationService({
    repo: makeDrizzleNotificationRepository(sql),
    pushSender: container.pushSender,
    userChannel: container.userChannel,
    ...(logger !== undefined ? { logger } : {}),
  })

  const conversationMutes = makeConversationMutesRepository(sql)
  const isMuted = async (
    userId: string,
    kind: "report" | "group",
    roomId: string,
  ): Promise<boolean> => {
    try {
      return await conversationMutes.isMuted(userId, kind, roomId)
    } catch {
      return false
    }
  }
  /**
   * Batch mute shape (one query for the whole member set) so a poll in a large room doesn't pay one round
   * trip per recipient.
   *
   * PROBED, never bound to an empty-Set default (the chat-gateway-wiring stance): the fan-out treats a
   * present `mutedUserIdsFor` as AUTHORITATIVE and skips the per-user `isMuted` entirely, so a
   * `?? Promise.resolve(new Set())` fallback on an absent batch method would silently UNMUTE the whole
   * room. Absent => the dep is omitted and the notifier keeps its per-candidate `isMuted` gate.
   */
  const mutedUserIdsForRoom = (
    kind: "report" | "group",
  ): ((roomId: string, userIds: string[]) => Promise<Set<string>>) | undefined => {
    const batch = conversationMutes.mutedUserIdsFor
    if (!batch) return undefined
    return (roomId, userIds) => batch.call(conversationMutes, kind, roomId, userIds)
  }
  const reportMutedUserIdsFor = mutedUserIdsForRoom("report")
  const groupMutedUserIdsFor = mutedUserIdsForRoom("group")

  // SECURITY (M11): the SAME block gate the gateway's message fan-out applies (chat-gateway-wiring), and
  // the reason this module's notifiers must never be built without one. A poll create/close raises the
  // identical member-wide bell a normal send does — sender name + preview on the target's lock screen —
  // so leaving it off here reproduced the whole M11 scenario on the REST poll path: a blocked user posts
  // a poll into a shared PUBLIC report or group room and reaches the person who blocked them.
  const blocksRepo = container.getBlocksRepo()
  const isBlockedEitherWay = (a: string, b: string): Promise<boolean> =>
    blocksRepo.isBlockedEitherWay(a, b)
  // Batch form of the same M11 gate (one user_blocks query for the room's whole candidate set). PROBED
  // like the mute seam above — the fan-out treats a present `blockedIdsFor` as authoritative, so an
  // empty-Set default on an absent batch method would unblock the room. Absent => per-candidate gate.
  const blockedIdsFor = (():
    | ((actorId: string, candidateIds: string[]) => Promise<Set<string>>)
    | undefined => {
    const batch = blocksRepo.blockedIdsAmong
    if (!batch) return undefined
    return (actorId, candidateIds) => batch.call(blocksRepo, actorId, candidateIds)
  })()

  const notifyReport = makeReportChatNotifier({
    notificationService,
    reportChatRepo: { listMemberIds: (reportId) => reportChatRepo.listMemberIds(reportId) },
    isMuted: (userId, roomId) => isMuted(userId, "report", roomId),
    ...(reportMutedUserIdsFor ? { mutedUserIdsFor: reportMutedUserIdsFor } : {}),
    roomKeyFor,
    isBlockedEitherWay,
    ...(blockedIdsFor ? { blockedIdsFor } : {}),
  })
  const notifyGroup = makeGroupChatNotifier({
    notificationService,
    groupRepo: { listMemberIds: (groupId) => groupRepo.listMemberIds(groupId) },
    isMuted: (userId, roomId) => isMuted(userId, "group", roomId),
    ...(groupMutedUserIdsFor ? { mutedUserIdsFor: groupMutedUserIdsFor } : {}),
    roomKeyFor,
    isBlockedEitherWay,
    ...(blockedIdsFor ? { blockedIdsFor } : {}),
  })

  return (roomKind, roomId, message) => {
    if (roomKind === "report") void notifyReport(roomId, message).catch(() => {})
    else if (roomKind === "group") void notifyGroup(roomId, message).catch(() => {})
    // cleanup: no all-member fan-out (matches a normal cleanup send).
  }
}
