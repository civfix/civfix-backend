/**
 * Chat route plugin: the WebSocket upgrade (GET /ws) and the threads list (GET /threads).
 *
 *   GET /ws        the WebSocket chat gateway. Dual handshake auth (session cookie OR ?token=<bearer>),
 *                  then membership-gated join/send + live fan-out. See ws/gateway.ts.
 *   GET /threads   [auth]  the viewer's cleanup chat threads as MessageThreadDTO (title/last/ago/unread/
 *                  members/lastFromMe).
 *
 * @fastify/websocket is registered here (once) so GET /ws can upgrade. The gateway's membership probe and
 * the threads aggregates both come from the cleanups/threads seams: in production the Drizzle-backed
 * repos over the lazily-created DB handle; in tests an injected override bundle so the whole gateway +
 * threads flow runs offline. A single ChatReadState instance is shared between the gateway's `ack`
 * handler (writes the read watermark) and the threads service (reads it for unread counts).
 */

import fastifyWebsocket from "@fastify/websocket"
import {
  PaginationQuerySchema,
  AppError,
  type ListThreadsResponse,
} from "@civfix/shared"
import { ZodError, type z, type ZodTypeAny } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { route } from "../versioning/route.js"
import {
  registerChatGateway,
  type GatewayDmDeps,
  type IsBlockedEitherWayFn,
  type IsMemberFn,
} from "../ws/gateway.js"
import { makeDrizzleCleanupRepository } from "../services/cleanup-repository.drizzle.js"
import { makeDrizzleThreadsRepository } from "../services/threads-repository.drizzle.js"
import { makeDrizzleChatReadState } from "../services/chat-read-state.drizzle.js"
import type { DmRepository } from "../services/dm-repository.drizzle.js"
import type { BlocksRepository } from "../services/blocks-repository.drizzle.js"
import {
  InMemoryChatPresence,
  RedisChatPresence,
  type ChatPresence,
} from "../adapters/chat-presence.js"
import {
  makeThreadsService,
  InMemoryChatReadState,
  THREADS_DEFAULT_LIMIT,
  type ChatReadState,
  type DmThreadsSource,
  type ThreadsRepository,
} from "../services/threads-service.js"

/**
 * Optional injected chat/threads dependencies (tests). When present the gateway + threads routes use
 * these instead of the container DB seams, so the WS gateway and GET /threads run offline. The same
 * isMember probe gates the gateway; the same readState backs both unread counts and the `ack` watermark.
 */
export interface ChatGatewayOverrides {
  isMember: IsMemberFn
  threadsRepo: ThreadsRepository
  readState?: ChatReadState
  presence?: ChatPresence
  /** Injected DM repository (tests/dev): backs the gateway dm seam + the threads UNION + the dm routes. */
  dmRepo?: DmRepository
  /** Injected blocks repository (tests/dev): backs the gateway block check + the block routes. */
  blocksRepo?: BlocksRepository
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected chat/threads overrides (tests). See ChatGatewayOverrides. */
    chatOverrides?: ChatGatewayOverrides
  }
}

export async function registerChatRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  // Register the websocket plugin once so GET /ws can upgrade. maxPayload bounds an oversized frame.
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 64 * 1024 },
  })

  const overrides = app.chatOverrides

  // The shared read-state store. In production it is DB-backed (cleanup_members.last_read_at) so unread
  // counts decrement on read AND survive a restart / span instances; in the all-fakes dev/test path
  // (USE_FAKE_CHAT, no DB) it is process-local. One instance backs both the gateway `ack` writes and the
  // threads `unread` reads so they agree.
  const readState: ChatReadState =
    overrides?.readState ??
    (container.env.USE_FAKE_CHAT
      ? new InMemoryChatReadState()
      : makeDrizzleChatReadState(container.getDb().sql))

  // The presence registry powers the live "N online" snapshot/deltas. Redis-backed in production (shared
  // source of truth across workers, self-healing via the heartbeat); in-memory in the all-fakes path.
  const presence: ChatPresence =
    overrides?.presence ??
    (container.env.USE_FAKE_CHAT
      ? new InMemoryChatPresence()
      : new RedisChatPresence(container.getRedis()))

  // Membership probe: injected (tests) or the Drizzle cleanup repo's isMember (production). Built lazily
  // so merely registering the plugin opens no DB connection.
  const isMember: IsMemberFn = overrides
    ? overrides.isMember
    : (cleanupId, userId) => makeDrizzleCleanupRepository(container.getDb().sql).isMember(cleanupId, userId)

  // DM + blocks seams. Tests inject them through the overrides; otherwise they come from the container's
  // MEMOIZED singletons (Drizzle-backed in production, in-memory in the all-fakes dev path), so the
  // gateway, the threads UNION, and the dm/block routes all share the SAME store. A partial override is
  // allowed (a test may inject only one); the other falls back to the container singleton.
  const blocksRepo: BlocksRepository = overrides?.blocksRepo ?? container.getBlocksRepo()
  const dmRepo: DmRepository = overrides?.dmRepo ?? container.getDmRepo()

  // The DM read watermark resolves an acked message's created_at scoped to the thread (mirrors the cleanup
  // resolveReadAt below); a foreign/unknown id falls back to now() so a stray ack still advances liveness.
  const dmGatewayDeps: GatewayDmDeps = {
    isParticipant: (threadId, userId) => dmRepo.isParticipant(threadId, userId),
    peerOf: async (threadId, userId) => {
      const t = await dmRepo.getThread(threadId)
      if (t === null) return null
      if (t.userLo === userId) return t.userHi
      if (t.userHi === userId) return t.userLo
      return null
    },
    persist: (input) => dmRepo.persist(input),
    markRead: async (threadId, userId, upToId) => {
      const at = (await dmRepo.resolveMessageCreatedAt(threadId, upToId)) ?? new Date()
      await dmRepo.markRead(threadId, userId, at)
    },
  }
  const isBlockedEitherWay: IsBlockedEitherWayFn = (a, b) => blocksRepo.isBlockedEitherWay(a, b)

  // The DM half of the inbox: a thin source over the dm repo's listThreadsForUser, merged with cleanup
  // threads by the threads service.
  const dmThreadsSource: DmThreadsSource = {
    listDmThreadsFor: (userId) => dmRepo.listThreadsForUser(userId),
  }

  // Resolve the read watermark for an `ack`: the created_at of the acked message (upToId), NOT the
  // server's wall clock. Stamping now() would push the watermark past the acked message and silently mark
  // a message that arrived in the ack's debounce/network window as read (undercounting unread). Anchoring
  // to the message's own timestamp marks read EXACTLY up to what the client acked; a later message stays
  // unread until its own ack. The lookup is a partition-wise PK seek on chat_messages(id, ...), scoped to
  // the room for safety; a foreign/unknown id falls back to now() so a stray ack still advances liveness.
  // In the all-fakes dev path (no DB) we cannot resolve it, so we use now() (unread precision is moot in
  // dev). Reads come off the lazily-created DB handle, so this opens no connection until an ack lands.
  const resolveReadAt: (cleanupId: string, upToId: string) => Promise<Date> = container.env.USE_FAKE_CHAT
    ? () => Promise.resolve(new Date())
    : async (cleanupId, upToId) => {
        const rows = await container.getDb().sql<{ created_at: Date }[]>`
          SELECT created_at FROM chat_messages WHERE id = ${upToId} AND cleanup_id = ${cleanupId} LIMIT 1
        `
        return rows[0]?.created_at ?? new Date()
      }

  // -------------------------------------------------------------------------
  // GET /ws  (WebSocket upgrade; dual handshake auth inside the gateway)
  // -------------------------------------------------------------------------
  registerChatGateway(app, {
    chat: container.chatService,
    isMember,
    sessions: app.authServices?.sessions,
    markRead: async (cleanupId, userId, upToId) => {
      const at = await resolveReadAt(cleanupId, upToId)
      await readState.markRead(cleanupId, userId, at)
    },
    presence,
    // DM routing: the gateway uses these for `roomKind:"dm"` frames (participant + not-blocked gating,
    // persist, dm read-state). Cleanup group chat is unaffected.
    dm: dmGatewayDeps,
    isBlockedEitherWay,
    // Anti-CSWSH: the gateway rejects a cross-site upgrade Origin not in the WEB_ORIGINS allowlist.
    webOrigins: container.env.WEB_ORIGINS,
  })

  // -------------------------------------------------------------------------
  // GET /threads  [auth]
  // -------------------------------------------------------------------------
  route(app, "listThreads", async (request, reply) => {
    const userId = requireAuth(request)
    const pagination = parse(PaginationQuerySchema, request.query)
    // The shared limit is optional with no baked-in default (each resource owns its page size), so apply
    // the threads default explicitly rather than passing undefined down to the repo's SQL LIMIT.
    const limit = pagination.limit ?? THREADS_DEFAULT_LIMIT
    const threadsRepo: ThreadsRepository = overrides
      ? overrides.threadsRepo
      : makeDrizzleThreadsRepository(container.getDb().sql)
    // Merge cleanup threads with the viewer's DM threads (the dm source already excludes blocked-either-way
    // threads + computes peer/last/unread).
    const threads = makeThreadsService({ repo: threadsRepo, readState, dm: dmThreadsSource })
    const result = await threads.listThreads(userId, limit)
    const payload: ListThreadsResponse = { items: result.items, nextCursor: result.nextCursor }
    reply.status(200).send(payload)
  })
}

/**
 * Validate `data` against a Zod schema, throwing AppError.validation (422 with field details) on
 * failure so the canonical envelope is returned instead of a generic 500. Mirrors the other routes.
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
