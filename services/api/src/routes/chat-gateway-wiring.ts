
import { ErrorCode } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { normalizeIp } from "../abuse/ip-rate-limit.js"
import {
  registerChatGateway,
  type GatewayChatMentions,
  type GatewayDmDeps,
  type IsBlockedEitherWayFn,
  type IsMemberFn,
  type OnReportMessage,
  type ThreadRecipientsOf,
} from "../ws/gateway.js"
import { resolveMentionTargets } from "../services/social-repository.drizzle.js"
import { makeDrizzleCleanupRepository } from "../services/cleanup-repository.drizzle.js"
import { makeDrizzleDiscussionRepository } from "../services/discussion-repository.drizzle.js"
import { makeOutboundMailService } from "../services/admin/outbound-mail-service.js"
import { makeDrizzleMailRepository } from "../services/admin/mail-repository.drizzle.js"
import { forwardReportCityMention } from "../services/report-city-forward.js"
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
import type { DmRepository } from "../services/dm-repository.drizzle.js"
import type { BlocksRepository } from "../services/blocks-repository.drizzle.js"
import { InMemoryChatPresence, RedisChatPresence, type ChatPresence } from "../adapters/chat-presence.js"
import { InMemoryChatReadState, type ChatReadState } from "../services/threads-service.js"
import { dmAuthorName, mentionAuthorName, textPreview } from "./chat-notify-copy.js"
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

  const clearConversationBell = async (kind: "dm" | "cleanup", id: string, userId: string): Promise<void> => {
    if (!notificationService) return
    try {
      if (kind === "dm") await notificationService.clearByTypeAndLink(userId, "dm", `/messages/dm/${id}`)
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
    if (useFakeChat) return []
    const members = await getCleanupRepo().listMemberIds(id, THREAD_SIGNAL_MEMBER_CAP)
    return members.filter((m) => m !== senderId)
  }

  const chatMentions: GatewayChatMentions | undefined =
    overrides?.chatMentions ??
    (useFakeChat || !notificationService
      ? undefined
      : {
          resolveChatMentions: async (input) => {
            if (input.kind === "report") return []
            const resolved = await resolveMentionTargets(container.getDb().sql, {
              handles: input.handles,
              userIds: input.userIds,
              authorUserId: input.authorUserId,
            })
            if (resolved.length === 0) return resolved
            if (input.kind === "dm") {
              const peer = await dmPeerOf(input.roomId, input.authorUserId)
              return peer !== null ? resolved.filter((m) => m.id === peer) : []
            }
            const memberIds = new Set(await getCleanupRepo().listMemberIds(input.roomId, THREAD_SIGNAL_MEMBER_CAP))
            return resolved.filter((m) => memberIds.has(m.id))
          },
          recordChatMentions: (messageId, mentionedUserIds) =>
            recordChatMentions(container.getDb().sql, messageId, mentionedUserIds),
          notifyChatMention: async (input) => {
            const { kind, roomId, actorUserId, mentionedUserId, message } = input
            if (kind === "dm") return
            if (!(await isMember(roomId, mentionedUserId))) return
            if (await blocksRepo.isBlockedEitherWay(actorUserId, mentionedUserId)) return
            if (!(await notificationService.getPrefs(mentionedUserId)).mentions) return
            {
              const name = mentionAuthorName(message)
              const preview = textPreview(message)
              await notificationService.createNotification(mentionedUserId, {
                type: "cleanup_chat",
                titleKey: "notification.chat_mention.title",
                vars: { name },
                ...(preview !== null
                  ? { body: preview }
                  : { bodyKey: "notification.message.no_preview" }),
                link: `/cleanups/${roomId}`,
              })
            }
          },
        })

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

  let reportOutboundMail: ReturnType<typeof makeOutboundMailService> | undefined
  const onReportMessage: OnReportMessage | undefined = useFakeChat
    ? undefined
    : async (reportId, message) => {
        reportOutboundMail ??= makeOutboundMailService({
          repo: makeDrizzleMailRepository(container.getDb().sql),
          mailer: container.mailer,
          env: {
            MAIL_FROM_OUTREACH: container.env.MAIL_FROM_OUTREACH,
            MAIL_REPLY_DOMAIN: container.env.MAIL_REPLY_DOMAIN,
          },
        })
        const report = await getReportRepo().findReportForDiscussion(reportId)
        if (report === null) return
        const body = typeof message.body === "string" ? message.body : ""
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
          { canForward: canForwardCity },
        )
      }

  applyWsUpgradeRateLimit(app)

  registerChatGateway(app, {
    chat: container.chatService,
    isMember,
    sessions: app.authServices?.sessions,
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
    onDmDelivered: notificationService
      ? async (threadId, recipientId, message) => {
          const name = dmAuthorName(message)
          const preview = textPreview(message)
          await notificationService.createNotification(recipientId, {
            type: "dm",
            ...(name !== "" ? { title: name } : { titleKey: "notification.dm.title_fallback" }),
            ...(preview !== null
              ? { body: preview }
              : { bodyKey: "notification.message.no_preview" }),
            link: `/messages/dm/${threadId}`,
          })
        }
      : undefined,
    markReadOnOpen: async (kind, id, userId) => {
      const at = new Date()
      if (kind === "dm") {
        await dmRepo.markRead(id, userId, at)
        await clearConversationBell("dm", id, userId)
      } else if (kind === "cleanup") {
        await readState.markRead(id, userId, at)
        await clearConversationBell("cleanup", id, userId)
      }
    },
    chatMentions,
    onReportMessage,
    reportVisible,
    reportSendLimiter,
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
    listDmThreadsFor: (userId, limit) => dmRepo.listThreadsForUser(userId, limit),
  }
}
