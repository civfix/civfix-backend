/**
 * Social route plugin.
 *
 *   GET    /people            [anon-ok]    list/search people (q, cursor) -> ListPeopleResponse.
 *   POST   /people/:id/follow [auth][csrf] follow a person (idempotent) -> FollowPersonResponse.
 *   DELETE /people/:id/follow [auth][csrf] unfollow a person -> FollowPersonResponse.
 *   GET    /people/:id        [anon-ok]    a person's public profile -> GetProfileResponse.
 *   GET    /me/profile        [auth]       the signed-in user's own profile -> GetProfileResponse.
 *
 * Bodies/params/queries are validated against the @civfix/shared Zod schemas via the same `parse` ->
 * AppError.validation pattern as the other routes. The DB handle + seams are reached lazily inside
 * handlers (via container) so merely mounting the plugin opens no connection.
 *
 * The social service is built per request from either injected overrides (tests: an in-memory repo + a
 * spy/real notifier so the whole flow runs offline) or from the container (production: the Drizzle repo +
 * the notification service as the new_follower notifier). On a NEW follow the service fires a new_follower
 * notification through the notifier.
 */

import {
  ListPeopleRequestSchema,
  IdSchema,
  AppError,
  type ListPeopleResponse,
  type FollowPersonResponse,
  type GetProfileResponse,
} from "@civfix/shared"
import { ZodError, z, type ZodTypeAny } from "zod"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { csrfProtect } from "../auth/csrf.js"
import {
  makeSocialService,
  type SocialNotifier,
  type SocialRepository,
  type SocialService,
  type SocialViewer,
} from "../services/social-service.js"
import { makeDrizzleSocialRepository } from "../services/social-repository.drizzle.js"
import { makeNotificationService } from "../services/notification-service.js"
import { makeDrizzleNotificationRepository } from "../services/notification-repository.drizzle.js"

/**
 * Optional injected social-service dependencies (tests). When present the routes build the service from
 * these instead of the container, so the whole list/follow/profile HTTP flow runs offline (no Docker). The
 * notifier (the new_follower hook) can be a spy. In production it is left unset and the routes build the
 * Drizzle-backed repo + the notification service as the notifier lazily.
 */
export interface SocialServiceOverrides {
  repo: SocialRepository
  notifier?: SocialNotifier
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected social-service overrides (tests). See SocialServiceOverrides. */
    socialOverrides?: SocialServiceOverrides
  }
}

/** Path param schema for the routes that take a person UUID in the URL. */
const PersonIdParamsSchema = z.object({ id: IdSchema }).strict()

/** Flat query schema for GET /people (q/cursor/limit). Re-validated against the shared request schema. */
const ListPeopleQuerySchema = z
  .object({
    q: z.string().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(50).optional(),
  })
  .strict()

export async function registerSocialRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the social repository from injected overrides (tests) or the container DB (production). */
  function repo(): SocialRepository {
    const overrides = app.socialOverrides
    if (overrides) return overrides.repo
    return makeDrizzleSocialRepository(container.getDb().sql)
  }

  /**
   * Resolve the new_follower notifier. Tests may inject one; otherwise build the notification service over
   * the DB-backed notification repo + the container's push seam (so a follow fires + inline-pushes for
   * real). The notifier is optional (a follow still succeeds without it).
   */
  function notifier(): SocialNotifier | undefined {
    const overrides = app.socialOverrides
    if (overrides) return overrides.notifier
    return makeNotificationService({
      repo: makeDrizzleNotificationRepository(container.getDb().sql),
      pushSender: container.pushSender,
      logger: app.log,
    })
  }

  /** Build the social service over the resolved repo + notifier. */
  function service(): SocialService {
    const n = notifier()
    return makeSocialService({
      repo: repo(),
      ...(n !== undefined ? { notifier: n } : {}),
    })
  }

  // -------------------------------------------------------------------------
  // GET /people  (anon-ok)
  // -------------------------------------------------------------------------
  app.get("/people", async (request, reply) => {
    const q = parse(ListPeopleQuerySchema, request.query)
    // Re-validate against the shared schema (single source of truth).
    const validated = parse(ListPeopleRequestSchema, {
      ...(q.q !== undefined ? { q: q.q } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    })
    const payload: ListPeopleResponse = await service().listPeople(validated, viewerOf(request))
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /people/:id/follow  [auth][csrf]
  // -------------------------------------------------------------------------
  app.post("/people/:id/follow", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PersonIdParamsSchema, request.params)
    const payload: FollowPersonResponse = await service().followPerson(userId, id)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // DELETE /people/:id/follow  [auth][csrf]
  // -------------------------------------------------------------------------
  app.delete("/people/:id/follow", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PersonIdParamsSchema, request.params)
    const payload: FollowPersonResponse = await service().unfollowPerson(userId, id)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /people/:id  (anon-ok)
  // -------------------------------------------------------------------------
  app.get("/people/:id", async (request, reply) => {
    const { id } = parse(PersonIdParamsSchema, request.params)
    const payload: GetProfileResponse = await service().getProfile(id, viewerOf(request))
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /me/profile  [auth]
  // -------------------------------------------------------------------------
  app.get("/me/profile", async (request, reply) => {
    const userId = requireAuth(request)
    const payload: GetProfileResponse = await service().getMyProfile(userId)
    reply.status(200).send(payload)
  })
}

/** Derive the viewer context (signed-in user id, or null) from the resolved auth on the request. */
function viewerOf(request: FastifyRequest): SocialViewer {
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
