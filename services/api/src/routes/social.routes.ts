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
import { makeContainerSuggestionsCache } from "../services/social-suggestions-wiring.js"
import {
  makeSocialService,
  PERSON_NOT_FOUND_MESSAGE,
  type SocialNotifier,
  type SocialRepository,
  type SocialService,
  type SocialServiceDeps,
  type SocialViewer,
} from "../services/social-service.js"
import { makeDrizzleSocialRepository } from "../services/social-repository.drizzle.js"
import { makeRouteNotificationService } from "../services/route-notifier.js"
import { MEDIA_GET_URL_TTL_SEC } from "../services/media-intake-service.js"
import { perIdentity } from "../plugins/rate-limit.js"
import { route } from "../versioning/route.js"
import { isUuid } from "../db/cursor-helpers.js"
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

  const suggestionsCache = makeContainerSuggestionsCache(container)

  function containerDeps(): Omit<SocialServiceDeps, "repo" | "logger" | "notifier"> {
    return {
      affiliations: container.getAffiliationLoader(),
      ...(suggestionsCache !== undefined ? { suggestionsCache } : {}),
      presignAvatar: (k: string) => container.storage.presignGet(k, MEDIA_GET_URL_TTL_SEC),
      volunteerHoursTotalFor: (userId: string) =>
        container.getVolunteerHoursRepo().totalHoursFor(userId),
      isBlockedEitherWay: (viewerId: string, targetId: string) =>
        container.getBlocksRepo().isBlockedEitherWay(viewerId, targetId),
      blockState: (viewerId: string, targetId: string) =>
        container.getBlocksRepo().blockState(viewerId, targetId),
    }
  }

  function service(withNotifier = false): SocialService {
    const n = withNotifier ? notifier() : undefined
    const wired = app.socialOverrides ? {} : containerDeps()
    return makeSocialService({
      repo: repo(),
      logger: app.log,
      ...wired,
      ...(n !== undefined ? { notifier: n } : {}),
    })
  }

  function mergeIdParam<S extends z.ZodTypeAny>(schema: S, request: FastifyRequest): z.infer<S> {
    return parse(schema, {
      ...(request.query as object),
      id: (request.params as { id?: unknown }).id,
    })
  }

  async function resolvePersonId(ref: string): Promise<string> {
    if (isUuid(ref)) {
      const person = await repo().findPersonById(ref)
      if (person === null) throw AppError.notFound(PERSON_NOT_FOUND_MESSAGE)
      return ref
    }
    if (ref.length > PERSON_REF_MAX) throw AppError.notFound(PERSON_NOT_FOUND_MESSAGE)
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

  route(
    app,
    "followSuggestions",
    { config: { rateLimit: FOLLOW_SUGGESTIONS_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const q = parse(FollowSuggestionsRequestSchema, request.query)
      const payload: FollowSuggestionsResponse = await service().followSuggestions(
        userId,
        q.limit ?? FOLLOW_SUGGESTIONS_DEFAULT_LIMIT,
      )
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "followPerson",
    { preHandler: csrfProtect, config: { rateLimit: FOLLOW_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(PersonIdParamsSchema, request.params)
      const payload: FollowPersonResponse = await service(true).followPerson(userId, id)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "unfollowPerson",
    { preHandler: csrfProtect, config: { rateLimit: FOLLOW_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(PersonIdParamsSchema, request.params)
      const payload: FollowPersonResponse = await service().unfollowPerson(userId, id)
      reply.status(200).send(payload)
    },
  )

  route(app, "getProfile", async (request, reply) => {
    const { id } = parse(PersonRefParamsSchema, request.params)
    const svc = service()
    const payload: GetProfileResponse = isUuid(id)
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
