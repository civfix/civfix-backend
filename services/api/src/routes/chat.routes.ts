/**
 * Chat route plugin: the WebSocket upgrade (GET /ws) + the threads list (GET /threads) + cleanup-chat
 * message reaction/delete.
 *
 *   GET /ws        the WebSocket chat gateway. Dual handshake auth (session cookie OR ?token=<bearer>),
 *                  then membership-gated join/send + live fan-out. See ws/gateway.ts. Per-IP upgrade rate
 *                  limit applied in chat-gateway-wiring.
 *   GET /threads   [auth]  the viewer's cleanup + dm threads as MessageThreadDTO.
 *
 * @fastify/websocket is registered here (once) so GET /ws can upgrade. The gateway wiring (read-state,
 * presence, membership, dm/blocks, dm bell, @-mention seam) lives in chat-gateway-wiring.ts; it returns the
 * shared handles these HTTP routes reuse so the gateway, the threads UNION, and the reaction/delete routes
 * share the SAME repo instances.
 */

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

/**
 * Optional injected chat/threads dependencies (tests). When present the gateway + threads routes use these
 * instead of the container DB seams, so the WS gateway and GET /threads run offline. The same isMember
 * probe gates the gateway; the same readState backs both unread counts and the `ack` watermark.
 */
export interface ChatGatewayOverrides {
  isMember: IsMemberFn
  threadsRepo: ThreadsRepository
  readState?: ChatReadState
  presence?: ChatPresence
  dmRepo?: DmRepository
  chatRepo?: ChatRepository
  blocksRepo?: BlocksRepository
  /** Injected notification service (tests): backs the dm bell + cleanup/dm read clears offline. */
  notificationService?: NotificationService
  /** Injected chat @-mention seam (tests): backs the send-frame mention resolve/persist/notify path. */
  chatMentions?: GatewayChatMentions
}

declare module "fastify" {
  interface FastifyInstance {
    chatOverrides?: ChatGatewayOverrides
  }
}

const ThreadMessageParamsSchema = z.object({ cleanupId: IdSchema, messageId: IdSchema }).strict()

/** Per-IP rate limit for chat reaction toggles (mirrors the discussion write limit shape). */
const CHAT_REACTION_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const

export async function registerChatRoutes(app: FastifyInstance, container: Container): Promise<void> {
  // Register the websocket plugin once so GET /ws can upgrade. maxPayload bounds an oversized frame.
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } })

  const overrides = app.chatOverrides
  // Wire the gateway (registers GET /ws + the per-IP upgrade limit) and capture the shared handles.
  const wiring = wireChatGateway(app, container)

  const dmThreadsSource: DmThreadsSource = { listDmThreadsFor: wiring.listDmThreadsFor }

  route(app, "listThreads", async (request, reply) => {
    const userId = requireAuth(request)
    const pagination = parse(PaginationQuerySchema, request.query)
    // The shared limit is optional with no baked-in default (each resource owns its page size).
    const limit = pagination.limit ?? THREADS_DEFAULT_LIMIT
    const threadsRepo: ThreadsRepository = overrides
      ? overrides.threadsRepo
      : makeDrizzleThreadsRepository(container.getDb().sql)
    const threads = makeThreadsService({ repo: threadsRepo, readState: wiring.readState, dm: dmThreadsSource })
    const result = await threads.listThreads(userId, limit)
    const payload: ListThreadsResponse = { items: result.items, nextCursor: result.nextCursor }
    reply.status(200).send(payload)
  })

  // Toggle an emoji reaction on a cleanup group-chat message. Mirrors toggleDiscussionReaction: auth + csrf
  // + per-IP write limit; membership-gated inside the service; returns the recomputed ChatMessageDTO and
  // broadcasts a {type:"reaction"} frame to the room.
  route(
    app,
    "toggleCleanupMessageReaction",
    { preHandler: csrfProtect, config: { rateLimit: CHAT_REACTION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { cleanupId, messageId } = parse(ThreadMessageParamsSchema, request.params)
      // The body schema carries the path ids (the typed client fills them in); the authoritative ids are
      // the URL path, so stamp them before validating the bounded `emoji`.
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
      // REALTIME: fan a {type:"reaction"} frame (recomputed message) to the room. Best-effort fire-and-forget:
      // a fan-out failure must never fail the toggle. Cleanup is the implicit roomKind (omitted).
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

  // Soft-delete (tombstone) one of the AUTHOR's own cleanup-chat messages. Membership-gated + sender-only
  // (the repo WHERE gate). Re-broadcasts the tombstone over the SAME {type:"message"} frame the gateway's
  // send uses, so clients upsert the blanked bubble by id. DELETE carries no body.
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
