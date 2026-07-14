
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
import {
  makeUserActivityService,
  type UserActivityRepository,
} from "../services/user-activity-service.js"
import { makeDrizzleUserActivityRepository } from "../services/user-activity-repository.drizzle.js"
import { MEDIA_GET_URL_TTL_SEC } from "../services/media-intake-service.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"

export interface SocialServiceOverrides {
  repo: SocialRepository
  notifier?: SocialNotifier
}

export interface UserActivityOverride {
  repo: UserActivityRepository
}

declare module "fastify" {
  interface FastifyInstance {
    socialOverrides?: SocialServiceOverrides
    userActivityOverride?: UserActivityOverride
  }
}

const PersonIdParamsSchema = z.object({ id: IdSchema }).strict()

const PersonRefParamsSchema = z.object({ id: z.string().min(1).max(40) }).strict()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function registerSocialRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  function repo(): SocialRepository {
    const overrides = app.socialOverrides
    if (overrides) return overrides.repo
    return makeDrizzleSocialRepository(container.getDb().sql)
  }

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
    return makeSocialService({
      repo: repo(),
      logger: app.log,
      ...(n !== undefined ? { notifier: n } : {}),
      ...(presignAvatar !== undefined ? { presignAvatar } : {}),
      ...(volunteerHoursTotalFor !== undefined ? { volunteerHoursTotalFor } : {}),
      ...(isBlockedEitherWay !== undefined ? { isBlockedEitherWay } : {}),
    })
  }

  function mergeIdParam<S extends z.ZodTypeAny>(schema: S, request: FastifyRequest): z.infer<S> {
    return parse(schema, {
      ...(request.query as object),
      id: (request.params as { id?: unknown }).id,
    })
  }

  async function resolvePersonId(ref: string): Promise<string> {
    if (UUID_RE.test(ref)) return ref
    return service().resolveHandleToId(ref)
  }

  function userActivityRepo(): UserActivityRepository {
    const override = app.userActivityOverride
    if (override) return override.repo
    return makeDrizzleUserActivityRepository(container.getDb().sql)
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

  route(app, "listUserActivity", async (request, reply) => {
    const input = mergeIdParam(UserActivityListQuerySchema, request)
    const userId = await resolvePersonId(input.id)
    const activity = makeUserActivityService({ repo: userActivityRepo() })
    const payload: UserActivityListResponse = await activity.list(
      userId,
      input.cursor ?? null,
      input.limit,
    )
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
