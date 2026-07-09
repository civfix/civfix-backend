/**
 * Task D-D1: build the report-chat SYSTEM-message emitter (the timeline choke point) from CONTAINER
 * PRIMITIVES, so it can be constructed wherever the admin / citizen report services are wired — WITHOUT
 * depending on the chat-gateway wiring's instances.
 *
 * The emitter's three deps are assembled exactly the way the chat gateway (chat-gateway-wiring.ts) builds
 * its own report-chat notifier:
 *   - reportChat  = makeReportChatRepository(sql)         (system-message insert + member lookup)
 *   - broadcast   = container.chatService.broadcast       (fan the system frame to the live room)
 *   - notify      = makeReportChatNotifier({ notificationService, reportChatRepo, isMuted, presence?,
 *                    roomKeyFor })                          (per-member bell, skipping present/muted)
 *   - notificationService = makeNotificationService(...)   (same shape as the container/chat wiring)
 *   - isMuted     = makeConversationMutesRepository(sql), scoped to roomKind "report"
 *   - roomKeyFor  from ../ws/gateway.js
 *
 * PRESENCE: the room presence adapter (RedisChatPresence / InMemoryChatPresence) is built inside the chat
 * gateway wiring and is NOT readily reachable from the admin/citizen service context, so `presence` is
 * passed as undefined here. Effect: a member currently VIEWING the report chat also receives a push for a
 * system event (minor over-notification; acceptable — see task note). Live delivery still happens via the
 * broadcast, so the viewer sees the message immediately regardless.
 *
 * FAKE-CHAT GUARD: under USE_FAKE_CHAT (no DB / no real chat + notification services) this degrades to a
 * NO-OP emitter rather than crashing — mirroring how the report's other best-effort side effects
 * (onReportMessage / notifyReporter) are gated off under fake-chat.
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

/** A no-op emitter used under fake-chat (or any absent-service path). emit() resolves without side effects. */
export const NOOP_REPORT_CHAT_EMITTER: ReportChatSystemEmitter = {
  emit: () => Promise.resolve(),
}

/**
 * Build the real container-backed emitter, or the no-op emitter under fake-chat. `logger` (defaults to
 * container-less no-op) is threaded into both the notification service and the emitter's swallowed-error
 * warnings.
 */
export function makeContainerReportChatEmitter(
  container: Container,
  logger?: FastifyBaseLogger,
): ReportChatSystemEmitter {
  // Fake-chat: no DB + a no-op chat service, so mirror the other report side-effects and degrade to no-op.
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
  const isMuted = async (userId: string, roomId: string): Promise<boolean> => {
    try {
      return await conversationMutes.isMuted(userId, "report", roomId)
    } catch {
      return false
    }
  }

  const notify = makeReportChatNotifier({
    notificationService,
    reportChatRepo: { listMemberIds: (reportId) => reportChatRepo.listMemberIds(reportId) },
    isMuted,
    // presence intentionally omitted — not reachable from the admin/citizen service context (see header).
    roomKeyFor,
  })

  return makeReportChatSystemEmitter({
    reportChat: reportChatRepo,
    broadcast: (roomKey, message) => container.chatService.broadcast(roomKey, message),
    notify,
    roomKeyFor,
    ...(logger !== undefined ? { logger } : {}),
  })
}
