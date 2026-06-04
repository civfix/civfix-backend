/**
 * Cleanup route plugin.
 *
 *   POST /cleanups               [auth][csrf]        create a cleanup (organizer auto-joins).
 *   GET  /cleanups               [anon-ok]           list cleanups (when/bbox/near filters, cursor paged).
 *   GET  /cleanups/:id           [anon-ok]           fetch one cleanup.
 *   POST /cleanups/:id/join      [auth][csrf]        join (idempotent); returns {joined, going}.
 *   POST /cleanups/:id/leave     [auth][csrf]        leave (organizer cannot leave); returns {joined, going}.
 *   GET  /cleanups/:id/messages  [auth][MEMBER-gated] chat history -> ChatHistoryResponse.
 *
 * Bodies/params/queries are validated against the @civfix/shared Zod schemas via the same `parse` ->
 * AppError.validation pattern as the other routes. The DB handle + seams are reached lazily inside
 * handlers (via container) so merely mounting the plugin opens no connection.
 *
 * The cleanup service is built per request from either an injected override (tests: an in-memory repo so
 * the whole flow runs offline) or from the container (production: the Drizzle/PostGIS repo). The
 * member-gated history reads through container.chatService (the real WsChatService or the fake).
 */

import {
  CreateCleanupRequestSchema,
  ListCleanupsRequestSchema,
  ChatHistoryQuerySchema,
  IdSchema,
  AppError,
  type CleanupDTO,
  type GetCleanupResponse,
  type JoinCleanupResponse,
  type LeaveCleanupResponse,
  type ChatHistoryResponse,
} from "@civfix/shared"
import { ZodError, z, type ZodTypeAny } from "zod"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { csrfProtect } from "../auth/csrf.js"
import {
  makeCleanupService,
  type CleanupRepository,
  type CleanupService,
  type CleanupServiceDeps,
  type CleanupViewer,
} from "../services/cleanup-service.js"
import { makeDrizzleCleanupRepository } from "../services/cleanup-repository.drizzle.js"
import { BBoxQueryParam, LatLngQueryParam } from "./query-encoding.js"

/**
 * Optional injected cleanup-service dependencies (tests). When present the routes build the service from
 * these instead of the container, so the whole create/list/get/join/leave/history HTTP flow runs offline
 * (no Docker). The same repo backs the member-gated history check. In production it is left unset and the
 * routes build the Drizzle-backed repo lazily.
 */
export interface CleanupServiceOverrides {
  repo: CleanupRepository
  newId?: CleanupServiceDeps["newId"]
  now?: CleanupServiceDeps["now"]
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected cleanup-service overrides (tests). See CleanupServiceOverrides. */
    cleanupOverrides?: CleanupServiceOverrides
  }
}

/** Path param schema for the routes that take a cleanup UUID in the URL. */
const CleanupIdParamsSchema = z.object({ id: IdSchema }).strict()

/**
 * Query schema for GET /cleanups, decoding EXACTLY what the shared client sends (see
 * ./query-encoding.ts): optional bbox + optional near each as a single JSON-encoded object param, and
 * scalar when/cursor/limit. We decode bbox/near here, then re-validate the assembled object against the
 * shared nested ListCleanupsRequest so the wire contract stays the single source of truth — including
 * the `limit` coercion, so `limit` is passed through as a raw string here rather than coerced twice.
 * (NOT .strict(); the re-validation against the shared .strict() schema is the gate.)
 */
const ListCleanupsQuerySchema = z.object({
  bbox: BBoxQueryParam.optional(),
  near: LatLngQueryParam.optional(),
  when: z.enum(["upcoming", "past"]).optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
})

/** Default history page size when GET /cleanups/:id/messages omits `limit` (shared cap is 50). */
const HISTORY_DEFAULT_LIMIT = 30

export async function registerCleanupRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the cleanup repository from injected overrides (tests) or the container DB (production). */
  function repo(): CleanupRepository {
    const overrides = app.cleanupOverrides
    if (overrides) return overrides.repo
    return makeDrizzleCleanupRepository(container.getDb().sql)
  }

  /** Build the cleanup service over the resolved repository. */
  function service(): CleanupService {
    const overrides = app.cleanupOverrides
    return makeCleanupService({
      repo: repo(),
      ...(overrides?.newId !== undefined ? { newId: overrides.newId } : {}),
      ...(overrides?.now !== undefined ? { now: overrides.now } : {}),
    })
  }

  // -------------------------------------------------------------------------
  // POST /cleanups  [auth][csrf]
  // -------------------------------------------------------------------------
  app.post("/cleanups", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const body = parse(CreateCleanupRequestSchema, request.body)
    const dto: CleanupDTO = await service().createCleanup(body, userId)
    reply.status(201).send(dto)
  })

  // -------------------------------------------------------------------------
  // GET /cleanups  (anon-ok)
  // -------------------------------------------------------------------------
  app.get("/cleanups", async (request, reply) => {
    const q = parse(ListCleanupsQuerySchema, request.query)
    // Re-validate the decoded shape against the shared schema (single source of truth). bbox/near are
    // already decoded BBox/LatLng objects (or undefined); when/cursor/limit are scalars.
    const validated = parse(ListCleanupsRequestSchema, {
      ...(q.bbox !== undefined ? { bbox: q.bbox } : {}),
      ...(q.near !== undefined ? { near: q.near } : {}),
      ...(q.when !== undefined ? { when: q.when } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    })
    const payload = await service().listCleanups(validated, viewerOf(request))
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /cleanups/:id  (anon-ok)
  // -------------------------------------------------------------------------
  app.get("/cleanups/:id", async (request, reply) => {
    const { id } = parse(CleanupIdParamsSchema, request.params)
    const dto: GetCleanupResponse = await service().getCleanup(id, viewerOf(request))
    reply.status(200).send(dto)
  })

  // -------------------------------------------------------------------------
  // POST /cleanups/:id/join  [auth][csrf]
  // -------------------------------------------------------------------------
  app.post("/cleanups/:id/join", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(CleanupIdParamsSchema, request.params)
    const payload: JoinCleanupResponse = await service().joinCleanup(id, userId)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /cleanups/:id/leave  [auth][csrf]
  // -------------------------------------------------------------------------
  app.post("/cleanups/:id/leave", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(CleanupIdParamsSchema, request.params)
    const payload: LeaveCleanupResponse = await service().leaveCleanup(id, userId)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /cleanups/:id/messages  [auth][MEMBER-gated]
  // -------------------------------------------------------------------------
  app.get("/cleanups/:id/messages", async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(CleanupIdParamsSchema, request.params)
    // Shared non-strict ChatHistoryQuerySchema: tolerates and strips the cleanupId path-param echo the
    // typed client still serializes into the query, and coerces `limit`. The authoritative id is the
    // URL path; only `before` (cursor) and `limit` are read here.
    const q = parse(ChatHistoryQuerySchema, request.query)

    // Membership gate: only a cleanup member may read the room history. A non-member gets a 403 (the
    // cleanup's existence is not secret - it is listed on the public map - so 403, not 404).
    const isMember = await repo().isMember(id, userId)
    if (!isMember) throw AppError.forbidden("You are not a member of this cleanup.")

    const limit = q.limit ?? HISTORY_DEFAULT_LIMIT
    const page = await container.chatService.history(id, q.before, limit)
    const payload: ChatHistoryResponse = { items: page.items, nextCursor: page.nextCursor }
    reply.status(200).send(payload)
  })
}

/** Derive the viewer context (signed-in user id, or null) from the resolved auth on the request. */
function viewerOf(request: FastifyRequest): CleanupViewer {
  return { userId: request.auth?.userId ?? null }
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
