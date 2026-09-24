import { ErrorCode } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { makeWsTicketStore } from "../auth/ws-ticket.js"
import {
  InMemorySendDedupeStore,
  makeSendResilience,
  type LocalDeliver,
  type SendDedupeStore,
} from "../ws/send-resilience.js"
import { RedisSendDedupeStore } from "../adapters/chat-send-dedupe.redis.js"
import { makeRoomFanoutDispatcher } from "../services/chat-fanout-jobs.js"
import { makeWindowClaim } from "../services/chat-room-notifier-wiring.js"
import type { RoomFanoutNotifierDeps } from "../services/chat-room-fanout-notifier.js"
import { applyRateLimitHeaders, wsUpgradeRateLimitKey } from "../plugins/rate-limit.js"
import {
  registerChatGateway,
  roomKeyFor,
  type GatewayChatMentions,
  type GatewayDmDeps,
  type GatewayChatService,
  type GatewayReportChat,
  type IsBlockedEitherWayFn,
  type IsMemberFn,
  type OnChatReply,
  type OnGroupMessage,
  type OnReportMessage,
  type ThreadRecipientsOf,
} from "../ws/gateway.js"
import { resolveMentionTargets } from "../services/social-repository.drizzle.js"
import { makeChatMentionResolver } from "../services/chat-mention-resolver.js"
import { makeDrizzleCleanupRepository } from "../services/cleanup-repository.drizzle.js"
import { makeDrizzleDiscussionRepository } from "../services/discussion-repository.drizzle.js"
import {
  makeReportChatRepository,
  type ReportChatRepository,
} from "../services/report-chat-repository.drizzle.js"
import {
  canPostToGroup,
  makeChatGroupRepository,
  type ChatGroupRepository,
} from "../services/chat-group-repository.drizzle.js"
import type { GatewayGroupChat } from "../ws/types.js"
import { makeCityForwardThrottle } from "../services/report-city-forward.js"
import { makeContainerReportCityForward } from "../services/report-city-forward-wiring.js"
import { isReportVisibleTo } from "../services/report-visibility.js"
import { makeTokenBucketLimiter, type RateLimiter } from "../ws/report-rate-limit.js"
import type { ReportVisibleFn } from "../ws/gateway.js"
import { THREAD_SIGNAL_MEMBER_CAP } from "../services/cleanup-service.js"
import {
  makeDrizzleChatRepository,
  type ChatRepository,
} from "../services/chat-repository.drizzle.js"
import { makePrivateMediaPresigner } from "../services/media-presign.js"
import { recordChatMentions } from "../services/chat-mentions.drizzle.js"
import {
  makeDrizzleChatReadState,
  monotonicReadWatermarkUpdate,
} from "../services/chat-read-state.drizzle.js"
import {
  makeNotificationService,
  type NotificationService,
} from "../services/notification-service.js"
import { makeDrizzleNotificationRepository } from "../services/notification-repository.drizzle.js"
import {
  makeConversationMutesRepository,
  type ConversationMutesRepository,
} from "../services/conversation-mutes-repository.drizzle.js"
import { makeReportChatNotifier } from "../services/report-chat-notifier.js"
import { makeGroupChatNotifier } from "../services/group-chat-notifier.js"
import {
  makeChatMentionNotifier,
  makeChatReplyNotifier,
  makeDmBellNotifier,
  type ChatBellDeps,
} from "../services/chat-bells.js"
import {
  clearConversationBellFor,
  type ConversationBellKind,
} from "../services/conversation-bell.js"
import type { DmRepository } from "../services/dm-repository.drizzle.js"
import { makeDmPeerOf } from "../services/dm-peer.js"
import type { BlocksRepository } from "../services/blocks-repository.drizzle.js"
import {
  InMemoryChatPresence,
  RedisChatPresence,
  type ChatPresence,
} from "../adapters/chat-presence.js"
import { InMemoryChatReadState, type ChatReadState } from "../services/threads-service.js"
import { makeMarkRoomRead, type MarkRoomRead } from "../services/room-read-service.js"
import type { ChatGatewayOverrides } from "./chat.routes.js"

const WS_UPGRADE_ROUTE = "/ws"

const WS_UPGRADE_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const

const REPORT_SEND_LIMIT = { capacity: 30, refillPerSec: 0.5 } as const

export type ChatMentionSeam = Pick<
  GatewayChatMentions,
  "resolveChatMentions" | "recordChatMentions"
>

const mentionSeams = new WeakMap<FastifyInstance, ChatMentionSeam>()

export function chatMentionDeps(app: FastifyInstance, container: Container): ChatMentionSeam {
  const cached = mentionSeams.get(app)
  if (cached) return cached

  const overrides: ChatGatewayOverrides | undefined = app.chatOverrides
  const presignMedia = makePrivateMediaPresigner(container.storage)

  let cleanups: ReturnType<typeof makeDrizzleCleanupRepository> | undefined
  let reportChat: ReportChatRepository | undefined
  let groups: ChatGroupRepository | undefined

  const seam: ChatMentionSeam = {
    resolveChatMentions: makeChatMentionResolver({
      resolveTargets: (input) => resolveMentionTargets(container.getDb().sql, input),
      dmPeerOf: makeDmPeerOf({
        getThread: (threadId) => (overrides?.dmRepo ?? container.getDmRepo()).getThread(threadId),
      }),
      listCleanupMemberIds: (cleanupId, cap) =>
        (cleanups ??= makeDrizzleCleanupRepository(container.getDb().sql)).listMemberIds(
          cleanupId,
          cap,
        ),
      listReportChatMemberIds: (reportId) =>
        (
          overrides?.reportChat ??
          (reportChat ??= makeReportChatRepository(container.getDb().sql, presignMedia))
        ).listMemberIds(reportId),
      listGroupMemberIds: (groupId) => {
        const repo = overrides
          ? overrides.groups
          : (groups ??= makeChatGroupRepository(container.getDb().sql, presignMedia))
        return repo?.listMemberIds(groupId) ?? Promise.resolve([])
      },
    }),
    recordChatMentions: (messageId, mentionedUserIds) =>
      recordChatMentions(container.getDb().sql, messageId, mentionedUserIds),
  }
  mentionSeams.set(app, seam)
  return seam
}

export interface ConversationReadSeam {
  readState: ChatReadState
  markRoomRead: MarkRoomRead
}

const readSeams = new WeakMap<FastifyInstance, ConversationReadSeam>()

export function conversationReadSeam(
  app: FastifyInstance,
  container: Container,
): ConversationReadSeam {
  const cached = readSeams.get(app)
  if (cached) return cached

  const overrides: ChatGatewayOverrides | undefined = app.chatOverrides
  const useFakeChat = container.env.USE_FAKE_CHAT
  const presignMedia = makePrivateMediaPresigner(container.storage)

  const readState: ChatReadState =
    overrides?.readState ??
    (useFakeChat ? new InMemoryChatReadState() : makeDrizzleChatReadState(container.getDb().sql))
  const dmRepo: DmRepository = overrides?.dmRepo ?? container.getDmRepo()

  let reportChat: ReportChatRepository | undefined
  const getReportChat = (): ReportChatRepository | undefined =>
    overrides
      ? overrides.reportChat
      : useFakeChat
        ? undefined
        : (reportChat ??= makeReportChatRepository(container.getDb().sql, presignMedia))

  let groups: ChatGroupRepository | undefined
  const getGroups = (): ChatGroupRepository | undefined =>
    overrides
      ? overrides.groups
      : useFakeChat
        ? undefined
        : (groups ??= makeChatGroupRepository(container.getDb().sql, presignMedia))

  const notifications = (): NotificationService | undefined =>
    overrides?.notificationService ??
    (useFakeChat ? undefined : container.getNotificationService(app.log))

  const seam: ConversationReadSeam = {
    readState,
    markRoomRead: makeMarkRoomRead({
      cleanup: (id, userId, at) => readState.markRead(id, userId, at),
      dm: (id, userId, at) => dmRepo.markRead(id, userId, at),
      report: async (id, userId, at) => {
        await getReportChat()?.markRead(id, userId, at)
      },
      group: async (id, userId, at) => {
        await getGroups()?.markRead(id, userId, at)
      },
      clearBell: async (kind, id, userId) => {
        const service = notifications()
        if (!service) return
        try {
          await clearConversationBellFor(service, kind, id, userId)
        } catch (err) {
          app.log.warn(
            { err, kind, id, userId },
            "read: clear conversation notifications failed (suppressed)",
          )
        }
      },
    }),
  }
  readSeams.set(app, seam)
  return seam
}

export interface ChatWiring {
  readState: ChatReadState
  isMember: IsMemberFn
  dmRepo: DmRepository
  blocksRepo: BlocksRepository
  isBlockedEitherWay: IsBlockedEitherWayFn
  dmPeerOf: (threadId: string, userId: string) => Promise<string | null>
  getChatRepo(): ChatRepository
  getReportChatRepo(): ReportChatRepository
  listDmThreadsFor: DmRepository["listThreadsForUser"]
}

export function applyWsUpgradeRateLimit(app: FastifyInstance): void {
  if (typeof app.createRateLimit !== "function") return
  const limiter = app.createRateLimit({
    ...WS_UPGRADE_RATE_LIMIT,
    keyGenerator: wsUpgradeRateLimitKey,
  })
  app.addHook("onRequest", async (request, reply) => {
    // The router matches on the percent-decoded path, so only the matched pattern catches every
    // spelling of /ws that reaches the upgrade handler.
    if (request.routeOptions.url !== WS_UPGRADE_ROUTE) return
    const result = await limiter(request)
    if (!result.isAllowed && result.isExceeded) {
      applyRateLimitHeaders(reply, result)
      reply
        .status(429)
        .send({ code: ErrorCode.RATE_LIMITED, message: "Too many connection attempts." })
    }
  })
}

export function wireChatGateway(app: FastifyInstance, container: Container): ChatWiring {
  const overrides: ChatGatewayOverrides | undefined = app.chatOverrides
  const useFakeChat = container.env.USE_FAKE_CHAT

  const { readState, markRoomRead } = conversationReadSeam(app, container)

  const presence: ChatPresence =
    overrides?.presence ??
    (useFakeChat ? new InMemoryChatPresence() : new RedisChatPresence(container.getRedis()))

  let cleanupRepo: ReturnType<typeof makeDrizzleCleanupRepository> | undefined
  const getCleanupRepo = (): ReturnType<typeof makeDrizzleCleanupRepository> =>
    (cleanupRepo ??= makeDrizzleCleanupRepository(container.getDb().sql))
  const isMember: IsMemberFn = overrides
    ? overrides.isMember
    : (cleanupId, userId) => getCleanupRepo().isMember(cleanupId, userId)

  const blocksRepo: BlocksRepository = overrides?.blocksRepo ?? container.getBlocksRepo()
  const dmRepo: DmRepository = overrides?.dmRepo ?? container.getDmRepo()
  const isBlockedEitherWay: IsBlockedEitherWayFn = (a, b) => blocksRepo.isBlockedEitherWay(a, b)

  const blockedIdsForCandidates = (():
    | ((actorId: string, candidateIds: string[]) => Promise<Set<string>>)
    | undefined => {
    const repo = blocksRepo
    const batch = repo.blockedIdsAmong
    if (!batch) return undefined
    return (actorId, candidateIds) => batch.call(repo, actorId, candidateIds)
  })()

  const presignMedia = makePrivateMediaPresigner(container.storage)

  let chatRepo: ChatRepository | undefined
  const getChatRepo = (): ChatRepository =>
    overrides?.chatRepo ??
    (chatRepo ??= makeDrizzleChatRepository(container.getDb().sql, presignMedia))

  let reportChatRepo: ReportChatRepository | undefined
  const getReportChatRepo = (): ReportChatRepository =>
    overrides?.reportChat ??
    (reportChatRepo ??= makeReportChatRepository(container.getDb().sql, presignMedia))

  let lazyGroupsRepo: ChatGroupRepository | undefined
  const getGroupsRepo = (): ChatGroupRepository | undefined =>
    overrides
      ? overrides.groups
      : useFakeChat
        ? undefined
        : (lazyGroupsRepo ??= makeChatGroupRepository(container.getDb().sql, presignMedia))
  const groupWired = overrides ? overrides.groups !== undefined : !useFakeChat
  const groupChat: GatewayGroupChat | undefined = groupWired
    ? {
        isMember: async (groupId, userId) =>
          (await getGroupsRepo()!.roleOf(groupId, userId)) !== null,
        access: async (groupId, userId) => {
          const a = await getGroupsRepo()!.accessOf(groupId, userId)
          if (a === null) return null
          return { isMember: a.role !== null, canPost: canPostToGroup(a), visibility: a.visibility }
        },
        advanceReadWatermark: (groupId, userId, upToId) =>
          getGroupsRepo()!.advanceReadWatermark(groupId, userId, upToId),
      }
    : undefined

  const groupMembersInFlight = new Map<string, Promise<string[]>>()
  const listGroupMembersShared = (groupId: string): Promise<string[]> => {
    const repo = getGroupsRepo()
    if (!repo) return Promise.resolve([])
    const inFlight = groupMembersInFlight.get(groupId)
    if (inFlight) return inFlight
    const query = repo.listMemberIds(groupId)
    groupMembersInFlight.set(groupId, query)
    void query.catch(() => {}).then(() => groupMembersInFlight.delete(groupId))
    return query
  }

  const dmPeerOf = makeDmPeerOf(dmRepo)

  const notificationService: NotificationService | undefined =
    overrides?.notificationService ??
    (useFakeChat
      ? undefined
      : makeNotificationService({
          repo: makeDrizzleNotificationRepository(container.getDb().sql),
          pushSender: container.pushSender,
          userChannel: container.userChannel,
          logger: app.log,
        }))

  const conversationMutes: ConversationMutesRepository | undefined =
    overrides?.conversationMutes ??
    (useFakeChat ? undefined : makeConversationMutesRepository(container.getDb().sql))

  const isMutedFor = async (
    userId: string,
    kind: "dm" | "cleanup" | "report" | "group",
    roomId: string,
  ): Promise<boolean> => {
    if (!conversationMutes) return false
    try {
      return await conversationMutes.isMuted(userId, kind, roomId)
    } catch {
      return false
    }
  }

  const mutedUserIdsForRoom = (
    kind: "report" | "group",
  ): ((roomId: string, userIds: string[]) => Promise<Set<string>>) | undefined => {
    const repo = conversationMutes
    const batch = repo?.mutedUserIdsFor
    if (!repo || !batch) return undefined
    return (roomId, userIds) => batch.call(repo, kind, roomId, userIds)
  }
  const reportMutedUserIdsFor = mutedUserIdsForRoom("report")
  const groupMutedUserIdsFor = mutedUserIdsForRoom("group")

  const clearConversationBell = async (
    kind: ConversationBellKind,
    id: string,
    userId: string,
  ): Promise<void> => {
    if (!notificationService) return
    try {
      await clearConversationBellFor(notificationService, kind, id, userId)
    } catch (err) {
      app.log.warn(
        { err, kind, id, userId },
        "read: clear conversation notifications failed (suppressed)",
      )
    }
  }

  const dmGatewayDeps: GatewayDmDeps = {
    peerOf: dmPeerOf,
    persist: (input) => dmRepo.persist(input),
    markRead: async (threadId, userId, upToId) => {
      const at = (await dmRepo.resolveMessageCreatedAt(threadId, upToId)) ?? new Date()
      await dmRepo.markRead(threadId, userId, at)
      await clearConversationBell("dm", threadId, userId)
    },
  }

  const advanceCleanupWatermark: (
    cleanupId: string,
    userId: string,
    upToId: string,
  ) => Promise<void> = useFakeChat
    ? (cleanupId, userId) => readState.markRead(cleanupId, userId, new Date())
    : (cleanupId, userId, upToId) =>
        monotonicReadWatermarkUpdate(
          container.getDb().sql,
          "cleanup_members",
          { cleanup_id: cleanupId, user_id: userId },
          {
            messagesTable: "chat_messages",
            messageId: upToId,
            scopeColumn: "cleanup_id",
            scopeId: cleanupId,
          },
        )

  const threadRecipientsOf: ThreadRecipientsOf = async (kind, id, senderId) => {
    if (kind === "dm") {
      const peer = await dmPeerOf(id, senderId)
      return peer !== null ? [peer] : []
    }
    if (kind === "report") return []
    if (kind === "group") {
      const members = await listGroupMembersShared(id)
      return members.filter((m) => m !== senderId).slice(0, THREAD_SIGNAL_MEMBER_CAP)
    }
    if (useFakeChat) return []
    const members = await getCleanupRepo().listMemberIds(id, THREAD_SIGNAL_MEMBER_CAP)
    return members.filter((m) => m !== senderId)
  }

  const bellDeps: ChatBellDeps | undefined =
    useFakeChat || !notificationService
      ? undefined
      : {
          notificationService,
          isMutedFor,
          isCleanupMember: isMember,
          isReportChatMember: (reportId, userId) => getReportChatRepo().isMember(reportId, userId),
          isChatGroupMember: async (groupId, userId) =>
            ((await getGroupsRepo()?.roleOf(groupId, userId)) ?? null) !== null,
          isBlockedEitherWay,
          presence,
          roomKeyFor,
        }

  const chatMentions: GatewayChatMentions | undefined =
    overrides?.chatMentions ??
    (!bellDeps
      ? undefined
      : {
          ...chatMentionDeps(app, container),
          notifyChatMention: makeChatMentionNotifier(bellDeps),
        })

  const onChatReply: OnChatReply | undefined = bellDeps
    ? makeChatReplyNotifier(bellDeps)
    : undefined

  let reportRepo: ReturnType<typeof makeDrizzleDiscussionRepository> | undefined
  const getReportRepo = (): ReturnType<typeof makeDrizzleDiscussionRepository> =>
    (reportRepo ??= makeDrizzleDiscussionRepository(container.getDb().sql))

  const reportVisible: ReportVisibleFn | undefined =
    overrides?.reportVisible ??
    (useFakeChat
      ? undefined
      : async (reportId, userId) =>
          isReportVisibleTo(await getReportRepo().findReportForDiscussion(reportId), userId))

  const reportSendLimiter: RateLimiter = makeTokenBucketLimiter(REPORT_SEND_LIMIT)

  const fanoutMode = roomFanoutMode({
    useFakeChat,
    useFakeJobs: container.env.USE_FAKE_JOBS,
    usesRealRedis: container.usesRealRedis === true,
  })
  const roomFanoutClaim = makeWindowClaim(container, app.log)
  const roomFanoutHandoff = (
    kind: "report" | "group",
  ): Pick<RoomFanoutNotifierDeps, "dispatchToJob" | "claimWindow"> => ({
    ...(fanoutMode.queued ? { dispatchToJob: makeRoomFanoutDispatcher(container.jobs, kind) } : {}),
    ...(fanoutMode.claimed
      ? {
          claimWindow: (roomId: string, windowMs: number) =>
            roomFanoutClaim(kind, roomId, windowMs),
        }
      : {}),
  })

  let dedupeStore: SendDedupeStore | undefined
  const resolveDedupeStore = (): SendDedupeStore =>
    (dedupeStore ??= useFakeChat
      ? new InMemorySendDedupeStore()
      : new RedisSendDedupeStore(container.getRedis()))
  const sendDedupe: SendDedupeStore = {
    reserve: (key) => resolveDedupeStore().reserve(key),
    commit: (key, messageId) => resolveDedupeStore().commit(key, messageId),
    release: (key) => resolveDedupeStore().release(key),
  }

  const baseChat = container.chatService as GatewayChatService & {
    deliverLocal?: LocalDeliver
  }
  const sendResilience = makeSendResilience({
    dedupe: sendDedupe,
    findRoomMessage: (kind, roomId, messageId, viewerUserId) => {
      if (kind === "dm") return dmRepo.findMessage(roomId, messageId, viewerUserId)
      if (kind === "report") return getChatRepo().findReportMessage(roomId, messageId, viewerUserId)
      if (kind === "group") return getChatRepo().findGroupMessage(roomId, messageId, viewerUserId)
      return getChatRepo().findMessage(roomId, messageId, viewerUserId)
    },
    deliverLocally: (roomKey, frame, excludeConnId) =>
      baseChat.deliverLocal?.(roomKey, frame, excludeConnId) ?? 0,
    onBroadcastFailure: (info) =>
      app.log.error({ ...info, component: "chat-broadcast" }, "chat: room broadcast not published"),
    logger: app.log,
  })
  const chatWithResilience: GatewayChatService = {
    joinRoom: (room, conn, userId) => baseChat.joinRoom(room, conn, userId),
    leaveRoom: (room, conn) => baseChat.leaveRoom(room, conn),
    persist: (input) => baseChat.persist(input),
    history: (room, before, limit, viewerUserId, around) =>
      baseChat.history(room, before, limit, viewerUserId, around),
    broadcast: (room, msg, opts) => baseChat.broadcast(room, msg, opts),
    ...(baseChat.broadcastEvent
      ? {
          broadcastEvent: (room, frame, opts) => baseChat.broadcastEvent!(room, frame, opts),
        }
      : {}),
    sendResilience,
  }

  const canForwardCity = makeCityForwardThrottle({
    incr: (key, ttlSeconds) => container.getCounterStore().incr(key, ttlSeconds),
    incrBy: (key, by, ttlSeconds) => container.getCounterStore().incrBy(key, by, ttlSeconds),
  })

  const notifyReportChatMembers =
    notificationService && conversationMutes
      ? makeReportChatNotifier({
          notificationService,
          reportChatRepo: {
            listMemberIds: (reportId) => getReportChatRepo().listMemberIds(reportId),
          },
          isMuted: (userId, roomId) => isMutedFor(userId, "report", roomId),
          ...(reportMutedUserIdsFor ? { mutedUserIdsFor: reportMutedUserIdsFor } : {}),
          presence,
          roomKeyFor,
          isBlockedEitherWay,
          ...(blockedIdsForCandidates ? { blockedIdsFor: blockedIdsForCandidates } : {}),
          ...roomFanoutHandoff("report"),
        })
      : undefined

  const notifyGroupChatMembers =
    notificationService && conversationMutes && groupWired
      ? makeGroupChatNotifier({
          notificationService,
          groupRepo: { listMemberIds: listGroupMembersShared },
          isMuted: (userId, roomId) => isMutedFor(userId, "group", roomId),
          ...(groupMutedUserIdsFor ? { mutedUserIdsFor: groupMutedUserIdsFor } : {}),
          presence,
          roomKeyFor,
          isBlockedEitherWay,
          ...(blockedIdsForCandidates ? { blockedIdsFor: blockedIdsForCandidates } : {}),
          ...roomFanoutHandoff("group"),
        })
      : undefined
  const onGroupMessage: OnGroupMessage | undefined = notifyGroupChatMembers
    ? async (groupId, message) => {
        void notifyGroupChatMembers(groupId, message).catch(() => {})
      }
    : undefined

  const forwardCityMention = makeContainerReportCityForward(container, {
    getReportRepo,
    canForward: canForwardCity,
  })
  const onReportMessage: OnReportMessage | undefined = useFakeChat
    ? undefined
    : async (reportId, message, actorUserId) => {
        if (notifyReportChatMembers) void notifyReportChatMembers(reportId, message).catch(() => {})
        await forwardCityMention(reportId, message, actorUserId)
      }

  applyWsUpgradeRateLimit(app)

  const reportChatSource = overrides
    ? overrides.reportChat
    : useFakeChat
      ? undefined
      : getReportChatRepo()
  const reportChat: GatewayReportChat | undefined = reportChatSource
    ? makeGatewayReportChat(reportChatSource, (reportId, userId) =>
        clearConversationBell("report", reportId, userId),
      )
    : undefined

  const wsTicketCache = app.authServices?.cache
  registerChatGateway(app, {
    chat: chatWithResilience,
    isMember,
    sessions: app.authServices?.sessions,
    ...(wsTicketCache
      ? { redeemTicket: (ticket: string) => makeWsTicketStore(wsTicketCache).redeem(ticket) }
      : {}),
    markRead: async (cleanupId, userId, upToId) => {
      await advanceCleanupWatermark(cleanupId, userId, upToId)
      await clearConversationBell("cleanup", cleanupId, userId)
    },
    presence,
    dm: dmGatewayDeps,
    isBlockedEitherWay,
    userChannel: container.userChannel,
    threadRecipientsOf,
    onDmDelivered: notificationService
      ? makeDmBellNotifier({ notificationService, isMutedFor })
      : undefined,
    markReadOnOpen: markRoomRead,
    chatMentions,
    onReportMessage,
    onGroupMessage,
    onChatReply,
    reportVisible,
    reportSendLimiter,
    reportChat,
    groupChat,
    webOrigins: container.env.WEB_ORIGINS,
  })

  return {
    readState,
    isMember,
    dmRepo,
    blocksRepo,
    isBlockedEitherWay,
    dmPeerOf,
    getChatRepo,
    getReportChatRepo,
    listDmThreadsFor: (userId, limit, cursor) => dmRepo.listThreadsForUser(userId, limit, cursor),
  }
}

export interface RoomFanoutMode {
  queued: boolean
  claimed: boolean
}

export function roomFanoutMode(input: {
  useFakeChat: boolean
  useFakeJobs: boolean
  usesRealRedis: boolean
}): RoomFanoutMode {
  const claimed = !input.useFakeChat && input.usesRealRedis
  return { claimed, queued: claimed && !input.useFakeJobs }
}

export function makeGatewayReportChat(
  source: GatewayReportChat,
  clearBell: (reportId: string, userId: string) => Promise<void>,
): GatewayReportChat {
  return {
    isMember: (reportId, userId) => source.isMember(reportId, userId),
    advanceReadWatermark: async (reportId, userId, upToId) => {
      await source.advanceReadWatermark(reportId, userId, upToId)
      await clearBell(reportId, userId)
    },
  }
}
