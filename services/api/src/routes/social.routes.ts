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
import { route } from "../versioning/route.js"

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
      userChannel: container.userChannel,
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
  // GET /people  [auth]  (requires a non-empty `q` — never enumerates all users)
  // -------------------------------------------------------------------------
  route(app, "listPeople", async (request, reply) => {
    // Auth-required now (privacy: the directory must not be browsable logged-out).
    const userId = requireAuth(request)
    // The shared request schema (q + cursor + coerced limit) is the single source of truth; the query
    // string is validated directly against it.
    const validated = parse(ListPeopleRequestSchema, request.query)
    // REQUIRE a non-empty `q`: there is deliberately no list-everyone form (the server never enumerates
    // all users). A missing/blank query is a 422, not a full dump.
    if (validated.q === null || validated.q === undefined || validated.q.trim().length === 0) {
      throw AppError.validation({ q: "A non-empty search query is required." })
    }
    const payload: ListPeopleResponse = await service().listPeople(validated, { userId })
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /people/:id/follow  [auth][csrf]
  // -------------------------------------------------------------------------
  route(app, "followPerson", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PersonIdParamsSchema, request.params)
    const payload: FollowPersonResponse = await service().followPerson(userId, id)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // DELETE /people/:id/follow  [auth][csrf]
  // -------------------------------------------------------------------------
  route(app, "unfollowPerson", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PersonIdParamsSchema, request.params)
    const payload: FollowPersonResponse = await service().unfollowPerson(userId, id)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /people/:id  (anon-ok)
  // -------------------------------------------------------------------------
  route(app, "getProfile", async (request, reply) => {
    const { id } = parse(PersonIdParamsSchema, request.params)
    const payload: GetProfileResponse = await service().getProfile(id, viewerOf(request))
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /me/profile  [auth]
  // -------------------------------------------------------------------------
  route(app, "myProfile", async (request, reply) => {
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
