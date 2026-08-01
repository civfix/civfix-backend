
import fastifyWebsocket from "@fastify/websocket"
import {
  PaginationQuerySchema,
  ToggleCleanupMessageReactionRequestSchema,
  IdSchema,
  AppError,
  type ChatMessageDTO,
  type ListThreadsResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import { perIdentity } from "../plugins/rate-limit.js"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { parse } from "./_validate.js"
import { route } from "../versioning/route.js"
import { roomKeyFor } from "../ws/gateway.js"
import { wireChatGateway } from "./chat-gateway-wiring.js"
import { deleteMessageWithPowers, DELETE_MESSAGE_FORBIDDEN } from "./chat-route-helpers.js"
import { makeChatReactionService } from "../services/chat-reaction-service.js"
import type { ChatRepository } from "../services/chat-repository.drizzle.js"
import type { ReportChatRepository } from "../services/report-chat-repository.drizzle.js"
import type { ChatPollRepository } from "../services/chat-poll-repository.drizzle.js"
import {
  type GatewayChatMentions,
  type IsMemberFn,
  type ReportVisibleFn,
} from "../ws/gateway.js"
import {
  makeDrizzleGroupThreadsSource,
  makeDrizzleReportThreadsSource,
  makeDrizzleThreadsRepository,
} from "../services/threads-repository.drizzle.js"
import type { DmRepository } from "../services/dm-repository.drizzle.js"
import type { BlocksRepository } from "../services/blocks-repository.drizzle.js"
import type { ChatGroupRepository } from "../services/chat-group-repository.drizzle.js"
import type { ChatPresence } from "../adapters/chat-presence.js"
import {
  makeThreadsService,
  THREADS_DEFAULT_LIMIT,
  type ChatReadState,
  type DmThreadsSource,
  type GroupThreadsSource,
  type ReportThreadsSource,
  type ThreadsRepository,
  type ThreadsService,
} from "../services/threads-service.js"
import type { NotificationService } from "../services/notification-service.js"
import type { ResolveChatPowers } from "../services/chat-room-roles.js"
import { wireChatPowers } from "./chat-powers-wiring.js"
import {
  makeConversationMutesRepository,
  type ConversationMutesRepository,
} from "../services/conversation-mutes-repository.drizzle.js"

export interface ChatGatewayOverrides {
  isMember: IsMemberFn
  threadsRepo: ThreadsRepository
  readState?: ChatReadState
  presence?: ChatPresence
  dmRepo?: DmRepository
  chatRepo?: ChatRepository
  blocksRepo?: BlocksRepository
  notificationService?: NotificationService
  chatMentions?: GatewayChatMentions
  reportVisible?: ReportVisibleFn
  reportChat?: ReportChatRepository
  conversationMutes?: ConversationMutesRepository
  reportThreadsSource?: ReportThreadsSource
  /** P4 4.5: the group half of the threads inbox (absent => no group threads, like the report seam). */
  groupThreadsSource?: GroupThreadsSource
  /** P4: chat_groups management repo (group routes + the powers resolver's group lane). */
  groups?: ChatGroupRepository
  /** P6: chat_polls write repo (poll create/vote/close). When absent, built over the container sql. */
  chatPolls?: ChatPollRepository
  /**
   * P3: injected chat-powers resolver (pin / delete-others). When absent, wireChatPowers builds a
   * fail-closed resolver over the other override seams (offline) or the real Drizzle lookups (prod).
   */
  chatPowers?: ResolveChatPowers
}

declare module "fastify" {
  interface FastifyInstance {
    chatOverrides?: ChatGatewayOverrides
  }
}

const ThreadMessageParamsSchema = z.object({ cleanupId: IdSchema, messageId: IdSchema }).strict()

export const CHAT_REACTION_RATE_LIMIT = perIdentity({ max: 60, timeWindow: "1 minute" })

/**
 * L11: deleting messages is a state change with a broadcast attached and had NO route limit at all
 * (only the global 300/min/IP). 30/min is well above any human moderation session while bounding a
 * scripted delete sweep — the same order of magnitude as the reaction limit above.
 */
export const CHAT_DELETE_RATE_LIMIT = perIdentity({ max: 30, timeWindow: "1 minute" })

export async function registerChatRoutes(app: FastifyInstance, container: Container): Promise<void> {
  const csrfProtect = container.csrf.protect

  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } })

  const overrides = app.chatOverrides
  const wiring = wireChatGateway(app, container)

  const dmThreadsSource: DmThreadsSource = { listDmThreadsFor: wiring.listDmThreadsFor }

  // Built ONCE on first use (never at mount time — the offline route-coverage boot must not open a
  // connection), like the lazy repo seams in the sibling chat route files.
  let threadsService: ThreadsService | undefined
  const getThreads = (): ThreadsService => {
    if (threadsService) return threadsService
    const threadsRepo: ThreadsRepository = overrides
      ? overrides.threadsRepo
      : makeDrizzleThreadsRepository(container.getDb().sql)
    // The report-chat half of the inbox + the per-conversation mute seam. Both are DB-backed off the
    // shared sql tag in production. When chatOverrides is present (the no-DB route tests inject only a
    // fake threadsRepo) we do NOT touch container.getDb() — mirroring the threadsRepo branch above — and
    // instead honor the optional override fields: an absent reportThreadsSource means "no report half"
    // and an absent conversationMutes means "fail open" (muted=false), so those tests need not wire them.
    const reportThreadsSource: ReportThreadsSource | undefined = overrides
      ? overrides.reportThreadsSource
      : makeDrizzleReportThreadsSource(container.getDb().sql)
    const groupThreadsSource: GroupThreadsSource | undefined = overrides
      ? overrides.groupThreadsSource
      : makeDrizzleGroupThreadsSource(container.getDb().sql)
    const mutes: ConversationMutesRepository | undefined = overrides
      ? overrides.conversationMutes
      : makeConversationMutesRepository(container.getDb().sql)
    return (threadsService = makeThreadsService({
      repo: threadsRepo,
      readState: wiring.readState,
      dm: dmThreadsSource,
      report: reportThreadsSource,
      group: groupThreadsSource,
      mutes,
    }))
  }

  route(app, "listThreads", async (request, reply) => {
    const userId = requireAuth(request)
    const pagination = parse(PaginationQuerySchema, request.query)
    const limit = pagination.limit ?? THREADS_DEFAULT_LIMIT
    // The contract's `cursor` is now honored (it used to be parsed and dropped, so the inbox was
    // truncated at `limit` with no way to reach older threads); nextCursor comes back verbatim.
    const result = await getThreads().list(userId, {
      limit,
      ...(pagination.cursor !== undefined ? { cursor: pagination.cursor } : {}),
    })
    const payload: ListThreadsResponse = { items: result.items, nextCursor: result.nextCursor }
    reply.status(200).send(payload)
  })

  route(
    app,
    "toggleCleanupMessageReaction",
    { preHandler: csrfProtect, config: { rateLimit: CHAT_REACTION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { cleanupId, messageId } = parse(ThreadMessageParamsSchema, request.params)
      const body = parse(ToggleCleanupMessageReactionRequestSchema, {
        ...(request.body as object),
        cleanupId,
        messageId,
      })
      const reactions = makeChatReactionService({
        chat: wiring.getChatRepo(),
        dm: wiring.dmRepo,
        isCleanupMember: wiring.isMember,
        dmPeerOf: wiring.dmPeerOf,
        isBlockedEitherWay: wiring.isBlockedEitherWay,
      })
      const updated: ChatMessageDTO = await reactions.toggleCleanupReaction(cleanupId, messageId, userId, body.emoji)
      void Promise.resolve(
        container.chatService.broadcastEvent?.(roomKeyFor("cleanup", cleanupId), {
          type: "reaction",
          cleanupId,
          message: updated,
        }),
      ).catch(() => {})
      reply.status(200).send(updated)
    },
  )

  const resolveChatPowers = wireChatPowers(app, container)

  route(
    app,
    "deleteCleanupMessage",
    { preHandler: csrfProtect, config: { rateLimit: CHAT_DELETE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { cleanupId, messageId } = parse(ThreadMessageParamsSchema, request.params)
      // Cleanup rooms are private: a non-member never reaches the ladder (an organizer's delete-others
      // power comes with their membership row, unlike the operator lane in public report rooms).
      if (!(await wiring.isMember(cleanupId, userId))) {
        throw AppError.forbidden(DELETE_MESSAGE_FORBIDDEN)
      }
      const chatRepo = wiring.getChatRepo()
      const tombstone = await deleteMessageWithPowers({
        roomKind: "cleanup",
        roomId: cleanupId,
        messageId,
        userId,
        senderPath: true,
        softDelete: (opts) => chatRepo.softDelete(cleanupId, messageId, userId, opts),
        findMessageMeta: (id) => chatRepo.findMessageMeta(id),
        resolveChatPowers,
        chat: container.chatService,
        legacyBroadcast: true,
      })
      reply.status(200).send(tombstone)
    },
  )
}
