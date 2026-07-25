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
import { parse } from "./_validate.js"
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
import { chatHistoryPayload } from "./chat-route-helpers.js"

/** Path param schema for routes taking a thread/user UUID in the URL. */
const DmIdParamsSchema = z.object({ id: IdSchema }).strict()

/** Path-param schema for the per-message routes (edit / react / delete share the `:threadId`/`:messageId` shape). */
const ThreadMessageParamsSchema = z.object({ threadId: IdSchema, messageId: IdSchema }).strict()

/**
 * Tighter per-IP rate limit for opening a DM (P2-7 style): a real client opens a handful of threads; 20/min
 * bounds automated thread-spinning while staying ample for normal use.
 */
const DM_OPEN_RATE_LIMIT = { max: 20, timeWindow: "1 minute" } as const

/**
 * The per-message DM routes are NOT thread-opens and must not share openDm's bucket: the global key is
 * the IP (plugins/rate-limit rateLimitKey), so 20/min throttled an engaged reader tapping reactions down
 * a conversation — a NAT'd household first. These match the equivalent per-room routes exactly: 60/min
 * for reactions (chat.routes CHAT_REACTION_RATE_LIMIT / report-chat REPORT_REACTION_RATE_LIMIT) and
 * 30/min for the state changes (messages.routes EDIT_MESSAGE_RATE_LIMIT / chat.routes' delete cap).
 */
const DM_REACTION_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const
const DM_MESSAGE_MUTATION_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const

/** Default DM history page size (shared cap is 50). Matches the cleanup chat default. */
const DM_HISTORY_DEFAULT_LIMIT = 30

export async function registerDmRoutes(app: FastifyInstance, container: Container): Promise<void> {
  const csrfProtect = container.csrf.protect

  function dmRepo(): DmRepository {
    return app.chatOverrides?.dmRepo ?? container.getDmRepo()
  }
  function blocksRepo(): BlocksRepository {
    return app.chatOverrides?.blocksRepo ?? container.getBlocksRepo()
  }

  /** Thread-loading peer resolution, single-sourced with the gateway/edit/react lanes (services/dm-peer). */
  const peerOf = makeDmPeerOf({ getThread: (threadId) => dmRepo().getThread(threadId) })

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

  /**
   * The per-conversation mute store (D-E1) behind OpenDmResponse.thread.muted. Without it openDm reported
   * `muted: false` unconditionally, so reopening a MUTED thread showed it unmuted until the inbox
   * refreshed. Same override stance as the repos above, plus the all-fakes dev path: with chatOverrides
   * present but no mutes fake — or under USE_FAKE_CHAT — there is no store and the lookup is skipped
   * (fail open to unmuted, matching the threads inbox) rather than reaching getDb().
   */
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

  /**
   * Authorize the viewer for a thread (history/edit/delete share this): they must be a participant AND not
   * blocked either way. Returns the peer id on success; throws a single generic 403 so "not a participant"
   * and "blocked" are indistinguishable (no leak). Derives participation from the thread row itself
   * (getThread returns user_lo/user_hi) so no separate isParticipant round-trip is needed.
   */
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
    // `around` (P2 2.4) centers the page on a target message (schema rejects around+before together);
    // the pins/prevCursor page contract lives in chatHistoryPayload.
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

  // Sender-only edit, delegated to the unified chat-edit-service (P0 Task 0.2): the full gate ladder
  // (room-ref 404, not_sender 403, deleted 409, kind 422, edit window 403, peer + block re-check, slur
  // filter) plus the {type:"message_update"} broadcast live there. Route shape/response unchanged.
  route(
    app,
    "editDmMessage",
    { preHandler: csrfProtect, config: { rateLimit: DM_MESSAGE_MUTATION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { threadId, messageId } = parse(ThreadMessageParamsSchema, request.params)
      // The body schema carries threadId/messageId (the typed client fills the path-param keys); the
      // authoritative ids are the URL path, so stamp them before validating the bounded body.
      const body = parse(EditChatMessageRequestSchema, { ...(request.body as object), threadId, messageId })

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

      // LEGACY REALTIME compat: also re-broadcast the SAME {type:"message"} dm frame the gateway `send`
      // uses, so pre-message_update clients still upsert the edit by id (the editor reconciles from this
      // 200 response). Best-effort fire-and-forget. Removed once P0 clients are everywhere.
      void Promise.resolve(
        container.chatService.broadcast(roomKeyFor("dm", threadId), updated),
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
      // DM-only build: the cleanup-chat deps are omitted (this route never toggles a cleanup reaction).
      const reactions = makeChatReactionService({
        dm: dmRepo(),
        dmPeerOf: peerOf,
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
    { preHandler: csrfProtect, config: { rateLimit: DM_MESSAGE_MUTATION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { threadId, messageId } = parse(ThreadMessageParamsSchema, request.params)
      await authorizePeer(threadId, userId, "You can't delete this message.")

      const tombstone: ChatMessageDTO | null = await dmRepo().softDelete(threadId, messageId, userId)
      if (tombstone === null) {
        // Same idempotency stance as the room delete routes (chat-route-helpers deleteMessageWithPowers):
        // a sender retrying a delete that already landed gets 409 rather than a misleading 403. Only the
        // row's own sender learns the difference; everything else keeps the generic 403.
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

      void Promise.resolve(
        container.chatService.broadcast(roomKeyFor("dm", threadId), tombstone),
      ).catch(() => {})
      // P0: {type:"message_update"} with the tombstoned DTO so connected clients drop the bubble live
      // (previously they only learned of a delete on refetch). Best-effort, alongside the legacy frame.
      broadcastMessageUpdate(container.chatService, "dm", threadId, tombstone)

      reply.status(200).send(tombstone)
    },
  )
}
