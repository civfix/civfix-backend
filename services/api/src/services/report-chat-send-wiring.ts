import { randomUUID } from "node:crypto"
import type { FastifyBaseLogger } from "fastify"
import type { Container } from "../di.js"
import { makeReportChatRepository } from "./report-chat-repository.drizzle.js"
import { makeReportChatNotifier } from "./report-chat-notifier.js"
import { makeChatMentionNotifier, type ChatBellDeps } from "./chat-bells.js"
import { makeRouteNotificationService } from "./route-notifier.js"
import {
  bindMutedUserIdsFor,
  makeConversationMutesRepository,
  makeFailOpenMuteCheck,
} from "./conversation-mutes-repository.drizzle.js"
import { bindBlockedIdsAmong } from "./blocks-repository.drizzle.js"
import { makeDrizzleCleanupRepository } from "./cleanup-repository.drizzle.js"
import { makeChatGroupRepository } from "./chat-group-repository.drizzle.js"
import { makeContainerReportCityForward } from "./report-city-forward-wiring.js"
import { roomKeyFor } from "../ws/gateway.js"
import type { ChatMentionRecordSeam } from "./chat-mention-resolver.js"
import type { ReportChatSendDeps } from "./report-chat-send.js"
import type { ChatRepository } from "./chat-repository.drizzle.js"
import { insertAuditRow } from "./admin/audit-repository.drizzle.js"

const REPORT_MESSAGE_POSTED_AUDIT_ACTION = "report.message_posted"

export interface ContainerReportChatSendOptions {
  chatRepo: () => ChatRepository
  mentions?: ChatMentionRecordSeam | undefined
  logger?: FastifyBaseLogger | undefined
}

export function makeAuditedReportChatPersist(
  chatRepo: () => ChatRepository,
): ReportChatSendDeps["persist"] {
  return (input, { actingUserId }) =>
    chatRepo().insertMessage(input, randomUUID(), {
      inTx: async (tx, row) => {
        await insertAuditRow(tx, {
          actorId: actingUserId,
          action: REPORT_MESSAGE_POSTED_AUDIT_ACTION,
          target: `report:${input.cleanupId}`,
          meta: { messageId: row.id },
        })
      },
    })
}

export function makeContainerReportChatSendDeps(
  container: Container,
  options: ContainerReportChatSendOptions,
): ReportChatSendDeps {
  const base: ReportChatSendDeps = {
    persist: makeAuditedReportChatPersist(options.chatRepo),
    broadcast: (roomKey, message) => container.chatService.broadcast(roomKey, message),
  }
  if (container.env.USE_FAKE_CHAT) {
    return options.mentions ? { ...base, mentions: options.mentions } : base
  }

  const sql = container.getDb().sql
  const reportChatRepo = makeReportChatRepository(sql)
  const logger = options.logger

  const notificationService = makeRouteNotificationService(container, logger)

  const conversationMutes = makeConversationMutesRepository(sql)
  const isMutedFor = makeFailOpenMuteCheck(conversationMutes, logger)

  const mutedUserIdsFor = bindMutedUserIdsFor(conversationMutes, "report")

  const isBlockedEitherWay = (a: string, b: string): Promise<boolean> =>
    container.getBlocksRepo().isBlockedEitherWay(a, b)

  const blockedIdsFor = bindBlockedIdsAmong(container.getBlocksRepo())

  let cleanupRepo: ReturnType<typeof makeDrizzleCleanupRepository> | undefined
  let groupRepo: ReturnType<typeof makeChatGroupRepository> | undefined

  const bellDeps: ChatBellDeps = {
    notificationService,
    isMutedFor,
    isCleanupMember: (cleanupId, userId) =>
      (cleanupRepo ??= makeDrizzleCleanupRepository(sql)).isMember(cleanupId, userId),
    isReportChatMember: (reportId, userId) => reportChatRepo.isMember(reportId, userId),
    isChatGroupMember: async (groupId, userId) =>
      ((await (groupRepo ??= makeChatGroupRepository(sql)).roleOf(groupId, userId)) ?? null) !==
      null,
    isBlockedEitherWay,
    roomKeyFor,
  }

  const notifyMembers = makeReportChatNotifier({
    notificationService,
    reportChatRepo,
    isMuted: (userId, roomId) => conversationMutes.isMuted(userId, "report", roomId),
    ...(mutedUserIdsFor ? { mutedUserIdsFor } : {}),
    roomKeyFor,
    isBlockedEitherWay,
    ...(blockedIdsFor ? { blockedIdsFor } : {}),
    logger,
  })

  return {
    ...base,
    notifyMembers,
    forwardCityMention: makeContainerReportCityForward(
      container,
      logger !== undefined ? { logger } : {},
    ),
    ...(options.mentions
      ? { mentions: { ...options.mentions, notifyChatMention: makeChatMentionNotifier(bellDeps) } }
      : {}),
  }
}
