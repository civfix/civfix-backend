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
  IdSchema,
  AppError,
  type OpenDmResponse,
  type ChatHistoryResponse,
  type ChatMessageDTO,
} from "@civfix/shared"
import { ZodError, z, type ZodTypeAny } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { csrfProtect } from "../auth/csrf.js"
import { route } from "../versioning/route.js"
import { roomKeyFor } from "../ws/gateway.js"
import { makeDmService, type DmService, type DmUserLookup } from "../services/dm-service.js"
import type { DmRepository } from "../services/dm-repository.drizzle.js"
import type { BlocksRepository } from "../services/blocks-repository.drizzle.js"

/** Path param schema for the routes that take a thread/user UUID in the URL. */
const DmIdParamsSchema = z.object({ id: IdSchema }).strict()

/** Path-param schema for the edit route (the `:threadId`/`:messageId` segments). */
const DmEditParamsSchema = z.object({ threadId: IdSchema, messageId: IdSchema }).strict()

/**
 * Tighter per-IP rate limit for opening a DM (P2-7 style): a real client opens a handful of threads; 20/min
 * bounds automated thread-spinning while staying ample for normal use.
 */
export const DM_OPEN_RATE_LIMIT = { max: 20, timeWindow: "1 minute" } as const

/** Default DM history page size (shared cap is 50). Matches the cleanup chat default. */
const DM_HISTORY_DEFAULT_LIMIT = 30

export async function registerDmRoutes(app: FastifyInstance, container: Container): Promise<void> {
  /** The dm/blocks repos: container singletons unless a test injected overrides via chatOverrides. */
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

  // -------------------------------------------------------------------------
  // POST /dm  [auth][csrf]  (rate-limited)
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // GET /dm/:id/messages  [auth]  (participant + not-blocked gated)
  // -------------------------------------------------------------------------
  route(app, "dmMessages", async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(DmIdParamsSchema, request.params)
    // Non-strict like the cleanup history query: tolerates the threadId path-param echo the typed client
    // serializes into the query, and coerces `limit`. The authoritative id is the URL path.
    const q = parse(DmHistoryQuerySchema, request.query)

    const repo = dmRepo()
    // Authorize: the viewer must be a participant AND not blocked either way. A single generic 403 so
    // "not a participant" and "blocked" are indistinguishable (no leak).
    //
    // Derive participation from the thread row itself instead of issuing a separate isParticipant query:
    // getThread already returns user_lo/user_hi, and isParticipant's predicate
    // (id = threadId AND (user_lo = userId OR user_hi = userId)) is exactly that membership test, so this
    // is behavior-preserving while removing one redundant dm_threads PK seek (3 gating round-trips -> 2;
    // the block check still needs its own round-trip, it hits a different table).
    const thread = await repo.getThread(id)
    const isParticipant = thread !== null && (thread.userLo === userId || thread.userHi === userId)
    if (!isParticipant) throw AppError.forbidden("You can't view this conversation.")
    const peer = thread.userLo === userId ? thread.userHi : thread.userLo
    if (await blocksRepo().isBlockedEitherWay(userId, peer)) {
      throw AppError.forbidden("You can't view this conversation.")
    }

    const limit = q.limit ?? DM_HISTORY_DEFAULT_LIMIT
    const page = await repo.history(id, q.before, limit)
    const payload: ChatHistoryResponse = { items: page.items, nextCursor: page.nextCursor }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // PATCH /dm/:threadId/messages/:messageId  [auth][csrf]  (sender-only)
  // -------------------------------------------------------------------------
  route(
    app,
    "editDmMessage",
    { preHandler: csrfProtect, config: { rateLimit: DM_OPEN_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { threadId, messageId } = parse(DmEditParamsSchema, request.params)
      // The body schema carries threadId/messageId (the typed client fills the path-param keys); the
      // authoritative ids are the URL path, so stamp them before validating the non-empty, length-bounded body.
      const body = parse(EditChatMessageRequestSchema, { ...(request.body as object), threadId, messageId })

      const repo = dmRepo()
      // Authorize the same way GET history does: the caller must be a thread participant AND not blocked
      // either way. A single generic 403 so "not a participant" and "blocked" are indistinguishable (no leak).
      // Derive participation from the thread row (getThread returns user_lo/user_hi) rather than a separate
      // isParticipant probe — behavior-preserving, one fewer round-trip.
      const thread = await repo.getThread(threadId)
      const isParticipant = thread !== null && (thread.userLo === userId || thread.userHi === userId)
      if (!isParticipant) throw AppError.forbidden("You can't edit this message.")
      const peer = thread.userLo === userId ? thread.userHi : thread.userLo
      if (await blocksRepo().isBlockedEitherWay(userId, peer)) {
        throw AppError.forbidden("You can't edit this message.")
      }

      // Sender-only edit: the repo's WHERE gates on (id, thread_id, sender_id, not soft-deleted), so a null
      // return means the message is missing OR not the caller's. Map both to a generic 403 (we already proved
      // the caller is a participant of the thread above, so a wrong/foreign messageId is an authorization miss,
      // not a route 404).
      const updated: ChatMessageDTO | null = await repo.editMessage(threadId, messageId, userId, body.body)
      if (updated === null) throw AppError.forbidden("You can't edit this message.")

      // REALTIME: re-broadcast the edited message over the SAME dm room + SAME {type:"message"} frame the
      // gateway's `send` uses to fan out a new DM (chatService.broadcast publishes {type:"message", message}).
      // Connected clients already upsert incoming `message` frames by id, so they replace the old bubble with
      // the edited body + editedAt — no new ws frame type. Unlike the gateway send we exclude NO connection:
      // the editor's other devices (and the editor's current HTTP request has no socket here) should all see
      // the update; the editor reconciles its own view from this 200 response. Best-effort + fire-and-forget:
      // a fan-out failure must never fail the edit, so we void the broadcast and swallow errors (mirrors the
      // discussion route's HTTP-side broadcast).
      void Promise.resolve(
        container.chatService.broadcast(roomKeyFor("dm", threadId), updated),
      ).catch(() => {})

      reply.status(200).send(updated)
    },
  )
}

/**
 * Validate `data` against a Zod schema, throwing AppError.validation (422 with field details) on failure
 * so the canonical envelope is returned instead of a generic 500. Mirrors the other route plugins.
 */
function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  try {
    return schema.parse(data)
  } catch (err) {
    if (err instanceof ZodError) {
      const fields: Record<string, string> = {}
      for (const issue of err.issues) {
        const key = issue.path.length > 0 ? issue.path.join(".") : "_"
        fields[key] = issue.message
      }
      throw AppError.validation(fields)
    }
    throw err
  }
}
