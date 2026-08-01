import { ErrorCode } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { makeWsTicketStore } from "../auth/ws-ticket.js"
import { applyRateLimitHeaders, wsUpgradeRateLimitKey } from "../plugins/rate-limit.js"
import {
  registerChatGateway,
  roomKeyFor,
  type GatewayChatMentions,
  type GatewayDmDeps,
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
import { makeOutboundMailService } from "../services/admin/outbound-mail-service.js"
import { makeDrizzleMailRepository } from "../services/admin/mail-repository.drizzle.js"
import { forwardReportCityMention } from "../services/report-city-forward.js"
import {
  makeReportForwardAudit,
  type ReportForwardAudit,
} from "../services/report-forward-audit.drizzle.js"
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
import { makeDrizzleChatReadState } from "../services/chat-read-state.drizzle.js"
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
import type { ChatGatewayOverrides } from "./chat.routes.js"

const WS_UPGRADE_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const

const REPORT_SEND_LIMIT = { capacity: 30, refillPerSec: 0.5 } as const

const CITY_FORWARD_DEDUP_MS = 10 * 60 * 1000
const CITY_FORWARD_DEDUP_MAX_KEYS = 5000

/**
 * The resolve+record half of the mention seam. The WS gateway lane adds the third half (notifyChatMention);
 * PATCH /messages deliberately has none — an edit never re-fires mention bells.
 */
export type ChatMentionSeam = Pick<
  GatewayChatMentions,
  "resolveChatMentions" | "recordChatMentions"
>

/** One seam per Fastify instance (see chatMentionDeps). */
const mentionSeams = new WeakMap<FastifyInstance, ChatMentionSeam>()

/**
 * The mention seam, built ONCE per Fastify instance and shared by the WS gateway wiring and
 * messages.routes (the only two consumers). Both hand-rolled the same makeChatMentionResolver call over
 * their own repo handles, so the SCOPE RULES — report chat-members-only [D11], dm peer-only, cleanup
 * members-only, group members-only — were a two-place decision that could drift on one side only. They
 * are now one place, and the caller supplies nothing but the app + container.
 *
 * Every lookup inside is LAZY: constructing the seam touches neither getDb() nor the container's repos,
 * so a caller may build it at mount time. The caller still owns the DECISION to use it at all (both gate
 * it off under fake-chat, where there is no DB to resolve mentions against) and an injected
 * chatOverrides.chatMentions still wins outright at the call site.
 */
export function chatMentionDeps(app: FastifyInstance, container: Container): ChatMentionSeam {
  const cached = mentionSeams.get(app)
  if (cached) return cached

  const overrides: ChatGatewayOverrides | undefined = app.chatOverrides
  // H9: PRIVATE presigner like every other chat-repo construction site. Nothing here hydrates a message
  // (the seam reads member ids only), but the repos must not be a public-URL source if that ever changes.
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
      // Empty when the group repo is unwired (an override harness carrying no groups fake): a group
      // mention then resolves to nothing rather than touching getDb().
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

export interface ChatWiring {
  readState: ChatReadState
  isMember: IsMemberFn
  dmRepo: DmRepository
  blocksRepo: BlocksRepository
  isBlockedEitherWay: IsBlockedEitherWayFn
  dmPeerOf: (threadId: string, userId: string) => Promise<string | null>
  getChatRepo(): ChatRepository
  getReportChatRepo(): ReportChatRepository
  /**
   * The dm half of the threads inbox — the repo method's FULL shape, cursor included. The keyset in
   * threads-service re-applies an exact millisecond cut on the merge, so a binder that dropped the third
   * arg handed page 2 the same newest rows and the service cut every one of them: DM threads disappeared
   * from the inbox from page 2 onward.
   */
  listDmThreadsFor: DmRepository["listThreadsForUser"]
}

export function applyWsUpgradeRateLimit(app: FastifyInstance): void {
  if (typeof app.createRateLimit !== "function") return
  const limiter = app.createRateLimit({
    ...WS_UPGRADE_RATE_LIMIT,
    keyGenerator: wsUpgradeRateLimitKey,
  })
  app.addHook("onRequest", async (request, reply) => {
    if ((request.url ?? "").split("?")[0] !== "/ws") return
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

  /**
   * The batched M11 block gate behind the report/group fan-outs (`blockedIdsAmong`): ONE user_blocks query
   * for a room's whole candidate set instead of one `isBlockedEitherWay` per member.
   *
   * PROBED, not bound unconditionally — the same stance as `mutedUserIdsForRoom` below: the fan-out treats
   * a present `blockedIdsFor` as authoritative and never falls back to the per-candidate gate, so binding
   * an absent batch method through a `?? new Set()` default would silently UNBLOCK the whole room. The
   * batch form is optional on BlocksRepository (the in-memory repo backing fake-chat/offline harnesses
   * predates it), so an implementation without it stays on the per-candidate gate — same verdicts, more
   * round trips, never a weaker gate.
   */
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

  /**
   * ONE chat_group_members scan per group send. A group send fires the threads signal
   * (threadRecipientsOf) and the bell fan-out (onGroupMessage -> group notifier) in the SAME tick, and
   * both read the same member list — so overlapping calls share the one in-flight query. The entry is
   * dropped as soon as it settles: this coalesces concurrent readers, it does NOT cache, so no consumer
   * can act on a membership set older than a query it could have issued itself.
   */
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

  /**
   * The batched one-room-many-users mute lookup behind the report/group fan-outs: ONE conversation_mutes
   * query per message instead of one per candidate member.
   *
   * Wired ONLY when the repo actually implements it. The fan-out treats a present `mutedUserIdsFor` as
   * AUTHORITATIVE and skips the per-candidate `isMuted` entirely, so binding an absent method to an empty
   * Set would silently unmute the whole room — and the batch shape is optional on
   * ConversationMutesRepository precisely because the offline fakes predate it.
   */
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
      // Single-sourced (type, link) mapping in conversation-bell.ts (PR #21), extended for the P4 group
      // lane. report joins dm/cleanup/group here so opening a report room clears its report_chat bells.
      await clearConversationBellFor(notificationService, kind, id, userId)
    } catch (err) {
      app.log.warn(
        { err, kind, id, userId },
        "read: clear conversation notifications failed (suppressed)",
      )
    }
  }

  // No isParticipant: the gateway authorizes dm rooms through peerOf alone (participation AND the peer
  // the block gate needs, in one round trip).
  const dmGatewayDeps: GatewayDmDeps = {
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
      // Group inbox rows refresh live like cleanup ones, and carry the same fan-out ceiling: an inbox
      // nudge is a best-effort refresh hint, so a very large group publishes to the first
      // THREAD_SIGNAL_MEMBER_CAP members rather than one Redis publish per member per message. The
      // member list is the one the bell fan-out reads too (see listGroupMembersShared).
      const members = await listGroupMembersShared(id)
      return members.filter((m) => m !== senderId).slice(0, THREAD_SIGNAL_MEMBER_CAP)
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
          // Resolve + record come from the shared, memoized seam (scope rules single-sourced there and
          // with the PATCH /messages edit route); only the notify half is this lane's own.
          ...chatMentionDeps(app, container),
          notifyChatMention: makeChatMentionNotifier(bellDeps),
        })

  // P2 2.5 reply bell: pierces conversation mutes (chat-bells makeChatReplyNotifier owns the gates);
  // frame-handler fires it for group rooms and dedupes the mention bell for the same target.
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
          // M11: the block gate the mention/reply bells already apply (chat-bells) — a blocked user
          // must not reach their target's lock screen through a shared PUBLIC report room.
          isBlockedEitherWay,
          ...(blockedIdsForCandidates ? { blockedIdsFor: blockedIdsForCandidates } : {}),
        })
      : undefined

  // Per-member group-chat bell (P4 4.5, the D-E2 twin over chat_group_members). Same gating stance as
  // notifyReportChatMembers, plus the group repo must be wired (offline harnesses leave it undefined,
  // where onGroupMessage is then absent and group sends simply raise no fan-out bells).
  const notifyGroupChatMembers =
    notificationService && conversationMutes && groupWired
      ? makeGroupChatNotifier({
          notificationService,
          groupRepo: { listMemberIds: listGroupMembersShared },
          isMuted: (userId, roomId) => isMutedFor(userId, "group", roomId),
          ...(groupMutedUserIdsFor ? { mutedUserIdsFor: groupMutedUserIdsFor } : {}),
          presence,
          roomKeyFor,
          // M11: same block gate as the report fan-out above.
          isBlockedEitherWay,
          ...(blockedIdsForCandidates ? { blockedIdsFor: blockedIdsForCandidates } : {}),
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

  // Same three-way stance as the group lane above (and the convention this file's comments state): with
  // chatOverrides present, ONLY the injected fake counts — an offline harness that carries no reportChat
  // must not have getReportChatRepo() reach container.getDb() here, at mount.
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
    // Wrapped (PR #21) so the ack watermark also clears the reader's report_chat bells, while still
    // sharing ONE underlying repo instance with the routes (via getReportChatRepo). Gated on useFakeChat
    // like reportVisible/onReportMessage: the fake path has no DB, so the wrapper is undefined and the
    // socket falls back to public send (matching pre-D-C3).
    reportChat,
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
    listDmThreadsFor: (userId, limit, cursor) => dmRepo.listThreadsForUser(userId, limit, cursor),
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
