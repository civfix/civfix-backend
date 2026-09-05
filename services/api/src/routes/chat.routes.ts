
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
import {
  deleteMessageWithPowers,
  DELETE_MESSAGE_FORBIDDEN,
  neutralizeChatViewerFields,
} from "./chat-route-helpers.js"
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
import {
  makeConversationHidesRepository,
  type ConversationHidesRepository,
} from "../services/conversation-hides-repository.drizzle.js"

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
  conversationHides?: ConversationHidesRepository
  reportThreadsSource?: ReportThreadsSource
  groupThreadsSource?: GroupThreadsSource
  groups?: ChatGroupRepository
  chatPolls?: ChatPollRepository
  chatPowers?: ResolveChatPowers
}

declare module "fastify" {
  interface FastifyInstance {
    chatOverrides?: ChatGatewayOverrides
  }
}

const ThreadMessageParamsSchema = z.object({ cleanupId: IdSchema, messageId: IdSchema }).strict()

export const CHAT_REACTION_RATE_LIMIT = perIdentity({ max: 60, timeWindow: "1 minute" })

export const CHAT_DELETE_RATE_LIMIT = perIdentity({ max: 30, timeWindow: "1 minute" })

export async function registerChatRoutes(app: FastifyInstance, container: Container): Promise<void> {
  const csrfProtect = container.csrf.protect

  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } })

  const overrides = app.chatOverrides
  const wiring = wireChatGateway(app, container)

  const dmThreadsSource: DmThreadsSource = { listDmThreadsFor: wiring.listDmThreadsFor }

  let threadsService: ThreadsService | undefined
  const getThreads = (): ThreadsService => {
    if (threadsService) return threadsService
    const threadsRepo: ThreadsRepository = overrides
      ? overrides.threadsRepo
      : makeDrizzleThreadsRepository(container.getDb().sql)
    const reportThreadsSource: ReportThreadsSource | undefined = overrides
      ? overrides.reportThreadsSource
      : makeDrizzleReportThreadsSource(container.getDb().sql)
    const groupThreadsSource: GroupThreadsSource | undefined = overrides
      ? overrides.groupThreadsSource
      : makeDrizzleGroupThreadsSource(container.getDb().sql)
    const mutes: ConversationMutesRepository | undefined = overrides
      ? overrides.conversationMutes
      : makeConversationMutesRepository(container.getDb().sql)
    const hides: ConversationHidesRepository | undefined = overrides
      ? overrides.conversationHides
      : makeConversationHidesRepository(container.getDb().sql)
    return (threadsService = makeThreadsService({
      repo: threadsRepo,
      readState: wiring.readState,
      dm: dmThreadsSource,
      report: reportThreadsSource,
      group: groupThreadsSource,
      mutes,
      hides,
    }))
  }

  route(app, "listThreads", async (request, reply) => {
    const userId = requireAuth(request)
    const pagination = parse(PaginationQuerySchema, request.query)
    const limit = pagination.limit ?? THREADS_DEFAULT_LIMIT
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
          message: neutralizeChatViewerFields(updated),
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
