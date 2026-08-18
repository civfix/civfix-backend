
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
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import {
  makeSocialService,
  type SocialNotifier,
  type SocialRepository,
  type SocialService,
  type SocialViewer,
} from "../services/social-service.js"
import { makeDrizzleSocialRepository } from "../services/social-repository.drizzle.js"
import { makeRouteNotificationService } from "../services/route-notifier.js"
import { MEDIA_GET_URL_TTL_SEC } from "../services/media-intake-service.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"

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

/** Default page size for GET /users/follow-suggestions (the shared request caps `limit` at 20). */
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

  function service(withNotifier = false): SocialService {
    const n = withNotifier ? notifier() : undefined
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

  /**
   * :id -> a user id that EXISTS and is not soft-deleted, else 404.
   *
   * The handle branch verifies existence inherently (the lookup filters deleted_at). The UUID branch used
   * to pass the ref straight through, so followers/following answered 200-with-items:[] for a
   * random or tombstoned UUID while getProfile 404'd the same id — inconsistent, and it left a deleted
   * account's surfaces enumerable by UUID. findPersonById applies the same deleted_at filter getProfile does.
   */
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

  // GET /users/follow-suggestions [auth] — recommended people to follow. Nearby (viewer's recent
  // activity area) first, community organizers ranked above ordinary nearby users, then organizers
  // elsewhere, then everyone else; excludes self / already-followed / blocked / deleted.
  route(app, "followSuggestions", async (request, reply) => {
    const userId = requireAuth(request)
    const q = parse(FollowSuggestionsRequestSchema, request.query)
    const payload: FollowSuggestionsResponse = await service().followSuggestions(
      userId,
      q.limit ?? FOLLOW_SUGGESTIONS_DEFAULT_LIMIT,
    )
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
