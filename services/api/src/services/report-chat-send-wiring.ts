import { randomUUID } from "node:crypto"
import type { FastifyBaseLogger } from "fastify"
import type { Container } from "../di.js"
import { makeReportChatRepository } from "./report-chat-repository.drizzle.js"
import { makeReportChatNotifier } from "./report-chat-notifier.js"
import { makeChatMentionNotifier, type ChatBellDeps } from "./chat-bells.js"
import { makeNotificationService } from "./notification-service.js"
import { makeDrizzleNotificationRepository } from "./notification-repository.drizzle.js"
import { makeConversationMutesRepository } from "./conversation-mutes-repository.drizzle.js"
import { makeDrizzleCleanupRepository } from "./cleanup-repository.drizzle.js"
import { makeChatGroupRepository } from "./chat-group-repository.drizzle.js"
import { makeContainerReportCityForward } from "./report-city-forward-wiring.js"
import { roomKeyFor } from "../ws/gateway.js"
import type { ChatMentionRecordSeam } from "./chat-mention-resolver.js"
import type { ReportChatSendDeps } from "./report-chat-send.js"
import type { ChatRepository } from "./chat-repository.drizzle.js"
import { writeAudit } from "./admin/audit.js"

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
        await writeAudit(tx, {
          actorId: actingUserId,
          action: "report.message_posted",
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

  const notificationService = makeNotificationService({
    repo: makeDrizzleNotificationRepository(sql),
    pushSender: container.pushSender,
    userChannel: container.userChannel,
    ...(logger !== undefined ? { logger } : {}),
  })

  const conversationMutes = makeConversationMutesRepository(sql)
  const isMutedFor = async (
    userId: string,
    kind: "dm" | "cleanup" | "report" | "group",
    roomId: string,
  ): Promise<boolean> => {
    try {
      return await conversationMutes.isMuted(userId, kind, roomId)
    } catch {
      return false
    }
  }

  const mutedUserIdsFor = (():
    | ((roomId: string, userIds: string[]) => Promise<Set<string>>)
    | undefined => {
    const batch = conversationMutes.mutedUserIdsFor
    if (!batch) return undefined
    return (roomId, userIds) => batch.call(conversationMutes, "report", roomId, userIds)
  })()

  const isBlockedEitherWay = (a: string, b: string): Promise<boolean> =>
    container.getBlocksRepo().isBlockedEitherWay(a, b)

  const blockedIdsFor = (():
    | ((actorId: string, candidateIds: string[]) => Promise<Set<string>>)
    | undefined => {
    const repo = container.getBlocksRepo()
    const batch = repo.blockedIdsAmong
    if (!batch) return undefined
    return (actorId, candidateIds) => batch.call(repo, actorId, candidateIds)
  })()

  let cleanupRepo: ReturnType<typeof makeDrizzleCleanupRepository> | undefined
  let groupRepo: ReturnType<typeof makeChatGroupRepository> | undefined

  const bellDeps: ChatBellDeps = {
    notificationService,
    isMutedFor,
    isCleanupMember: (cleanupId, userId) =>
      (cleanupRepo ??= makeDrizzleCleanupRepository(sql)).isMember(cleanupId, userId),
    isReportChatMember: (reportId, userId) => reportChatRepo.isMember(reportId, userId),
    isChatGroupMember: async (groupId, userId) =>
      ((await (groupRepo ??= makeChatGroupRepository(sql)).roleOf(groupId, userId)) ?? null) !== null,
    isBlockedEitherWay,
    roomKeyFor,
  }

  const notifyMembers = makeReportChatNotifier({
    notificationService,
    reportChatRepo: { listMemberIds: (reportId) => reportChatRepo.listMemberIds(reportId) },
    isMuted: (userId, roomId) => isMutedFor(userId, "report", roomId),
    ...(mutedUserIdsFor ? { mutedUserIdsFor } : {}),
    roomKeyFor,
    isBlockedEitherWay,
    ...(blockedIdsFor ? { blockedIdsFor } : {}),
  })

  return {
    ...base,
    notifyMembers,
    forwardCityMention: makeContainerReportCityForward(container),
    ...(options.mentions
      ? { mentions: { ...options.mentions, notifyChatMention: makeChatMentionNotifier(bellDeps) } }
      : {}),
  }
}
