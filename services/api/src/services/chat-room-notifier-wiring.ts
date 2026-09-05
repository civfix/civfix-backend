
import type { FastifyBaseLogger } from "fastify"
import type { Container } from "../di.js"
import { makeReportChatRepository } from "./report-chat-repository.drizzle.js"
import { makeChatGroupRepository } from "./chat-group-repository.drizzle.js"
import { makeNotificationService } from "./notification-service.js"
import { makeDrizzleNotificationRepository } from "./notification-repository.drizzle.js"
import { makeConversationMutesRepository } from "./conversation-mutes-repository.drizzle.js"
import { RedisChatPresence } from "../adapters/chat-presence.js"
import { roomKeyFor } from "../ws/gateway.js"
import { REPORT_CHAT_FANOUT_MEMBER_CAP } from "./report-chat-notifier.js"
import {
  ROOM_FANOUT_THROTTLE_MS,
  type RoomFanoutKind,
  type RoomFanoutNotifierDeps,
} from "./chat-room-fanout-notifier.js"

export type RoomFanoutLogger = Pick<FastifyBaseLogger, "warn" | "error">

export const ROOM_FANOUT_WINDOW_CLAIM_PREFIX = "chatfanout"

export type ContainerRoomFanoutDeps = Record<RoomFanoutKind, RoomFanoutNotifierDeps>

export function makeContainerRoomFanoutDeps(
  container: Container,
  logger?: RoomFanoutLogger,
): ContainerRoomFanoutDeps {
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
    kind: RoomFanoutKind,
    roomId: string,
  ): Promise<boolean> => {
    try {
      return await conversationMutes.isMuted(userId, kind, roomId)
    } catch (err) {
      logger?.warn({ err, kind }, "room fan-out mute lookup failed; notifying anyway")
      return false
    }
  }
  const mutedUserIdsForRoom = (
    kind: RoomFanoutKind,
  ): ((roomId: string, userIds: string[]) => Promise<Set<string>>) | undefined => {
    const batch = conversationMutes.mutedUserIdsFor
    if (!batch) return undefined
    return (roomId, userIds) => batch.call(conversationMutes, kind, roomId, userIds)
  }

  const blocksRepo = container.getBlocksRepo()
  const isBlockedEitherWay = (a: string, b: string): Promise<boolean> =>
    blocksRepo.isBlockedEitherWay(a, b)
  const blockedIdsFor = (():
    | ((actorId: string, candidateIds: string[]) => Promise<Set<string>>)
    | undefined => {
    const batch = blocksRepo.blockedIdsAmong
    if (!batch) return undefined
    return (actorId, candidateIds) => batch.call(blocksRepo, actorId, candidateIds)
  })()

  const redisBacked = !container.env.USE_FAKE_CHAT && container.usesRealRedis === true
  const presence = redisBacked ? new RedisChatPresence(container.getRedis()) : undefined
  const claimWindow = redisBacked ? makeWindowClaim(container, logger) : undefined

  const common = (kind: RoomFanoutKind): Omit<RoomFanoutNotifierDeps, "listMemberIds"> => ({
    notificationService,
    isMuted: (userId, roomId) => isMuted(userId, kind, roomId),
    ...(mutedUserIdsForRoom(kind) ? { mutedUserIdsFor: mutedUserIdsForRoom(kind) } : {}),
    ...(presence !== undefined ? { presence } : {}),
    roomKey: (roomId) => roomKeyFor(kind, roomId),
    isBlockedEitherWay,
    ...(blockedIdsFor ? { blockedIdsFor } : {}),
    ...(claimWindow !== undefined
      ? { claimWindow: (roomId: string, windowMs: number) => claimWindow(kind, roomId, windowMs) }
      : {}),
    ...(logger !== undefined ? { logger } : {}),
  })

  return {
    report: {
      ...common("report"),
      listMemberIds: (reportId) =>
        reportChatRepo.listMemberIds(reportId, REPORT_CHAT_FANOUT_MEMBER_CAP),
    },
    group: {
      ...common("group"),
      listMemberIds: (groupId) => groupRepo.listMemberIds(groupId),
    },
  }
}

export function makeWindowClaim(
  container: Pick<Container, "getCounterStore">,
  logger?: RoomFanoutLogger,
): (kind: RoomFanoutKind, roomId: string, windowMs: number) => Promise<boolean> {
  return async (kind, roomId, windowMs) => {
    const ttlSeconds = Math.max(1, Math.ceil((windowMs || ROOM_FANOUT_THROTTLE_MS) / 1000))
    try {
      const hits = await container
        .getCounterStore()
        .incr(`${ROOM_FANOUT_WINDOW_CLAIM_PREFIX}:${kind}:${roomId}`, ttlSeconds)
      return hits <= 1
    } catch (err) {
      logger?.warn({ err, kind }, "room fan-out window claim failed; fanning out anyway")
      return true
    }
  }
}
