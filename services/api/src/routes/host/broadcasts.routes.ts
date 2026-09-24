import {
  CancelEventBroadcastRequestSchema,
  CreateEventBroadcastRequestSchema,
  DeleteEventBroadcastRequestSchema,
  GetEventBroadcastRequestSchema,
  ListBroadcastDeliveriesRequestSchema,
  ListEventBroadcastsRequestSchema,
  PreviewEventBroadcastRequestSchema,
  ScheduleEventBroadcastRequestSchema,
  SendEventBroadcastRequestSchema,
  SetEventBroadcastMuteRequestSchema,
  TestSendEventBroadcastRequestSchema,
  UpdateEventBroadcastRequestSchema,
  type BroadcastDTO,
  type BroadcastPreviewDTO,
  type ListBroadcastDeliveriesResponse,
  type ListEventBroadcastsResponse,
  type SetEventBroadcastMuteResponse,
} from "@civfix/shared"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../../di.js"
import { requireAuth } from "../../auth/context.js"
import { perIdentity } from "../../plugins/rate-limit.js"
import { route } from "../../versioning/route.js"
import { parse } from "../_validate.js"
import { requireCapability, resolveVisibleStanding } from "../../services/host/authz.js"
import {
  BroadcastCapError,
  capError,
  emailHashOf,
  type BroadcastService,
} from "../../services/host/broadcast-service.js"
import { auditBestEffort, makeCommsRuntime } from "../../services/host/comms-wiring.js"
import type { CommsRuntime } from "../../services/host/comms-wiring.js"

export const BROADCAST_WRITE_RATE_LIMIT = perIdentity({ max: 30, timeWindow: "1 minute" })
export const BROADCAST_SEND_RATE_LIMIT = perIdentity({ max: 10, timeWindow: "1 minute" })
export const BROADCAST_READ_RATE_LIMIT = perIdentity({ max: 60, timeWindow: "1 minute" })

export interface BroadcastOverrides {
  runtime: CommsRuntime
}

declare module "fastify" {
  interface FastifyInstance {
    broadcastOverrides?: BroadcastOverrides
  }
}

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

export async function registerHostBroadcastRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect
  let cached: CommsRuntime | undefined

  function runtime(): CommsRuntime {
    const override = app.broadcastOverrides
    if (override) return override.runtime
    return (cached ??= makeCommsRuntime(container, app.log))
  }

  function service(): BroadcastService {
    return runtime().broadcasts
  }

  async function withCaps<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof BroadcastCapError) throw capError(err.kind)
      throw err
    }
  }

  route(
    app,
    "listEventBroadcasts",
    { config: { rateLimit: BROADCAST_READ_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const query = parse(ListEventBroadcastsRequestSchema, mergeQuery(request))
      await requireCapability(container.getDb().sql, query.id, userId, "broadcast")
      const payload: ListEventBroadcastsResponse = await service().list(query.id, query)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "getEventBroadcast",
    { config: { rateLimit: BROADCAST_READ_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const params = parse(GetEventBroadcastRequestSchema, mergeParams(request))
      await requireCapability(container.getDb().sql, params.id, userId, "broadcast")
      const payload: BroadcastDTO = await service().get(params.id, params.broadcastId)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "createEventBroadcast",
    { preHandler: csrfProtect, config: { rateLimit: BROADCAST_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(CreateEventBroadcastRequestSchema, mergeParams(request))
      await requireCapability(container.getDb().sql, body.id, userId, "broadcast")
      const payload = await withCaps(() => service().create(body.id, userId, body))
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "updateEventBroadcast",
    { preHandler: csrfProtect, config: { rateLimit: BROADCAST_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(UpdateEventBroadcastRequestSchema, mergeParams(request))
      await requireCapability(container.getDb().sql, body.id, userId, "broadcast")
      const payload = await withCaps(() => service().update(body.id, userId, body))
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "deleteEventBroadcast",
    { preHandler: csrfProtect, config: { rateLimit: BROADCAST_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const params = parse(DeleteEventBroadcastRequestSchema, mergeParams(request))
      await requireCapability(container.getDb().sql, params.id, userId, "broadcast")
      reply.status(200).send(await service().remove(params.id, params.broadcastId))
    },
  )

  route(
    app,
    "previewEventBroadcast",
    { preHandler: csrfProtect, config: { rateLimit: BROADCAST_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(PreviewEventBroadcastRequestSchema, mergeParams(request))
      await requireCapability(container.getDb().sql, body.id, userId, "broadcast")
      const payload: BroadcastPreviewDTO = await withCaps(() =>
        service().preview(body.id, userId, body),
      )
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "testSendEventBroadcast",
    { preHandler: csrfProtect, config: { rateLimit: BROADCAST_SEND_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const params = parse(TestSendEventBroadcastRequestSchema, mergeParams(request))
      await requireCapability(container.getDb().sql, params.id, userId, "broadcast")
      const payload = await withCaps(() =>
        service().testSend(params.id, userId, params.broadcastId),
      )
      await auditBestEffort(
        container.getDb().sql,
        {
          action: "event.broadcast_test_sent",
          actorId: userId,
          target: `broadcast:${params.broadcastId}`,
          meta: { cleanupId: params.id },
        },
        request.log,
      )
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "sendEventBroadcast",
    { preHandler: csrfProtect, config: { rateLimit: BROADCAST_SEND_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const params = parse(SendEventBroadcastRequestSchema, mergeParams(request))
      await requireCapability(container.getDb().sql, params.id, userId, "broadcast")
      const payload = await withCaps(() => service().send(params.id, userId, params.broadcastId))
      await auditBestEffort(
        container.getDb().sql,
        {
          action: "event.broadcast_sent",
          actorId: userId,
          target: `broadcast:${params.broadcastId}`,
          meta: {
            cleanupId: params.id,
            segment: payload.segment?.kind ?? null,
            channels: payload.channels,
            subjectHash:
              payload.subject === null || payload.subject === undefined
                ? null
                : emailHashOf(payload.subject),
          },
        },
        request.log,
      )
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "scheduleEventBroadcast",
    { preHandler: csrfProtect, config: { rateLimit: BROADCAST_SEND_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(ScheduleEventBroadcastRequestSchema, mergeParams(request))
      await requireCapability(container.getDb().sql, body.id, userId, "broadcast")
      const payload = await withCaps(() =>
        service().schedule(body.id, userId, body.broadcastId, new Date(body.scheduledAt)),
      )
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "cancelEventBroadcast",
    { preHandler: csrfProtect, config: { rateLimit: BROADCAST_SEND_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const params = parse(CancelEventBroadcastRequestSchema, mergeParams(request))
      await requireCapability(container.getDb().sql, params.id, userId, "broadcast")
      reply.status(200).send(await service().cancel(params.id, params.broadcastId))
    },
  )

  route(
    app,
    "listBroadcastDeliveries",
    { config: { rateLimit: BROADCAST_READ_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const query = parse(ListBroadcastDeliveriesRequestSchema, mergeQuery(request))
      await requireCapability(container.getDb().sql, query.id, userId, "broadcast")
      const payload: ListBroadcastDeliveriesResponse = await service().listDeliveries(
        query.id,
        query,
      )
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "setEventBroadcastMute",
    { preHandler: csrfProtect, config: { rateLimit: BROADCAST_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(SetEventBroadcastMuteRequestSchema, mergeParams(request))
      await resolveVisibleStanding(container.getDb().sql, body.id, userId)
      const payload: SetEventBroadcastMuteResponse = await service().setMute(
        body.id,
        userId,
        body.muted,
      )
      reply.status(200).send(payload)
    },
  )
}
