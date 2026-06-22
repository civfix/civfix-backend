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
  UserActivityListQuerySchema,
  ConnectionsListQuerySchema,
  IdSchema,
  AppError,
  type ListPeopleResponse,
  type FollowPersonResponse,
  type GetProfileResponse,
  type UserActivityListResponse,
} from "@civfix/shared"
import { z } from "zod"
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
import { makeUserActivityService } from "../services/user-activity-service.js"
import { makeDrizzleUserActivityRepository } from "../services/user-activity-repository.drizzle.js"
import { MEDIA_GET_URL_TTL_SEC } from "../services/media-intake-service.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"

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

/**
 * Path param schema for GET /people/:id, which accepts EITHER a UUID (old deep links) OR an @handle (the
 * /people/<handle> link). A bare non-empty string; the handler branches on whether it is a valid UUID.
 */
const PersonRefParamsSchema = z.object({ id: z.string().min(1).max(40) }).strict()

/** Canonical UUID shape: when the :id param matches this it is resolved by id, else by @handle. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
   * the DB-backed notification repo + the container's push seam. Built ONLY on the follow path (read-only
   * GETs never notify, so they skip this construction).
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

  /**
   * Build the social service. `withNotifier` (the follow path) additionally wires the new_follower
   * notifier; read-only paths pass false so the notifier (a notification service over the push seam) is
   * never constructed. In production the avatar key is presigned over the Storage seam; in tests
   * (overrides present) it is left unset so the service defaults to a pass-through.
   */
  function service(withNotifier = false): SocialService {
    const n = withNotifier ? notifier() : undefined
    const presignAvatar = app.socialOverrides
      ? undefined
      : (k: string) => container.storage.presignGet(k, MEDIA_GET_URL_TTL_SEC)
    return makeSocialService({
      repo: repo(),
      logger: app.log,
      ...(n !== undefined ? { notifier: n } : {}),
      ...(presignAvatar !== undefined ? { presignAvatar } : {}),
    })
  }

  /** Merge the `:id` path param into the query so a shared query schema (which carries `id`) validates both. */
  function mergeIdParam<S extends z.ZodTypeAny>(schema: S, request: FastifyRequest): z.infer<S> {
    return parse(schema, {
      ...(request.query as object),
      id: (request.params as { id?: unknown }).id,
    })
  }

  // GET /people  [auth] — require a non-empty `q`: there is deliberately no list-everyone form (the server
  // never enumerates all users), so a missing/blank query is a 422, not a full dump.
  route(app, "listPeople", async (request, reply) => {
    const userId = requireAuth(request)
    const validated = parse(ListPeopleRequestSchema, request.query)
    if (validated.q === null || validated.q === undefined || validated.q.trim().length === 0) {
      throw AppError.validation({ q: "A non-empty search query is required." })
    }
    const payload: ListPeopleResponse = await service().listPeople(validated, { userId })
    reply.status(200).send(payload)
  })

  route(app, "followPerson", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PersonIdParamsSchema, request.params)
    const payload: FollowPersonResponse = await service(true).followPerson(userId, id)
    reply.status(200).send(payload)
  })

  route(app, "unfollowPerson", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PersonIdParamsSchema, request.params)
    const payload: FollowPersonResponse = await service().unfollowPerson(userId, id)
    reply.status(200).send(payload)
  })

  // GET /people/:id  (anon-ok) — accepts a UUID (old deep links) OR an @handle (/people/<handle>). Resolve
  // by id when the param is a valid UUID, else by handle; follow/block/DM-open stay UUID-keyed.
  route(app, "getProfile", async (request, reply) => {
    const { id } = parse(PersonRefParamsSchema, request.params)
    const svc = service()
    const payload: GetProfileResponse = UUID_RE.test(id)
      ? await svc.getProfile(id, viewerOf(request))
      : await svc.getProfileByHandle(id, viewerOf(request))
    reply.status(200).send(payload)
  })

  route(app, "myProfile", async (request, reply) => {
    const userId = requireAuth(request)
    const payload: GetProfileResponse = await service().getMyProfile(userId)
    reply.status(200).send(payload)
  })

  route(app, "listUserActivity", async (request, reply) => {
    const input = mergeIdParam(UserActivityListQuerySchema, request)
    const activity = makeUserActivityService({
      repo: makeDrizzleUserActivityRepository(container.getDb().sql),
    })
    const payload: UserActivityListResponse = await activity.list(
      input.id,
      input.cursor ?? null,
      input.limit,
    )
    reply.status(200).send(payload)
  })

  route(app, "listFollowers", async (request, reply) => {
    const input = mergeIdParam(ConnectionsListQuerySchema, request)
    const payload: ListPeopleResponse = await service().listFollowers(
      input.id,
      viewerOf(request),
      input,
    )
    reply.status(200).send(payload)
  })

  route(app, "listFollowing", async (request, reply) => {
    const input = mergeIdParam(ConnectionsListQuerySchema, request)
    const payload: ListPeopleResponse = await service().listFollowing(
      input.id,
      viewerOf(request),
      input,
    )
    reply.status(200).send(payload)
  })
}

/** Derive the viewer context (signed-in user id, or null) from the resolved auth on the request. */
function viewerOf(request: FastifyRequest): SocialViewer {
  return { userId: request.auth?.userId ?? null }
}
