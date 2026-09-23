import { ErrorCode } from "@civfix/shared"
import type { FastifyBaseLogger, FastifyInstance } from "fastify"
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
  type ReportVisibleFn,
  type ThreadRecipientsOf,
} from "../ws/gateway.js"
import { resolveMentionTargets } from "../services/mention-targets-repository.drizzle.js"
import { makeChatMentionResolver } from "../services/chat-mention-resolver.js"
import { makeDrizzleCleanupRepository } from "../services/cleanup-repository.drizzle.js"
import { makeDrizzleDiscussionRepository } from "../services/discussion-repository.drizzle.js"
import {
  makeReportChatRepository,
  type ReportChatRepository,
} from "../services/report-chat-repository.drizzle.js"
import {
  canPostToGroup,
  GROUP_MEMBER_SCAN_CAP,
  makeChatGroupRepository,
  type ChatGroupRepository,
} from "../services/chat-group-repository.drizzle.js"
import { WS_ROUTE, WS_SEND_LIMITS, type GatewayGroupChat } from "../ws/types.js"
import { makeCityForwardThrottle } from "../services/report-city-forward.js"
import { makeContainerReportCityForward } from "../services/report-city-forward-wiring.js"
import { isReportVisibleTo } from "../services/report-visibility.js"
import { makeTokenBucketLimiter, type RateLimiter } from "../ws/report-rate-limit.js"
import { THREAD_SIGNAL_MEMBER_CAP } from "../services/cleanup-service.js"
import {
  makeDrizzleChatRepository,
  type ChatRepository,
} from "../services/chat-repository.drizzle.js"
import { makePrivateMediaPresigner } from "../services/media-presign.js"
import {
  recordChatMentions,
  roomMemberIdsAmong,
} from "../services/chat-mentions-repository.drizzle.js"
import {
  makeDrizzleChatReadState,
  monotonicReadWatermarkUpdate,
} from "../services/read-watermark-repository.drizzle.js"
import type { NotificationService } from "../services/notification-service.js"
import { makeRouteNotificationService } from "../services/route-notifier.js"
import {
  bindMutedUserIdsFor,
  makeConversationMutesRepository,
  makeFailOpenMuteCheck,
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
import {
  bindBlockedIdsAmong,
  type BlocksRepository,
} from "../services/blocks-repository.drizzle.js"
import {
  InMemoryChatPresence,
  RedisChatPresence,
  type ChatPresence,
} from "../adapters/chat-presence.js"
import { InMemoryChatReadState, type ChatReadState } from "../services/threads-service.js"
import { makeMarkRoomRead, type MarkRoomRead } from "../services/room-read-service.js"
import type { ChatGatewayOverrides } from "./chat.routes.js"

const WS_UPGRADE_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const

const CLEANUP_MEMBERS_TABLE = "cleanup_members"

const CHAT_MESSAGES_TABLE = "chat_messages"

type FanoutRoomKind = "report" | "group"

type CleanupRepository = ReturnType<typeof makeDrizzleCleanupRepository>

type DiscussionRepository = ReturnType<typeof makeDrizzleDiscussionRepository>

type BatchIdLookup = (ownerId: string, candidateIds: string[]) => Promise<Set<string>>

type ClearBell = (kind: ConversationBellKind, id: string, userId: string) => Promise<void>

export type ChatMentionSeam = Pick<
  GatewayChatMentions,
  "resolveChatMentions" | "recordChatMentions" | "logger"
>

const mentionSeams = new WeakMap<FastifyInstance, ChatMentionSeam>()

export function chatMentionDeps(app: FastifyInstance, container: Container): ChatMentionSeam {
  const cached = mentionSeams.get(app)
  if (cached) return cached

  const overrides: ChatGatewayOverrides | undefined = app.chatOverrides

  const seam: ChatMentionSeam = {
    resolveChatMentions: makeChatMentionResolver({
      resolveTargets: (input) => resolveMentionTargets(container.getDb().sql, input),
      dmPeerOf: makeDmPeerOf({
        getThread: (threadId) => (overrides?.dmRepo ?? container.getDmRepo()).getThread(threadId),
      }),
      listCleanupMemberIds: (cleanupId, candidateIds) =>
        roomMemberIdsAmong(container.getDb().sql, "cleanup", cleanupId, candidateIds),
      listReportChatMemberIds: (reportId, candidateIds) =>
        roomMemberIdsAmong(container.getDb().sql, "report", reportId, candidateIds),
      listGroupMemberIds: (groupId, candidateIds) =>
        roomMemberIdsAmong(container.getDb().sql, "group", groupId, candidateIds),
    }),
    recordChatMentions: (messageId, mentionedUserIds) =>
      recordChatMentions(container.getDb().sql, messageId, mentionedUserIds),
    logger: app.log,
  }
  mentionSeams.set(app, seam)
  return seam
}

// A bell that fails to clear leaves a stale badge, never a failed read, so the error is logged only.
function makeClearBell(
  getService: () => NotificationService | undefined,
  log: Pick<FastifyBaseLogger, "warn">,
): ClearBell {
  return async (kind, id, userId) => {
    const service = getService()
    if (!service) return
    try {
      await clearConversationBellFor(service, kind, id, userId)
    } catch (err) {
      log.warn(
        { err, kind, id, userId },
        "read: clear conversation notifications failed (suppressed)",
      )
    }
  }
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
        : (reportChat ??= makeReportChatRepository(container.getDb().sql))

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
      clearBell: makeClearBell(notifications, app.log),
    }),
  }
  readSeams.set(app, seam)
  return seam
}

export interface ChatWiring {
  readState: ChatReadState
  isMember: IsMemberFn
  dmRepo: DmRepository
  isBlockedEitherWay: IsBlockedEitherWayFn
  dmPeerOf: (threadId: string, userId: string) => Promise<string | null>
  getChatRepo(): ChatRepository
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
    if (request.routeOptions.url !== WS_ROUTE) return
    const result = await limiter(request)
    if (!result.isAllowed && result.isExceeded) {
      applyRateLimitHeaders(reply, result)
      reply
        .status(429)
        .send({ code: ErrorCode.RATE_LIMITED, message: "Too many connection attempts." })
    }
  })
}

interface WiringContext {
  app: FastifyInstance
  container: Container
  overrides: ChatGatewayOverrides | undefined
  useFakeChat: boolean
}

function buildPresence({ container, overrides, useFakeChat }: WiringContext): ChatPresence {
  return (
    overrides?.presence ??
    (useFakeChat ? new InMemoryChatPresence() : new RedisChatPresence(container.getRedis()))
  )
}

interface ChatRepos {
  getCleanupRepo(): CleanupRepository
  isMember: IsMemberFn
  blocksRepo: BlocksRepository
  dmRepo: DmRepository
  isBlockedEitherWay: IsBlockedEitherWayFn
  blockedIdsFor: BatchIdLookup | undefined
  getChatRepo(): ChatRepository
  getReportChatRepo(): ReportChatRepository
  getGroupsRepo(): ChatGroupRepository | undefined
  groupWired: boolean
  getReportRepo(): DiscussionRepository
}

function buildChatRepos({ container, overrides, useFakeChat }: WiringContext): ChatRepos {
  let cleanupRepo: CleanupRepository | undefined
  const getCleanupRepo = (): CleanupRepository =>
    (cleanupRepo ??= makeDrizzleCleanupRepository(container.getDb().sql))
  const isMember: IsMemberFn = overrides
    ? overrides.isMember
    : (cleanupId, userId) => getCleanupRepo().isMember(cleanupId, userId)

  const blocksRepo: BlocksRepository = overrides?.blocksRepo ?? container.getBlocksRepo()
  const dmRepo: DmRepository = overrides?.dmRepo ?? container.getDmRepo()
  const blockedIdsFor: BatchIdLookup | undefined = bindBlockedIdsAmong(blocksRepo)

  const presignMedia = makePrivateMediaPresigner(container.storage)

  let chatRepo: ChatRepository | undefined
  let reportChatRepo: ReportChatRepository | undefined
  let groupsRepo: ChatGroupRepository | undefined
  let reportRepo: DiscussionRepository | undefined

  return {
    getCleanupRepo,
    isMember,
    blocksRepo,
    dmRepo,
    isBlockedEitherWay: (a, b) => blocksRepo.isBlockedEitherWay(a, b),
    blockedIdsFor,
    getChatRepo: () =>
      overrides?.chatRepo ??
      (chatRepo ??= makeDrizzleChatRepository(container.getDb().sql, presignMedia)),
    getReportChatRepo: () =>
      overrides?.reportChat ?? (reportChatRepo ??= makeReportChatRepository(container.getDb().sql)),
    getGroupsRepo: () =>
      overrides
        ? overrides.groups
        : useFakeChat
          ? undefined
          : (groupsRepo ??= makeChatGroupRepository(container.getDb().sql, presignMedia)),
    groupWired: overrides ? overrides.groups !== undefined : !useFakeChat,
    getReportRepo: () => (reportRepo ??= makeDrizzleDiscussionRepository(container.getDb().sql)),
  }
}

function buildGroupChat(repos: ChatRepos): GatewayGroupChat | undefined {
  if (!repos.groupWired) return undefined
  const groups = (): ChatGroupRepository => repos.getGroupsRepo()!
  return {
    isMember: async (groupId, userId) => (await groups().roleOf(groupId, userId)) !== null,
    access: async (groupId, userId) => {
      const a = await groups().accessOf(groupId, userId)
      if (a === null) return null
      return { isMember: a.role !== null, canPost: canPostToGroup(a), visibility: a.visibility }
    },
    advanceReadWatermark: (groupId, userId, upToId) =>
      groups().advanceReadWatermark(groupId, userId, upToId),
  }
}

// One map per wiring: it dedupes concurrent member scans between the thread signal and the group
// fan-out for the same message.
function makeSharedGroupMemberList(
  getGroupsRepo: () => ChatGroupRepository | undefined,
): (groupId: string, limit?: number) => Promise<string[]> {
  const inFlightByKey = new Map<string, Promise<string[]>>()
  return (groupId, limit = GROUP_MEMBER_SCAN_CAP) => {
    const repo = getGroupsRepo()
    if (!repo) return Promise.resolve([])
    const key = `${groupId}:${limit}`
    const inFlight = inFlightByKey.get(key)
    if (inFlight) return inFlight
    const query = repo.listMemberIds(groupId, limit)
    inFlightByKey.set(key, query)
    // Only evicts the shared entry; each caller awaits `query` itself and sees the rejection.
    void query.catch(() => {}).then(() => inFlightByKey.delete(key))
    return query
  }
}

interface ChatNotifications {
  notificationService: NotificationService | undefined
  conversationMutes: ConversationMutesRepository | undefined
  isMutedFor: ReturnType<typeof makeFailOpenMuteCheck>
  mutedUserIdsFor: Record<
    FanoutRoomKind,
    ((roomId: string, userIds: string[]) => Promise<Set<string>>) | undefined
  >
}

function buildChatNotifications({
  app,
  container,
  overrides,
  useFakeChat,
}: WiringContext): ChatNotifications {
  const notificationService: NotificationService | undefined =
    overrides?.notificationService ??
    (useFakeChat ? undefined : makeRouteNotificationService(container, app.log))

  const conversationMutes: ConversationMutesRepository | undefined =
    overrides?.conversationMutes ??
    (useFakeChat ? undefined : makeConversationMutesRepository(container.getDb().sql))

  const isMutedFor = makeFailOpenMuteCheck(conversationMutes, app.log)

  return {
    notificationService,
    conversationMutes,
    isMutedFor,
    mutedUserIdsFor: {
      report: bindMutedUserIdsFor(conversationMutes, "report"),
      group: bindMutedUserIdsFor(conversationMutes, "group"),
    },
  }
}

function makeCleanupWatermark(
  { container, useFakeChat }: WiringContext,
  readState: ChatReadState,
): (cleanupId: string, userId: string, upToId: string) => Promise<void> {
  if (useFakeChat) return (cleanupId, userId) => readState.markRead(cleanupId, userId, new Date())
  return (cleanupId, userId, upToId) =>
    monotonicReadWatermarkUpdate(
      container.getDb().sql,
      CLEANUP_MEMBERS_TABLE,
      { cleanup_id: cleanupId, user_id: userId },
      {
        messagesTable: CHAT_MESSAGES_TABLE,
        messageId: upToId,
        scopeColumn: "cleanup_id",
        scopeId: cleanupId,
      },
    )
}

function makeThreadRecipientsOf(
  { useFakeChat }: WiringContext,
  repos: ChatRepos,
  dmPeerOf: (threadId: string, userId: string) => Promise<string | null>,
  listGroupMembers: (groupId: string) => Promise<string[]>,
): ThreadRecipientsOf {
  return async (kind, id, senderId) => {
    if (kind === "dm") {
      const peer = await dmPeerOf(id, senderId)
      return peer !== null ? [peer] : []
    }
    if (kind === "report") return []
    if (kind === "group") {
      const members = await listGroupMembers(id)
      return members.filter((m) => m !== senderId).slice(0, THREAD_SIGNAL_MEMBER_CAP)
    }
    if (useFakeChat) return []
    const members = await repos.getCleanupRepo().listMemberIds(id, THREAD_SIGNAL_MEMBER_CAP)
    return members.filter((m) => m !== senderId)
  }
}

function buildBellDeps(
  { useFakeChat }: WiringContext,
  repos: ChatRepos,
  notifications: ChatNotifications,
  presence: ChatPresence,
): ChatBellDeps | undefined {
  const { notificationService, isMutedFor } = notifications
  if (useFakeChat || !notificationService) return undefined
  return {
    notificationService,
    isMutedFor,
    isCleanupMember: repos.isMember,
    isReportChatMember: (reportId, userId) => repos.getReportChatRepo().isMember(reportId, userId),
    isChatGroupMember: async (groupId, userId) =>
      ((await repos.getGroupsRepo()?.roleOf(groupId, userId)) ?? null) !== null,
    isBlockedEitherWay: repos.isBlockedEitherWay,
    presence,
    roomKeyFor,
  }
}

function makeReportVisible(
  { overrides, useFakeChat }: WiringContext,
  repos: ChatRepos,
): ReportVisibleFn | undefined {
  if (overrides?.reportVisible) return overrides.reportVisible
  if (useFakeChat) return undefined
  return async (reportId, userId) =>
    isReportVisibleTo(await repos.getReportRepo().findReportForDiscussion(reportId), userId)
}

function makeRoomFanoutHandoff({
  app,
  container,
  useFakeChat,
}: WiringContext): (
  kind: FanoutRoomKind,
) => Pick<RoomFanoutNotifierDeps, "dispatchToJob" | "claimWindow"> {
  const fanoutMode = roomFanoutMode({
    useFakeChat,
    useFakeJobs: container.env.USE_FAKE_JOBS,
    usesRealRedis: container.usesRealRedis === true,
  })
  const roomFanoutClaim = makeWindowClaim(container, app.log)
  return (kind) => ({
    ...(fanoutMode.queued ? { dispatchToJob: makeRoomFanoutDispatcher(container.jobs, kind) } : {}),
    ...(fanoutMode.claimed
      ? {
          claimWindow: (roomId: string, windowMs: number) =>
            roomFanoutClaim(kind, roomId, windowMs),
        }
      : {}),
  })
}

function makeLazySendDedupe({ container, useFakeChat }: WiringContext): SendDedupeStore {
  let dedupeStore: SendDedupeStore | undefined
  const resolveDedupeStore = (): SendDedupeStore =>
    (dedupeStore ??= useFakeChat
      ? new InMemorySendDedupeStore()
      : new RedisSendDedupeStore(container.getRedis()))
  return {
    reserve: (key) => resolveDedupeStore().reserve(key),
    commit: (key, messageId) => resolveDedupeStore().commit(key, messageId),
    release: (key) => resolveDedupeStore().release(key),
  }
}

function withSendResilience(
  { app, container }: WiringContext,
  repos: ChatRepos,
  dedupe: SendDedupeStore,
): GatewayChatService {
  const baseChat = container.chatService as GatewayChatService & {
    deliverLocal?: LocalDeliver
  }
  const { dmRepo, getChatRepo } = repos
  const sendResilience = makeSendResilience({
    dedupe,
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
  return {
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
}

function makeContainerCityForwardThrottle({
  app,
  container,
}: WiringContext): ReturnType<typeof makeCityForwardThrottle> {
  return makeCityForwardThrottle(
    {
      incr: (key, ttlSeconds) => container.getCounterStore().incr(key, ttlSeconds),
      incrBy: (key, by, ttlSeconds) => container.getCounterStore().incrBy(key, by, ttlSeconds),
      decrBy: (key, by) => container.getCounterStore().decrBy(key, by),
    },
    app.log,
  )
}

interface RoomMemberNotifiers {
  notifyReportChatMembers: ReturnType<typeof makeReportChatNotifier> | undefined
  onGroupMessage: OnGroupMessage | undefined
}

function buildRoomMemberNotifiers(
  { app }: WiringContext,
  repos: ChatRepos,
  notifications: ChatNotifications,
  presence: ChatPresence,
  listGroupMembers: (groupId: string, limit?: number) => Promise<string[]>,
  fanoutHandoff: ReturnType<typeof makeRoomFanoutHandoff>,
): RoomMemberNotifiers {
  const { notificationService, conversationMutes, mutedUserIdsFor } = notifications
  const { blockedIdsFor, isBlockedEitherWay } = repos

  const notifyReportChatMembers =
    notificationService && conversationMutes
      ? makeReportChatNotifier({
          notificationService,
          reportChatRepo: {
            listMemberIds: (reportId, limit) =>
              repos.getReportChatRepo().listMemberIds(reportId, limit),
          },
          isMuted: (userId, roomId) => conversationMutes.isMuted(userId, "report", roomId),
          ...(mutedUserIdsFor.report ? { mutedUserIdsFor: mutedUserIdsFor.report } : {}),
          presence,
          roomKeyFor,
          isBlockedEitherWay,
          ...(blockedIdsFor ? { blockedIdsFor } : {}),
          ...fanoutHandoff("report"),
          logger: app.log,
        })
      : undefined

  const notifyGroupChatMembers =
    notificationService && conversationMutes && repos.groupWired
      ? makeGroupChatNotifier({
          notificationService,
          groupRepo: {
            listMemberIds: (groupId, limit) => listGroupMembers(groupId, limit),
          },
          isMuted: (userId, roomId) => conversationMutes.isMuted(userId, "group", roomId),
          ...(mutedUserIdsFor.group ? { mutedUserIdsFor: mutedUserIdsFor.group } : {}),
          presence,
          roomKeyFor,
          isBlockedEitherWay,
          ...(blockedIdsFor ? { blockedIdsFor } : {}),
          ...fanoutHandoff("group"),
          logger: app.log,
        })
      : undefined

  return {
    notifyReportChatMembers,
    onGroupMessage: notifyGroupChatMembers
      ? async (groupId, message) => {
          void notifyGroupChatMembers(groupId, message).catch(() => {})
        }
      : undefined,
  }
}

function makeOnReportMessage(
  ctx: WiringContext,
  repos: ChatRepos,
  notifyReportChatMembers: RoomMemberNotifiers["notifyReportChatMembers"],
): OnReportMessage | undefined {
  const forwardCityMention = makeContainerReportCityForward(ctx.container, {
    getReportRepo: repos.getReportRepo,
    canForward: makeContainerCityForwardThrottle(ctx),
    logger: ctx.app.log,
  })
  if (ctx.useFakeChat) return undefined
  return async (reportId, message, actorUserId) => {
    if (notifyReportChatMembers) void notifyReportChatMembers(reportId, message).catch(() => {})
    await forwardCityMention(reportId, message, actorUserId)
  }
}

function buildGatewayReportChat(
  { overrides, useFakeChat }: WiringContext,
  repos: ChatRepos,
  clearBell: ClearBell,
): GatewayReportChat | undefined {
  const source = overrides
    ? overrides.reportChat
    : useFakeChat
      ? undefined
      : repos.getReportChatRepo()
  if (!source) return undefined
  return makeGatewayReportChat(source, (reportId, userId) => clearBell("report", reportId, userId))
}

export function wireChatGateway(app: FastifyInstance, container: Container): ChatWiring {
  const ctx: WiringContext = {
    app,
    container,
    overrides: app.chatOverrides,
    useFakeChat: container.env.USE_FAKE_CHAT,
  }

  const { readState, markRoomRead } = conversationReadSeam(app, container)
  const presence = buildPresence(ctx)
  const repos = buildChatRepos(ctx)
  const { isMember, dmRepo, isBlockedEitherWay } = repos
  const groupChat = buildGroupChat(repos)
  const listGroupMembers = makeSharedGroupMemberList(repos.getGroupsRepo)
  const dmPeerOf = makeDmPeerOf(dmRepo)

  const notifications = buildChatNotifications(ctx)
  const { notificationService, isMutedFor } = notifications
  const clearBell = makeClearBell(() => notificationService, app.log)

  const dmGatewayDeps: GatewayDmDeps = {
    peerOf: dmPeerOf,
    persist: (input) => dmRepo.persist(input),
    markRead: makeDmAckMarkRead(dmRepo, (threadId, userId) => clearBell("dm", threadId, userId)),
  }
  const advanceCleanupWatermark = makeCleanupWatermark(ctx, readState)
  const threadRecipientsOf = makeThreadRecipientsOf(ctx, repos, dmPeerOf, listGroupMembers)

  const bellDeps = buildBellDeps(ctx, repos, notifications, presence)
  const chatMentions: GatewayChatMentions | undefined =
    ctx.overrides?.chatMentions ??
    (bellDeps
      ? { ...chatMentionDeps(app, container), notifyChatMention: makeChatMentionNotifier(bellDeps) }
      : undefined)
  const onChatReply: OnChatReply | undefined = bellDeps
    ? makeChatReplyNotifier(bellDeps)
    : undefined

  const reportVisible = makeReportVisible(ctx, repos)
  const reportSendLimiter: RateLimiter = makeTokenBucketLimiter(WS_SEND_LIMITS.report)
  const fanoutHandoff = makeRoomFanoutHandoff(ctx)
  const chatWithResilience = withSendResilience(ctx, repos, makeLazySendDedupe(ctx))

  const { notifyReportChatMembers, onGroupMessage } = buildRoomMemberNotifiers(
    ctx,
    repos,
    notifications,
    presence,
    listGroupMembers,
    fanoutHandoff,
  )
  const onReportMessage = makeOnReportMessage(ctx, repos, notifyReportChatMembers)

  applyWsUpgradeRateLimit(app)

  const reportChat = buildGatewayReportChat(ctx, repos, clearBell)

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
      await clearBell("cleanup", cleanupId, userId)
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
    isBlockedEitherWay,
    dmPeerOf,
    getChatRepo: repos.getChatRepo,
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

export function makeDmAckMarkRead(
  dmRepo: Pick<DmRepository, "resolveMessageCreatedAt" | "markRead">,
  clearBell: (threadId: string, userId: string) => Promise<void>,
): GatewayDmDeps["markRead"] {
  return async (threadId, userId, upToId) => {
    const at = await dmRepo.resolveMessageCreatedAt(threadId, upToId)
    // Like the other room kinds, an ack names a message; one this thread cannot resolve advances nothing.
    if (at !== null) await dmRepo.markRead(threadId, userId, at)
    await clearBell(threadId, userId)
  }
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
