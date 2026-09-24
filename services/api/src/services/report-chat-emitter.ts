/**
 * Built from container primitives so the admin and citizen report services can emit timeline messages
 * without depending on the chat-gateway wiring's instances.
 *
 * The room presence adapter lives inside the chat gateway wiring and is not reachable from here, so a
 * member currently viewing the report chat also gets a push for a system event. That over-notification
 * is accepted: the broadcast still delivers the message live.
 */

import type { FastifyBaseLogger } from "fastify"
import type { Container } from "../di.js"
import { makeReportChatRepository } from "./report-chat-repository.drizzle.js"
import { makeReportChatNotifier } from "./report-chat-notifier.js"
import { makeNotificationService } from "./notification-service.js"
import { makeDrizzleNotificationRepository } from "./notification-repository.drizzle.js"
import { makeConversationMutesRepository } from "./conversation-mutes-repository.drizzle.js"
import { roomKeyFor } from "../ws/gateway.js"
import {
  makeReportChatSystemEmitter,
  type ReportChatSystemEmitter,
} from "./report-timeline-event.js"

export const NOOP_REPORT_CHAT_EMITTER: ReportChatSystemEmitter = {
  emit: () => Promise.resolve(),
}

export function makeContainerReportChatEmitter(
  container: Container,
  logger?: Pick<FastifyBaseLogger, "warn" | "error">,
  opts: { propagateInsertFailure?: boolean } = {},
): ReportChatSystemEmitter {
  // Fake chat has no DB, so this degrades to a no-op like the report's other best-effort side effects.
  if (container.env.USE_FAKE_CHAT) return NOOP_REPORT_CHAT_EMITTER

  const sql = container.getDb().sql
  const reportChatRepo = makeReportChatRepository(sql)

  const notificationService = makeNotificationService({
    repo: makeDrizzleNotificationRepository(sql),
    pushSender: container.pushSender,
    userChannel: container.userChannel,
    ...(logger !== undefined ? { logger } : {}),
  })

  const conversationMutes = makeConversationMutesRepository(sql)

  /**
   * Probed, never bound to an empty-Set default: the fan-out treats a present `mutedUserIdsFor` as
   * authoritative and skips the per-user `isMuted`, so a `new Set()` fallback would silently unmute the
   * whole room over a mutes store without the batch method.
   */
  const mutedUserIdsFor = (():
    | ((roomId: string, userIds: string[]) => Promise<Set<string>>)
    | undefined => {
    const batch = conversationMutes.mutedUserIdsFor
    if (!batch) return undefined
    return (roomId, userIds) => batch.call(conversationMutes, "report", roomId, userIds)
  })()

  const notify = makeReportChatNotifier({
    notificationService,
    reportChatRepo,
    isMuted: (userId, roomId) => conversationMutes.isMuted(userId, "report", roomId),
    ...(mutedUserIdsFor ? { mutedUserIdsFor } : {}),
    roomKeyFor,
    // System messages have no author, so the notifier short-circuits this gate on a null actor. It is
    // wired to the real repo rather than a `() => false` stub so a timeline event that gains an author
    // is already correct. Resolved lazily: a caller's wiring may have no blocks repo, and a throw at
    // construction would abort the caller (emit()'s try/catch only covers the emit). The batch form
    // (blockedIdsAmong) is not wired because probing it needs the repo at construction time.
    isBlockedEitherWay: (a, b) => container.getBlocksRepo().isBlockedEitherWay(a, b),
    logger,
  })

  return makeReportChatSystemEmitter({
    reportChat: reportChatRepo,
    broadcast: (roomKey, message) => container.chatService.broadcast(roomKey, message),
    notify,
    roomKeyFor,
    ...(logger !== undefined ? { logger } : {}),
    ...(opts.propagateInsertFailure === true ? { propagateInsertFailure: true } : {}),
  })
}
