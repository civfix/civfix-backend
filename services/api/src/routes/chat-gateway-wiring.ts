
import { ErrorCode } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { makeWsTicketStore } from "../auth/ws-ticket.js"
import { normalizeIp } from "../abuse/ip-rate-limit.js"
import {
  registerChatGateway,
  roomKeyFor,
  type GatewayChatMentions,
  type GatewayDmDeps,
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
import { makeReportChatRepository, type ReportChatRepository } from "../services/report-chat-repository.drizzle.js"
import {
  makeChatGroupRepository,
  type ChatGroupRepository,
} from "../services/chat-group-repository.drizzle.js"
import type { GatewayGroupChat } from "../ws/types.js"
import { makeOutboundMailService } from "../services/admin/outbound-mail-service.js"
import { makeDrizzleMailRepository } from "../services/admin/mail-repository.drizzle.js"
import { forwardReportCityMention } from "../services/report-city-forward.js"
import { makeReportForwardAudit, type ReportForwardAudit } from "../services/report-forward-audit.drizzle.js"
import { isReportVisibleTo } from "../services/report-visibility.js"
import { makeTokenBucketLimiter, type RateLimiter } from "../ws/report-rate-limit.js"
import type { ReportVisibleFn } from "../ws/gateway.js"
import { THREAD_SIGNAL_MEMBER_CAP } from "../services/cleanup-service.js"
import { makeDrizzleChatRepository, type ChatRepository } from "../services/chat-repository.drizzle.js"
import { makeMediaPresigner } from "../services/media-presign.js"
import { recordChatMentions } from "../services/chat-mentions.drizzle.js"
import { makeDrizzleChatReadState } from "../services/chat-read-state.drizzle.js"
import { makeNotificationService, type NotificationService } from "../services/notification-service.js"
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
import type { DmRepository } from "../services/dm-repository.drizzle.js"
import type { BlocksRepository } from "../services/blocks-repository.drizzle.js"
import { InMemoryChatPresence, RedisChatPresence, type ChatPresence } from "../adapters/chat-presence.js"
import { InMemoryChatReadState, type ChatReadState } from "../services/threads-service.js"
import type { ChatGatewayOverrides } from "./chat.routes.js"

const WS_UPGRADE_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const

const REPORT_SEND_LIMIT = { capacity: 30, refillPerSec: 0.5 } as const

const CITY_FORWARD_DEDUP_MS = 10 * 60 * 1000
const CITY_FORWARD_DEDUP_MAX_KEYS = 5000

export interface ChatWiring {
  readState: ChatReadState
  isMember: IsMemberFn
  dmRepo: DmRepository
  blocksRepo: BlocksRepository
  isBlockedEitherWay: IsBlockedEitherWayFn
  dmPeerOf: (threadId: string, userId: string) => Promise<string | null>
  getChatRepo(): ChatRepository
  getReportChatRepo(): ReportChatRepository
  listDmThreadsFor: (userId: string, limit?: number) => Promise<Awaited<ReturnType<DmRepository["listThreadsForUser"]>>>
}

export function applyWsUpgradeRateLimit(app: FastifyInstance): void {
  if (typeof app.createRateLimit !== "function") return
  const limiter = app.createRateLimit({
    ...WS_UPGRADE_RATE_LIMIT,
    keyGenerator: (req) => `ws-upgrade:${normalizeIp(req.ip)}`,
  })
  app.addHook("onRequest", async (request, reply) => {
    if ((request.url ?? "").split("?")[0] !== "/ws") return
    const result = await limiter(request)
    if (!result.isAllowed && result.isExceeded) {
      reply.header("retry-after", result.ttlInSeconds)
      reply.status(429).send({ code: ErrorCode.RATE_LIMITED, message: "Too many connection attempts." })
    }
  })
}

export function wireChatGateway(app: FastifyInstance, container: Container): ChatWiring {
  const overrides: ChatGatewayOverrides | undefined = app.chatOverrides
  const useFakeChat = container.env.USE_FAKE_CHAT

  const readState: ChatReadState =
    overrides?.readState ??
    (useFakeChat ? new InMemoryChatReadState() : makeDrizzleChatReadState(container.getDb().sql))

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

  const presignMedia = makeMediaPresigner(container.storage)

  let chatRepo: ChatRepository | undefined
  const getChatRepo = (): ChatRepository =>
    overrides?.chatRepo ?? (chatRepo ??= makeDrizzleChatRepository(container.getDb().sql, presignMedia))

  let reportChatRepo: ReportChatRepository | undefined
  const getReportChatRepo = (): ReportChatRepository =>
    overrides?.reportChat ?? (reportChatRepo ??= makeReportChatRepository(container.getDb().sql, presignMedia))

  // P4 4.4: the group management repo backing the WS group lane (join/send member gate, ack watermark,
  // mention scoping, mark-read-on-join). One instance shared with nothing route-side (the group routes
  // build their own like the report routes do) but every WS consumer below shares THIS one. When
  // chatOverrides is present WITHOUT a groups fake we must not touch getDb() (offline harness) — group
  // frames then fail closed in authorizeRoom, mirroring the reportChat gating.
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
        isMember: async (groupId, userId) => (await getGroupsRepo()!.roleOf(groupId, userId)) !== null,
        advanceReadWatermark: (groupId, userId, upToId) =>
          getGroupsRepo()!.advanceReadWatermark(groupId, userId, upToId),
      }
    : undefined

  const dmPeerOf = async (threadId: string, userId: string): Promise<string | null> => {
    const t = await dmRepo.getThread(threadId)
    if (t === null) return null
    if (t.userLo === userId) return t.userHi
    if (t.userHi === userId) return t.userLo
    return null
  }

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

  // Per-conversation mute store (D-E1). Undefined under fake-chat (no DB); test-injectable via overrides.
  const conversationMutes: ConversationMutesRepository | undefined =
    overrides?.conversationMutes ??
    (useFakeChat ? undefined : makeConversationMutesRepository(container.getDb().sql))

  // Best-effort "has this user muted this room?" gate. Returns false when the store is absent (fake-chat)
  // and swallows lookup errors so a mute-store hiccup never suppresses/breaks a bell.
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

  const clearConversationBell = async (
    kind: "dm" | "cleanup" | "group",
    id: string,
    userId: string,
  ): Promise<void> => {
    if (!notificationService) return
    try {
      if (kind === "dm") await notificationService.clearByTypeAndLink(userId, "dm", `/messages/dm/${id}`)
      else if (kind === "group")
        await notificationService.clearByTypeAndLink(userId, "group_chat", `/messages/group/${id}`)
      else await notificationService.clearByTypeAndLink(userId, "cleanup_chat", `/cleanups/${id}`)
    } catch (err) {
      app.log.warn({ err, kind, id, userId }, "read: clear conversation notifications failed (suppressed)")
    }
  }

  const dmGatewayDeps: GatewayDmDeps = {
    isParticipant: (threadId, userId) => dmRepo.isParticipant(threadId, userId),
    peerOf: dmPeerOf,
    persist: (input) => dmRepo.persist(input),
    markRead: async (threadId, userId, upToId) => {
      const at = (await dmRepo.resolveMessageCreatedAt(threadId, upToId)) ?? new Date()
      await dmRepo.markRead(threadId, userId, at)
      await clearConversationBell("dm", threadId, userId)
    },
  }

  const resolveReadAt: (cleanupId: string, upToId: string) => Promise<Date> = useFakeChat
    ? () => Promise.resolve(new Date())
    : async (cleanupId, upToId) => {
        const rows = await container.getDb().sql<{ created_at: Date }[]>`
          SELECT created_at FROM chat_messages
          WHERE id = ${upToId} AND cleanup_id = ${cleanupId} AND created_at >= now() - interval '90 days'
          LIMIT 1
        `
        return rows[0]?.created_at ?? new Date()
      }

  const threadRecipientsOf: ThreadRecipientsOf = async (kind, id, senderId) => {
    if (kind === "dm") {
      const peer = await dmPeerOf(id, senderId)
      return peer !== null ? [peer] : []
    }
    if (kind === "report") return []
    if (kind === "group") {
      // Group inbox rows refresh live like cleanup ones; uncapped (chat_group_members is the
      // same fan-out set the D-E2-style notifier will use in 4.5).
      const repo = getGroupsRepo()
      if (!repo) return []
      const members = await repo.listMemberIds(id)
      return members.filter((m) => m !== senderId)
    }
    if (useFakeChat) return []
    const members = await getCleanupRepo().listMemberIds(id, THREAD_SIGNAL_MEMBER_CAP)
    return members.filter((m) => m !== senderId)
  }

  // Shared dep set for the P2 2.5 bell notifiers (mention/reply). Only built when the real
  // notification stack exists (mirrors the pre-2.5 chatMentions gating): under fake-chat there is no
  // DB for members/mutes and no notificationService.
  const bellDeps: ChatBellDeps | undefined =
    useFakeChat || !notificationService
      ? undefined
      : {
          notificationService,
          isMutedFor,
          isCleanupMember: isMember,
          isReportChatMember: (reportId, userId) => getReportChatRepo().isMember(reportId, userId),
          // Fail closed when the group repo is unwired (offline harness): a group mention/reply then
          // never bells, mirroring authorizeRoom's fail-closed stance for group frames.
          isChatGroupMember: async (groupId, userId) =>
            (await getGroupsRepo()?.roleOf(groupId, userId) ?? null) !== null,
          isBlockedEitherWay,
          presence,
          roomKeyFor,
        }

  const chatMentions: GatewayChatMentions | undefined =
    overrides?.chatMentions ??
    (!bellDeps
      ? undefined
      : {
          // Scope rules (report chat-members-only [D11], dm peer-only, cleanup members-only) are
          // single-sourced in makeChatMentionResolver, shared with the PATCH /messages edit route.
          resolveChatMentions: makeChatMentionResolver({
            resolveTargets: (input) => resolveMentionTargets(container.getDb().sql, input),
            dmPeerOf,
            listCleanupMemberIds: (cleanupId, cap) => getCleanupRepo().listMemberIds(cleanupId, cap),
            listReportChatMemberIds: (reportId) => getReportChatRepo().listMemberIds(reportId),
            // Empty when the group repo is unwired (offline harness): a group mention then resolves
            // to nothing rather than touching getDb().
            listGroupMemberIds: (groupId) => getGroupsRepo()?.listMemberIds(groupId) ?? Promise.resolve([]),
          }),
          recordChatMentions: (messageId, mentionedUserIds) =>
            recordChatMentions(container.getDb().sql, messageId, mentionedUserIds),
          notifyChatMention: makeChatMentionNotifier(bellDeps),
        })

  // P2 2.5 reply bell: pierces conversation mutes (chat-bells makeChatReplyNotifier owns the gates);
  // frame-handler fires it for group rooms and dedupes the mention bell for the same target.
  const onChatReply: OnChatReply | undefined = bellDeps ? makeChatReplyNotifier(bellDeps) : undefined

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

  const cityForwardSeen = new Map<string, number>()
  const canForwardCity = (reportId: string, geoid: string): boolean => {
    const key = `${reportId}:${geoid}`
    const t = Date.now()
    const until = cityForwardSeen.get(key)
    if (until !== undefined && until > t) return false
    cityForwardSeen.set(key, t + CITY_FORWARD_DEDUP_MS)
    if (cityForwardSeen.size > CITY_FORWARD_DEDUP_MAX_KEYS) {
      for (const [k, exp] of cityForwardSeen) if (exp <= t) cityForwardSeen.delete(k)
    }
    return true
  }

  // Per-member report-chat bell (D-E2). Built once, reused per message. Presence-suppressed + mute-gated
  // by the notifier; the sender is skipped there. `createNotification` applies push master + quiet hours.
  // Reuses the SHARED getReportChatRepo() (D-C3) so member lookups hit the same repo the socket uses. Also
  // the seam D-D1 will reuse for its sender-less SYSTEM (status/timeline) posts. Absent under fake-chat
  // (no notificationService / mutes), where onReportMessage is undefined anyway.
  const notifyReportChatMembers =
    notificationService && conversationMutes
      ? makeReportChatNotifier({
          notificationService,
          reportChatRepo: { listMemberIds: (reportId) => getReportChatRepo().listMemberIds(reportId) },
          isMuted: (userId, roomId) => isMutedFor(userId, "report", roomId),
          presence,
          roomKeyFor,
        })
      : undefined

  // Per-member group-chat bell (P4 4.5, the D-E2 twin over chat_group_members). Same gating stance as
  // notifyReportChatMembers, plus the group repo must be wired (offline harnesses leave it undefined,
  // where onGroupMessage is then absent and group sends simply raise no fan-out bells).
  const notifyGroupChatMembers =
    notificationService && conversationMutes && groupWired
      ? makeGroupChatNotifier({
          notificationService,
          groupRepo: { listMemberIds: (groupId) => getGroupsRepo()!.listMemberIds(groupId) },
          isMuted: (userId, roomId) => isMutedFor(userId, "group", roomId),
          presence,
          roomKeyFor,
        })
      : undefined
  const onGroupMessage: OnGroupMessage | undefined = notifyGroupChatMembers
    ? async (groupId, message) => {
        void notifyGroupChatMembers(groupId, message).catch(() => {})
      }
    : undefined

  let reportOutboundMail: ReturnType<typeof makeOutboundMailService> | undefined
  let reportForwardAudit: ReportForwardAudit | undefined
  const onReportMessage: OnReportMessage | undefined = useFakeChat
    ? undefined
    : async (reportId, message) => {
        // Best-effort member bells, fire-and-forget alongside the @city forward below.
        if (notifyReportChatMembers) void notifyReportChatMembers(reportId, message).catch(() => {})
        reportOutboundMail ??= makeOutboundMailService({
          repo: makeDrizzleMailRepository(container.getDb().sql),
          mailer: container.mailer,
          env: {
            MAIL_FROM_OUTREACH: container.env.MAIL_FROM_OUTREACH,
            MAIL_REPLY_DOMAIN: container.env.MAIL_REPLY_DOMAIN,
          },
        })
        reportForwardAudit ??= makeReportForwardAudit(container.getDb().sql)
        const report = await getReportRepo().findReportForDiscussion(reportId)
        if (report === null) return
        const body = typeof message.body === "string" ? message.body : ""
        // message.id threads the persisted chat_messages row id into the audit table (report_message_forwards
        // keys on it). forwardReportCityMention writes the mentioned-but-not-forwarded row before the send and
        // stamps forwarded_at on success; audit failures are swallowed there (message already persisted).
        await forwardReportCityMention(
          reportOutboundMail,
          {
            reportId,
            category: report.category,
            place: report.place,
            jurisdiction: report.jurisdiction,
          },
          body,
          new Date(message.createdAt),
          { canForward: canForwardCity, audit: reportForwardAudit, messageId: message.id },
        )
      }

  applyWsUpgradeRateLimit(app)

  const wsTicketCache = app.authServices?.cache
  registerChatGateway(app, {
    chat: container.chatService,
    isMember,
    sessions: app.authServices?.sessions,
    ...(wsTicketCache
      ? { redeemTicket: (ticket: string) => makeWsTicketStore(wsTicketCache).redeem(ticket) }
      : {}),
    markRead: async (cleanupId, userId, upToId) => {
      const at = await resolveReadAt(cleanupId, upToId)
      await readState.markRead(cleanupId, userId, at)
      await clearConversationBell("cleanup", cleanupId, userId)
    },
    presence,
    dm: dmGatewayDeps,
    isBlockedEitherWay,
    userChannel: container.userChannel,
    threadRecipientsOf,
    // DM delivered bell, now via chat-bells (P2 2.5): carries the reply override — a reply TO the
    // recipient pierces a muted thread; an unmuted thread keeps its single normal bell.
    onDmDelivered: notificationService
      ? makeDmBellNotifier({ notificationService, isMutedFor })
      : undefined,
    markReadOnOpen: async (kind, id, userId) => {
      const at = new Date()
      if (kind === "dm") {
        await dmRepo.markRead(id, userId, at)
        await clearConversationBell("dm", id, userId)
      } else if (kind === "cleanup") {
        await readState.markRead(id, userId, at)
        await clearConversationBell("cleanup", id, userId)
      } else if (kind === "group") {
        // P4 4.4/4.5: opening a group room marks it read (member-scoped in the repo's WHERE) and
        // clears the room's group_chat bells (the dm/cleanup clear-on-open pattern).
        await getGroupsRepo()?.markRead(id, userId, at)
        await clearConversationBell("group", id, userId)
      }
    },
    chatMentions,
    onReportMessage,
    onGroupMessage,
    onChatReply,
    reportVisible,
    reportSendLimiter,
    // Injected into the socket so member-only send/typing + ack watermark share ONE instance with the
    // routes (via getReportChatRepo). Gated on useFakeChat like reportVisible/onReportMessage: the fake
    // path has no DB, so under fake-chat the socket falls back to public send (matching pre-D-C3).
    reportChat: overrides?.reportChat ?? (useFakeChat ? undefined : getReportChatRepo()),
    // P4 4.4: member gate + ack watermark for group rooms, same one-instance stance as reportChat.
    // Absent under fake-chat / an override set without a groups fake, where authorizeRoom fails
    // group frames closed.
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
    listDmThreadsFor: (userId, limit) => dmRepo.listThreadsForUser(userId, limit),
  }
}
