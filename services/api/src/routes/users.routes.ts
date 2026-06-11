/**
 * Users / privacy route plugin (DM-adjacent surfaces).
 *
 *   GET    /users/search      [auth][rate-limit]  @handle PREFIX search to start a DM -> SearchUsersResponse.
 *                             Strips a leading `@`; excludes self/no-handle/DM-off/soft-deleted/blocked.
 *   POST   /users/:id/block   [auth][csrf]  block a user -> { blocked:true }.
 *   DELETE /users/:id/block   [auth][csrf]  unblock a user -> { blocked:false }.
 *   GET    /me/blocks         [auth]  the viewer's blocked accounts -> ListBlocksResponse.
 *   PUT    /me/settings       [auth][csrf]  update privacy settings (DM toggle) -> { user }.
 *
 * Search runs over the DB (searchByHandlePrefix). Blocks run through the container's memoized blocks repo
 * (the SAME instance the gateway + threads UNION use). Settings ride the auth bundle's UserStore. The DB
 * handle + seams are reached lazily inside handlers so merely mounting the plugin opens no connection.
 */

import {
  SearchUsersRequestSchema,
  UpdateSettingsRequestSchema,
  IdSchema,
  AppError,
  type SearchUsersResponse,
  type BlockUserResponse,
  type ListBlocksResponse,
  type UpdateSettingsResponse,
} from "@civfix/shared"
import { ZodError, z, type ZodTypeAny } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { csrfProtect } from "../auth/csrf.js"
import { searchByHandlePrefix } from "../services/social-repository.drizzle.js"
import { toUserDTO } from "../auth/auth-services.js"
import type { BlocksRepository } from "../services/blocks-repository.drizzle.js"
import { route } from "../versioning/route.js"

/** Path param schema for the routes that take a user UUID in the URL. */
const UserIdParamsSchema = z.object({ id: IdSchema }).strict()

/** Default + cap for user search (the shared request caps `limit` at 20). */
const USER_SEARCH_DEFAULT_LIMIT = 10

/** Tighter per-IP rate limit for the @handle search surface. 30/min is ample for typeahead. */
export const USER_SEARCH_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const
/** Modest per-IP cap on block/unblock churn — idempotent, but bound abuse below the global ceiling. */
export const BLOCK_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const

export async function registerUsersRoutes(app: FastifyInstance, container: Container): Promise<void> {
  /** The blocks repo: container singleton unless a test injected one via chatOverrides. */
  function blocksRepo(): BlocksRepository {
    return app.chatOverrides?.blocksRepo ?? container.getBlocksRepo()
  }

  // -------------------------------------------------------------------------
  // GET /users/search  [auth]  (rate-limited @handle prefix search)
  // -------------------------------------------------------------------------
  route(
    app,
    "searchUsers",
    { config: { rateLimit: USER_SEARCH_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const q = parse(SearchUsersRequestSchema, request.query)
      // Strip a single leading '@' so "@jane" and "jane" search identically.
      const term = q.q.startsWith("@") ? q.q.slice(1) : q.q
      const limit = q.limit ?? USER_SEARCH_DEFAULT_LIMIT
      // An empty term after stripping the '@' yields no results (the schema already requires min length 1,
      // but a bare "@" reduces to "" — return empty rather than matching everyone).
      const results =
        term.length === 0
          ? []
          : await searchByHandlePrefix(container.getDb().sql, term, userId, limit)
      const payload: SearchUsersResponse = { results }
      reply.status(200).send(payload)
    },
  )

  // -------------------------------------------------------------------------
  // POST /users/:id/block  [auth][csrf]
  // -------------------------------------------------------------------------
  route(app, "blockUser", { preHandler: csrfProtect, config: { rateLimit: BLOCK_RATE_LIMIT } }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(UserIdParamsSchema, request.params)
    if (id === userId) throw AppError.validation({ id: "You cannot block yourself." })
    await assertUserExists(app, id)
    await blocksRepo().block(userId, id)
    const payload: BlockUserResponse = { blocked: true }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // DELETE /users/:id/block  [auth][csrf]
  // -------------------------------------------------------------------------
  route(app, "unblockUser", { preHandler: csrfProtect, config: { rateLimit: BLOCK_RATE_LIMIT } }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(UserIdParamsSchema, request.params)
    await blocksRepo().unblock(userId, id)
    const payload: BlockUserResponse = { blocked: false }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /me/blocks  [auth]
  // -------------------------------------------------------------------------
  route(app, "listBlocks", async (request, reply) => {
    const userId = requireAuth(request)
    const blocked = await blocksRepo().listBlocked(userId)
    const payload: ListBlocksResponse = { blocked }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // PUT /me/settings  [auth][csrf]
  // -------------------------------------------------------------------------
  route(app, "updateSettings", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const body = parse(UpdateSettingsRequestSchema, request.body)
    const store = app.authServices?.users
    if (!store) throw AppError.unauthorized("Authentication required.")
    const updated = await store.updateSettings(userId, {
      ...(body.allowDirectMessages !== undefined
        ? { allowDirectMessages: body.allowDirectMessages }
        : {}),
    })
    const payload: UpdateSettingsResponse = { user: toUserDTO(updated) }
    reply.status(200).send(payload)
  })
}

/** Reject a block toward a missing/soft-deleted user with a 404 (validate the target exists). */
async function assertUserExists(app: FastifyInstance, userId: string): Promise<void> {
  const store = app.authServices?.users
  if (!store) throw AppError.unauthorized("Authentication required.")
  const u = await store.findById(userId)
  if (!u || u.deletedAt !== null) throw AppError.notFound("User not found")
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
