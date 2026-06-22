/**
 * Direct-message route plugin (1:1 DMs).
 *
 *   POST /dm                [auth][csrf][rate-limit]  open (or fetch) the DM thread with a user.
 *                           Idempotent. 404 missing/deleted target; 403 self / blocked / DM-disabled
 *                           (the 403s share one generic message so block and DM-off are indistinguishable).
 *   GET  /dm/:id/messages   [auth]  DM history (mirrors GET /cleanups/:id/messages). Authorized: the viewer
 *                           must be a thread participant AND not blocked either way, else 403.
 *
 * The dm + blocks repos come from the container's memoized singletons (Drizzle in prod, in-memory in the
 * all-fakes dev path), the SAME instances the WS gateway and the threads UNION use, so an open-then-chat
 * flow is consistent across HTTP + WS. The target-user lookup rides the auth bundle's UserStore (which now
 * reads allow_direct_messages). Tests inject the repos via chatOverrides.
 */

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
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { csrfProtect } from "../auth/csrf.js"
import { parse } from "./_validate.js"
import { route } from "../versioning/route.js"
import { roomKeyFor } from "../ws/gateway.js"
import { makeDmService, type DmService, type DmUserLookup } from "../services/dm-service.js"
import { makeChatReactionService } from "../services/chat-reaction-service.js"
import { assertNoSlur } from "../abuse/slur-filter.js"
import type { DmRepository, DmThread } from "../services/dm-repository.drizzle.js"
import type { BlocksRepository } from "../services/blocks-repository.drizzle.js"

/** Path param schema for routes taking a thread/user UUID in the URL. */
const DmIdParamsSchema = z.object({ id: IdSchema }).strict()

/** Path-param schema for the per-message routes (edit / react / delete share the `:threadId`/`:messageId` shape). */
const ThreadMessageParamsSchema = z.object({ threadId: IdSchema, messageId: IdSchema }).strict()

/**
 * Tighter per-IP rate limit for opening a DM (P2-7 style): a real client opens a handful of threads; 20/min
 * bounds automated thread-spinning while staying ample for normal use.
 */
export const DM_OPEN_RATE_LIMIT = { max: 20, timeWindow: "1 minute" } as const

/** Default DM history page size (shared cap is 50). Matches the cleanup chat default. */
const DM_HISTORY_DEFAULT_LIMIT = 30

/** The OTHER participant of a thread (for the block check), or null when `userId` is not in it. */
function peerOf(thread: DmThread, userId: string): string | null {
  if (thread.userLo === userId) return thread.userHi
  if (thread.userHi === userId) return thread.userLo
  return null
}

export async function registerDmRoutes(app: FastifyInstance, container: Container): Promise<void> {
  function dmRepo(): DmRepository {
    return app.chatOverrides?.dmRepo ?? container.getDmRepo()
  }
  function blocksRepo(): BlocksRepository {
    return app.chatOverrides?.blocksRepo ?? container.getBlocksRepo()
  }

  /** Load a non-deleted target user (with their DM toggle) from the auth bundle's UserStore. */
  const loadUser: DmUserLookup = async (userId) => {
    const store = app.authServices?.users
    if (!store) return null
    const u = await store.findById(userId)
    if (!u || u.deletedAt !== null) return null
    return {
      id: u.id,
      displayName: u.displayName,
      handle: u.handle,
      // The UserStore record carries no bio; the peer PersonDTO tolerates a null bio.
      bio: null,
      avatarUrl: u.avatarUrl,
      allowDirectMessages: u.allowDirectMessages,
    }
  }

  function service(): DmService {
    return makeDmService({ dm: dmRepo(), blocks: blocksRepo(), loadUser })
  }

  /**
   * Authorize the viewer for a thread (history/edit/delete share this): they must be a participant AND not
   * blocked either way. Returns the peer id on success; throws a single generic 403 so "not a participant"
   * and "blocked" are indistinguishable (no leak). Derives participation from the thread row itself
   * (getThread returns user_lo/user_hi) so no separate isParticipant round-trip is needed.
   */
  async function authorizePeer(threadId: string, userId: string, action: string): Promise<string> {
    const thread = await dmRepo().getThread(threadId)
    const peer = thread !== null ? peerOf(thread, userId) : null
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

  // Participant + not-blocked gated; derives participation from the thread row (one fewer round-trip).
  route(app, "dmMessages", async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(DmIdParamsSchema, request.params)
    // Non-strict like the cleanup history query: tolerates the threadId path-param echo the typed client
    // serializes into the query, and coerces `limit`. The authoritative id is the URL path.
    const q = parse(DmHistoryQuerySchema, request.query)
    await authorizePeer(id, userId, "You can't view this conversation.")

    const limit = q.limit ?? DM_HISTORY_DEFAULT_LIMIT
    // Pass the viewer so each message's reactions resolve the viewer's own `mine` flag on the first page.
    const page = await dmRepo().history(id, q.before, limit, userId)
    const payload: ChatHistoryResponse = { items: page.items, nextCursor: page.nextCursor }
    reply.status(200).send(payload)
  })

  // Sender-only edit (the repo's WHERE gates on sender_id); a null return is mapped to a generic 403.
  route(
    app,
    "editDmMessage",
    { preHandler: csrfProtect, config: { rateLimit: DM_OPEN_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { threadId, messageId } = parse(ThreadMessageParamsSchema, request.params)
      // The body schema carries threadId/messageId (the typed client fills the path-param keys); the
      // authoritative ids are the URL path, so stamp them before validating the bounded body.
      const body = parse(EditChatMessageRequestSchema, { ...(request.body as object), threadId, messageId })
      // Hate-slur content gate (App Store 1.2a) on the edited DM body — mirrors discussion-service.editMessage.
      assertNoSlur(body.body, "body")

      await authorizePeer(threadId, userId, "You can't edit this message.")
      const updated = await dmRepo().editMessage(threadId, messageId, userId, body.body)
      if (updated === null) throw AppError.forbidden("You can't edit this message.")

      // REALTIME: re-broadcast over the SAME {type:"message"} dm frame the gateway `send` uses; clients
      // upsert by id (the editor reconciles from this 200 response). Best-effort fire-and-forget.
      void Promise.resolve(
        container.chatService.broadcast(roomKeyFor("dm", threadId), updated),
      ).catch(() => {})

      reply.status(200).send(updated)
    },
  )

  route(
    app,
    "toggleDmMessageReaction",
    { preHandler: csrfProtect, config: { rateLimit: DM_OPEN_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { threadId, messageId } = parse(ThreadMessageParamsSchema, request.params)
      const body = parse(ToggleDmMessageReactionRequestSchema, {
        ...(request.body as object),
        threadId,
        messageId,
      })
      const repo = dmRepo()
      // DM-only build: the cleanup-chat deps are omitted (this route never toggles a cleanup reaction).
      const reactions = makeChatReactionService({
        dm: repo,
        dmPeerOf: async (tid, uid) => {
          const t = await repo.getThread(tid)
          return t !== null ? peerOf(t, uid) : null
        },
        isBlockedEitherWay: (a, b) => blocksRepo().isBlockedEitherWay(a, b),
      })
      const updated = await reactions.toggleDmReaction(threadId, messageId, userId, body.emoji)
      // REALTIME: fan a {type:"reaction"} frame (roomKind:"dm") to the thread so connected sockets re-render.
      void Promise.resolve(
        container.chatService.broadcastEvent?.(roomKeyFor("dm", threadId), {
          type: "reaction",
          cleanupId: threadId,
          roomKind: "dm",
          message: updated,
        }),
      ).catch(() => {})
      reply.status(200).send(updated)
    },
  )

  // Author self-delete: sender-only via the repo WHERE gate; a null return is a generic 403.
  route(
    app,
    "deleteDmMessage",
    { preHandler: csrfProtect, config: { rateLimit: DM_OPEN_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { threadId, messageId } = parse(ThreadMessageParamsSchema, request.params)
      await authorizePeer(threadId, userId, "You can't delete this message.")

      const tombstone: ChatMessageDTO | null = await dmRepo().softDelete(threadId, messageId, userId)
      if (tombstone === null) throw AppError.forbidden("You can't delete this message.")

      void Promise.resolve(
        container.chatService.broadcast(roomKeyFor("dm", threadId), tombstone),
      ).catch(() => {})

      reply.status(200).send(tombstone)
    },
  )
}
