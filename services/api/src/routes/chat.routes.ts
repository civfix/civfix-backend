
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
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { csrfProtect } from "../auth/csrf.js"
import { parse } from "./_validate.js"
import { route } from "../versioning/route.js"
import { roomKeyFor } from "../ws/gateway.js"
import { wireChatGateway } from "./chat-gateway-wiring.js"
import { makeChatReactionService } from "../services/chat-reaction-service.js"
import type { ChatRepository } from "../services/chat-repository.drizzle.js"
import {
  type GatewayChatMentions,
  type IsMemberFn,
  type ReportVisibleFn,
} from "../ws/gateway.js"
import { makeDrizzleThreadsRepository } from "../services/threads-repository.drizzle.js"
import type { DmRepository } from "../services/dm-repository.drizzle.js"
import type { BlocksRepository } from "../services/blocks-repository.drizzle.js"
import type { ChatPresence } from "../adapters/chat-presence.js"
import {
  makeThreadsService,
  THREADS_DEFAULT_LIMIT,
  type ChatReadState,
  type DmThreadsSource,
  type ThreadsRepository,
} from "../services/threads-service.js"
import type { NotificationService } from "../services/notification-service.js"

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
}

declare module "fastify" {
  interface FastifyInstance {
    chatOverrides?: ChatGatewayOverrides
  }
}

const ThreadMessageParamsSchema = z.object({ cleanupId: IdSchema, messageId: IdSchema }).strict()

const CHAT_REACTION_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const

export async function registerChatRoutes(app: FastifyInstance, container: Container): Promise<void> {
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } })

  const overrides = app.chatOverrides
  const wiring = wireChatGateway(app, container)

  const dmThreadsSource: DmThreadsSource = { listDmThreadsFor: wiring.listDmThreadsFor }

  route(app, "listThreads", async (request, reply) => {
    const userId = requireAuth(request)
    const pagination = parse(PaginationQuerySchema, request.query)
    const limit = pagination.limit ?? THREADS_DEFAULT_LIMIT
    const threadsRepo: ThreadsRepository = overrides
      ? overrides.threadsRepo
      : makeDrizzleThreadsRepository(container.getDb().sql)
    const threads = makeThreadsService({ repo: threadsRepo, readState: wiring.readState, dm: dmThreadsSource })
    const result = await threads.listThreads(userId, limit)
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

  route(app, "deleteCleanupMessage", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { cleanupId, messageId } = parse(ThreadMessageParamsSchema, request.params)
    if (!(await wiring.isMember(cleanupId, userId))) {
      throw AppError.forbidden("You can't delete this message.")
    }
    const tombstone: ChatMessageDTO | null = await wiring.getChatRepo().softDelete(cleanupId, messageId, userId)
    if (tombstone === null) throw AppError.forbidden("You can't delete this message.")
    void Promise.resolve(
      container.chatService.broadcast(roomKeyFor("cleanup", cleanupId), tombstone),
    ).catch(() => {})
    reply.status(200).send(tombstone)
  })
}
