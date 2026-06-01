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
import { registerChatGateway, type IsMemberFn } from "../ws/gateway.js"
import { makeDrizzleCleanupRepository } from "../services/cleanup-repository.drizzle.js"
import { makeDrizzleThreadsRepository } from "../services/threads-repository.drizzle.js"
import {
  makeThreadsService,
  InMemoryChatReadState,
  type ChatReadState,
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

  // The shared read-state store (process-local in Phase 1; see threads-service.ts). One instance backs
  // both the gateway `ack` writes and the threads `unread` reads so they agree within a process.
  const readState: ChatReadState = overrides?.readState ?? new InMemoryChatReadState()

  // Membership probe: injected (tests) or the Drizzle cleanup repo's isMember (production). Built lazily
  // so merely registering the plugin opens no DB connection.
  const isMember: IsMemberFn = overrides
    ? overrides.isMember
    : (cleanupId, userId) => makeDrizzleCleanupRepository(container.getDb().sql).isMember(cleanupId, userId)

  // -------------------------------------------------------------------------
  // GET /ws  (WebSocket upgrade; dual handshake auth inside the gateway)
  // -------------------------------------------------------------------------
  registerChatGateway(app, {
    chat: container.chatService,
    isMember,
    sessions: app.authServices?.sessions,
    markRead: (cleanupId, userId, _upToId) => readState.markRead(cleanupId, userId, new Date()),
    // Anti-CSWSH: the gateway rejects a cross-site upgrade Origin not in the WEB_ORIGINS allowlist.
    webOrigins: container.env.WEB_ORIGINS,
  })

  // -------------------------------------------------------------------------
  // GET /threads  [auth]
  // -------------------------------------------------------------------------
  app.get("/threads", async (request, reply) => {
    const userId = requireAuth(request)
    const pagination = parse(PaginationQuerySchema, request.query)
    const threadsRepo: ThreadsRepository = overrides
      ? overrides.threadsRepo
      : makeDrizzleThreadsRepository(container.getDb().sql)
    const threads = makeThreadsService({ repo: threadsRepo, readState })
    const result = await threads.listThreads(userId, pagination.limit)
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
