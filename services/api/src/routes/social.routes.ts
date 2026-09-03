
import {
  ListPeopleRequestSchema,
  FollowSuggestionsRequestSchema,
  type FollowSuggestionsResponse,
  ConnectionsListQuerySchema,
  IdSchema,
  AppError,
  type ListPeopleResponse,
  type FollowPersonResponse,
  type GetProfileResponse,
  ProfileEventsRequestSchema,
  type ProfileEventsResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import {
  makeSocialService,
  type SocialNotifier,
  type SuggestionsCache,
  type SocialRepository,
  type SocialService,
  type SocialViewer,
} from "../services/social-service.js"
import { makeDrizzleSocialRepository } from "../services/social-repository.drizzle.js"
import { makeRouteNotificationService } from "../services/route-notifier.js"
import { MEDIA_GET_URL_TTL_SEC } from "../services/media-intake-service.js"
import { perIdentity } from "../plugins/rate-limit.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"

export const FOLLOW_RATE_LIMIT = perIdentity({ max: 30, timeWindow: "1 minute" })

export const FOLLOW_SUGGESTIONS_RATE_LIMIT = perIdentity({ max: 30, timeWindow: "1 minute" })

export interface SocialServiceOverrides {
  repo: SocialRepository
  notifier?: SocialNotifier
}

declare module "fastify" {
  interface FastifyInstance {
    socialOverrides?: SocialServiceOverrides
  }
}

const PersonIdParamsSchema = z.object({ id: IdSchema }).strict()

const PERSON_REF_MAX = 40

const PersonRefParamsSchema = z.object({ id: z.string().min(1).max(PERSON_REF_MAX) }).strict()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const FOLLOW_SUGGESTIONS_DEFAULT_LIMIT = 10

export async function registerSocialRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  function repo(): SocialRepository {
    const overrides = app.socialOverrides
    if (overrides) return overrides.repo
    return makeDrizzleSocialRepository(container.getDb().sql)
  }

  function notifier(): SocialNotifier | undefined {
    const overrides = app.socialOverrides
    if (overrides) return overrides.notifier
    return makeRouteNotificationService(container, app.log)
  }

  // Lazily resolved so building the container stays socket-free: the Redis client is only created on
  // the first suggestion request, and only when REDIS_URL is configured at all.
  const suggestionsCache: SuggestionsCache = {
    get: (key) => container.getCache().get(key),
    set: (key, value, ttl) => container.getCache().set(key, value, ttl),
    del: (key) => container.getCache().del(key),
  }

  function service(withNotifier = false): SocialService {
    const n = withNotifier ? notifier() : undefined
    const cache =
      app.socialOverrides || !container.env.REDIS_URL ? undefined : suggestionsCache
    const presignAvatar = app.socialOverrides
      ? undefined
      : (k: string) => container.storage.presignGet(k, MEDIA_GET_URL_TTL_SEC)
    const volunteerHoursTotalFor = app.socialOverrides
      ? undefined
      : (userId: string) => container.getVolunteerHoursRepo().totalHoursFor(userId)
    const isBlockedEitherWay = app.socialOverrides
      ? undefined
      : (viewerId: string, targetId: string) =>
          container.getBlocksRepo().isBlockedEitherWay(viewerId, targetId)
    const blockState = app.socialOverrides
      ? undefined
      : (viewerId: string, targetId: string) =>
          container.getBlocksRepo().blockState(viewerId, targetId)
    return makeSocialService({
      repo: repo(),
      logger: app.log,
      ...(cache !== undefined ? { suggestionsCache: cache } : {}),
      ...(n !== undefined ? { notifier: n } : {}),
      ...(presignAvatar !== undefined ? { presignAvatar } : {}),
      ...(volunteerHoursTotalFor !== undefined ? { volunteerHoursTotalFor } : {}),
      ...(isBlockedEitherWay !== undefined ? { isBlockedEitherWay } : {}),
      ...(blockState !== undefined ? { blockState } : {}),
    })
  }

  function mergeIdParam<S extends z.ZodTypeAny>(schema: S, request: FastifyRequest): z.infer<S> {
    return parse(schema, {
      ...(request.query as object),
      id: (request.params as { id?: unknown }).id,
    })
  }

  async function resolvePersonId(ref: string): Promise<string> {
    if (UUID_RE.test(ref)) {
      const person = await repo().findPersonById(ref)
      if (person === null) throw AppError.notFound("Person not found")
      return ref
    }
    if (ref.length > PERSON_REF_MAX) throw AppError.notFound("Person not found")
    return service().resolveHandleToId(ref)
  }

  route(app, "listPeople", async (request, reply) => {
    const userId = requireAuth(request)
    const validated = parse(ListPeopleRequestSchema, request.query)
    if (validated.q === null || validated.q === undefined || validated.q.trim().length === 0) {
      throw AppError.validation({ q: "A non-empty search query is required." })
    }
    const payload: ListPeopleResponse = await service().listPeople(validated, { userId })
    reply.status(200).send(payload)
  })

  route(app, "followSuggestions", { config: { rateLimit: FOLLOW_SUGGESTIONS_RATE_LIMIT } }, async (request, reply) => {
    const userId = requireAuth(request)
    const q = parse(FollowSuggestionsRequestSchema, request.query)
    const payload: FollowSuggestionsResponse = await service().followSuggestions(
      userId,
      q.limit ?? FOLLOW_SUGGESTIONS_DEFAULT_LIMIT,
    )
    reply.status(200).send(payload)
  })

  route(app, "followPerson", { preHandler: csrfProtect, config: { rateLimit: FOLLOW_RATE_LIMIT } }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PersonIdParamsSchema, request.params)
    const payload: FollowPersonResponse = await service(true).followPerson(userId, id)
    reply.status(200).send(payload)
  })

  route(app, "unfollowPerson", { preHandler: csrfProtect, config: { rateLimit: FOLLOW_RATE_LIMIT } }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PersonIdParamsSchema, request.params)
    const payload: FollowPersonResponse = await service().unfollowPerson(userId, id)
    reply.status(200).send(payload)
  })

  route(app, "getProfile", async (request, reply) => {
    const { id } = parse(PersonRefParamsSchema, request.params)
    const svc = service()
    const payload: GetProfileResponse = UUID_RE.test(id)
      ? await svc.getProfile(id, viewerOf(request))
      : await svc.getProfileByHandle(id, viewerOf(request))
    reply.status(200).send(payload)
  })

  route(app, "getProfileEvents", async (request, reply) => {
    const input = mergeIdParam(ProfileEventsRequestSchema, request)
    const userId = await resolvePersonId(input.id)
    const payload: ProfileEventsResponse = await service().listProfileEvents(
      userId,
      viewerOf(request),
      input,
    )
    reply.status(200).send(payload)
  })

  route(app, "myProfile", async (request, reply) => {
    const userId = requireAuth(request)
    const payload: GetProfileResponse = await service().getMyProfile(userId)
    reply.status(200).send(payload)
  })

  route(app, "listFollowers", async (request, reply) => {
    const input = mergeIdParam(ConnectionsListQuerySchema, request)
    const userId = await resolvePersonId(input.id)
    const payload: ListPeopleResponse = await service().listFollowers(
      userId,
      viewerOf(request),
      input,
    )
    reply.status(200).send(payload)
  })

  route(app, "listFollowing", async (request, reply) => {
    const input = mergeIdParam(ConnectionsListQuerySchema, request)
    const userId = await resolvePersonId(input.id)
    const payload: ListPeopleResponse = await service().listFollowing(
      userId,
      viewerOf(request),
      input,
    )
    reply.status(200).send(payload)
  })
}

function viewerOf(request: FastifyRequest): SocialViewer {
  return { userId: request.auth?.userId ?? null }
}
