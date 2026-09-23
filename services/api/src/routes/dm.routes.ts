import {
  OpenDmRequestSchema,
  DmHistoryQuerySchema,
  EditChatMessageRequestSchema,
  ToggleDmMessageReactionRequestSchema,
  IdSchema,
  AppError,
  type OpenDmResponse,
  type ChatHistoryResponse,
  type ChatMessageDTO,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import { perIdentity } from "../plugins/rate-limit.js"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { parse, trimTextFields } from "./_validate.js"
import { route } from "../versioning/route.js"
import { broadcastMessageUpdate, roomKeyFor } from "../ws/gateway.js"
import { makeDmService, type DmService, type DmUserLookup } from "../services/dm-service.js"
import { makeChatReactionService } from "../services/chat-reaction-service.js"
import { makeChatEditService } from "../services/chat-edit-service.js"
import { makeDmPeerOf } from "../services/dm-peer.js"
import type { DmRepository } from "../services/dm-repository.drizzle.js"
import type { BlocksRepository } from "../services/blocks-repository.drizzle.js"
import {
  makeConversationMutesRepository,
  type ConversationMutesRepository,
} from "../services/conversation-mutes-repository.drizzle.js"
import { chatHistoryPayload, neutralizeChatViewerFields } from "./chat-route-helpers.js"

const DmIdParamsSchema = z.object({ id: IdSchema }).strict()

const ThreadMessageParamsSchema = z.object({ threadId: IdSchema, messageId: IdSchema }).strict()

export const EditDmMessageBodySchema = trimTextFields(EditChatMessageRequestSchema, "body")

export const DM_OPEN_RATE_LIMIT = perIdentity({ max: 20, timeWindow: "1 minute" })

export const DM_REACTION_RATE_LIMIT = perIdentity({ max: 60, timeWindow: "1 minute" })
export const DM_MESSAGE_MUTATION_RATE_LIMIT = perIdentity({ max: 30, timeWindow: "1 minute" })

const DM_HISTORY_DEFAULT_LIMIT = 30

export async function registerDmRoutes(app: FastifyInstance, container: Container): Promise<void> {
  const csrfProtect = container.csrf.protect

  function dmRepo(): DmRepository {
    return app.chatOverrides?.dmRepo ?? container.getDmRepo()
  }
  function blocksRepo(): BlocksRepository {
    return app.chatOverrides?.blocksRepo ?? container.getBlocksRepo()
  }

  const peerOf = makeDmPeerOf({ getThread: (threadId) => dmRepo().getThread(threadId) })

  const loadUser: DmUserLookup = async (userId) => {
    const store = app.authServices?.users
    if (!store) return null
    const u = await store.findById(userId)
    if (!u || u.deletedAt !== null) return null
    return {
      id: u.id,
      displayName: u.displayName,
      handle: u.handle,
      bio: null,
      avatarUrl: u.avatarUrl,
      allowDirectMessages: u.allowDirectMessages,
    }
  }

  let mutesRepo: ConversationMutesRepository | undefined
  function mutes(): ConversationMutesRepository | undefined {
    const overrides = app.chatOverrides
    if (overrides) return overrides.conversationMutes
    if (container.env.USE_FAKE_CHAT) return undefined
    return (mutesRepo ??= makeConversationMutesRepository(container.getDb().sql))
  }

  function service(): DmService {
    const conversationMutes = mutes()
    return makeDmService({
      dm: dmRepo(),
      blocks: blocksRepo(),
      loadUser,
      ...(conversationMutes
        ? { isMutedFor: (userId, threadId) => conversationMutes.isMuted(userId, "dm", threadId) }
        : {}),
    })
  }

  async function authorizePeer(threadId: string, userId: string, action: string): Promise<string> {
    const peer = await peerOf(threadId, userId)
    if (peer === null) throw AppError.forbidden(action)
    if (await blocksRepo().isBlockedEitherWay(userId, peer)) throw AppError.forbidden(action)
    return peer
  }

  route(
    app,
    "openDm",
    { preHandler: csrfProtect, config: { rateLimit: DM_OPEN_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(OpenDmRequestSchema, request.body)
      const thread = await service().openDm(userId, body.userId)
      const payload: OpenDmResponse = { thread }
      reply.status(200).send(payload)
    },
  )

  route(app, "dmMessages", async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(DmIdParamsSchema, request.params)
    const q = parse(DmHistoryQuerySchema, request.query)
    await authorizePeer(id, userId, "You can't view this conversation.")

    const limit = q.limit ?? DM_HISTORY_DEFAULT_LIMIT
    const payload: ChatHistoryResponse = await chatHistoryPayload(
      {
        history: (before, pageLimit, around) =>
          dmRepo().history(id, before, pageLimit, userId, around),
        listPins: () => dmRepo().listPins(id, userId),
      },
      q,
      limit,
    )
    reply.status(200).send(payload)
  })

  route(
    app,
    "editDmMessage",
    { preHandler: csrfProtect, config: { rateLimit: DM_MESSAGE_MUTATION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { threadId, messageId } = parse(ThreadMessageParamsSchema, request.params)
      const body = parse(EditDmMessageBodySchema, {
        ...(request.body as object),
        threadId,
        messageId,
      })

      const edits = makeChatEditService({
        dm: dmRepo(),
        dmPeerOf: peerOf,
        isBlockedEitherWay: (a, b) => blocksRepo().isBlockedEitherWay(a, b),
        broadcastEvent: (roomKey, frame) => container.chatService.broadcastEvent?.(roomKey, frame),
      })
      const updated = await edits.editMessage({
        roomKind: "dm",
        roomId: threadId,
        messageId,
        userId,
        body: body.body,
        mentionedUserIds: body.mentionedUserIds,
      })

      void Promise.resolve(
        container.chatService.broadcast(
          roomKeyFor("dm", threadId),
          neutralizeChatViewerFields(updated),
        ),
      ).catch(() => {})

      reply.status(200).send(updated)
    },
  )

  route(
    app,
    "toggleDmMessageReaction",
    { preHandler: csrfProtect, config: { rateLimit: DM_REACTION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { threadId, messageId } = parse(ThreadMessageParamsSchema, request.params)
      const body = parse(ToggleDmMessageReactionRequestSchema, {
        ...(request.body as object),
        threadId,
        messageId,
      })
      const reactions = makeChatReactionService({
        dm: dmRepo(),
        dmPeerOf: peerOf,
        isBlockedEitherWay: (a, b) => blocksRepo().isBlockedEitherWay(a, b),
      })
      const updated = await reactions.toggleDmReaction(threadId, messageId, userId, body.emoji)
      void Promise.resolve(
        container.chatService.broadcastEvent?.(roomKeyFor("dm", threadId), {
          type: "reaction",
          cleanupId: threadId,
          roomKind: "dm",
          message: neutralizeChatViewerFields(updated),
        }),
      ).catch(() => {})
      reply.status(200).send(updated)
    },
  )

  route(
    app,
    "deleteDmMessage",
    { preHandler: csrfProtect, config: { rateLimit: DM_MESSAGE_MUTATION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { threadId, messageId } = parse(ThreadMessageParamsSchema, request.params)
      await authorizePeer(threadId, userId, "You can't delete this message.")

      const tombstone: ChatMessageDTO | null = await dmRepo().softDelete(
        threadId,
        messageId,
        userId,
      )
      if (tombstone === null) {
        const meta = await dmRepo().findMessageMeta(messageId)
        if (
          meta !== null &&
          meta.threadId === threadId &&
          meta.deletedAt !== null &&
          meta.senderId === userId
        ) {
          throw AppError.conflict("This message was already deleted.")
        }
        throw AppError.forbidden("You can't delete this message.")
      }

      const roomView = neutralizeChatViewerFields(tombstone)
      void Promise.resolve(
        container.chatService.broadcast(roomKeyFor("dm", threadId), roomView),
      ).catch(() => {})
      broadcastMessageUpdate(container.chatService, "dm", threadId, roomView)

      reply.status(200).send(tombstone)
    },
  )
}
