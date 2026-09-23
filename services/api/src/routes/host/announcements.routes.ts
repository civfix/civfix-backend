import {
  CreateEventAnnouncementRequestSchema,
  GetEventAnnouncementRequestSchema,
  ListEventAnnouncementsRequestSchema,
  type AnnouncementDTO,
  type ListEventAnnouncementsResponse,
} from "@civfix/shared"
import { can } from "@civfix/shared/host"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../../di.js"
import { requireAuth } from "../../auth/context.js"
import { perIdentity } from "../../plugins/rate-limit.js"
import { route } from "../../versioning/route.js"
import { parse, trimTextFields } from "../_validate.js"
import { requireCapability, resolveVisibleStanding } from "../../services/host/authz.js"
import { BroadcastCapError, capError } from "../../services/host/broadcast-service.js"
import { auditBestEffort, makeCommsRuntime } from "../../services/host/comms-wiring.js"
import type { CommsRuntime } from "../../services/host/comms-wiring.js"
import type {
  AnnouncementProjection,
  AnnouncementService,
} from "../../services/host/announcement-service.js"

export const ANNOUNCEMENT_CREATE_RATE_LIMIT = perIdentity({ max: 10, timeWindow: "1 minute" })
export const ANNOUNCEMENT_READ_RATE_LIMIT = perIdentity({ max: 60, timeWindow: "1 minute" })

function mergeParams(request: FastifyRequest): Record<string, unknown> {
  const params = (request.params ?? {}) as Record<string, unknown>
  const body = (request.body ?? {}) as Record<string, unknown>
  return { ...body, ...params }
}

function mergeQuery(request: FastifyRequest): Record<string, unknown> {
  const params = (request.params ?? {}) as Record<string, unknown>
  const query = (request.query ?? {}) as Record<string, unknown>
  return { ...query, ...params }
}

export async function registerHostAnnouncementRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect
  let cached: CommsRuntime | undefined

  function runtime(): CommsRuntime {
    return (cached ??= makeCommsRuntime(container, app.log))
  }

  function service(): AnnouncementService {
    return runtime().announcements
  }

  async function projectionFor(
    cleanupId: string,
    userId: string | null,
  ): Promise<AnnouncementProjection> {
    const resolution = await resolveVisibleStanding(container.getDb().sql, cleanupId, userId)
    return { host: can(resolution.standing, "broadcast") }
  }

  route(
    app,
    "createEventAnnouncement",
    { preHandler: csrfProtect, config: { rateLimit: ANNOUNCEMENT_CREATE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(
        trimTextFields(CreateEventAnnouncementRequestSchema, "title", "bodyMd"),
        mergeParams(request),
      )
      await requireCapability(container.getDb().sql, body.id, userId, "broadcast")
      let payload: AnnouncementDTO
      try {
        payload = await service().create(body.id, userId, body)
      } catch (err) {
        if (err instanceof BroadcastCapError) throw capError(err.kind)
        throw err
      }
      await auditBestEffort(
        container.getDb().sql,
        {
          action: "event.announcement_sent",
          actorId: userId,
          target: `broadcast:${payload.id}`,
          meta: { cleanupId: body.id, audience: body.audience.kind },
        },
        request.log,
      )
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "listEventAnnouncements",
    { config: { rateLimit: ANNOUNCEMENT_READ_RATE_LIMIT } },
    async (request, reply) => {
      const userId = request.auth?.userId ?? null
      const query = parse(ListEventAnnouncementsRequestSchema, mergeQuery(request))
      const projection = await projectionFor(query.id, userId)
      const payload: ListEventAnnouncementsResponse = await service().list(
        query.id,
        query,
        projection,
      )
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "getEventAnnouncement",
    { config: { rateLimit: ANNOUNCEMENT_READ_RATE_LIMIT } },
    async (request, reply) => {
      const userId = request.auth?.userId ?? null
      const params = parse(GetEventAnnouncementRequestSchema, mergeParams(request))
      const projection = await projectionFor(params.id, userId)
      const payload: AnnouncementDTO = await service().get(
        params.id,
        params.announcementId,
        projection,
      )
      reply.status(200).send(payload)
    },
  )
}
