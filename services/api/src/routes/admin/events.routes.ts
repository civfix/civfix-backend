/**
 * Admin events (cleanups) routes (Phase 2).
 *
 *   GET  /admin/events             the events list (filter/search/paginate) (AdminEventListResponse).
 *   GET  /admin/events/:id         an event detail (GetAdminEventResponse).
 *   POST /admin/events/:id/status  set status (SetEventStatusRequest). [csrf]
 *   POST /admin/events/:id/flag    flag/unflag (FlagEventRequest). [csrf]
 *   POST /admin/events/:id/cancel  cancel the event (CancelRequest). [csrf]
 *   POST /admin/events/:id/message post an update to attendees (PostMessageRequest). [csrf]
 *
 * Every body/query is validated against the shared Zod schema via parse(). The requireOperator guard is
 * applied by routes/admin/index.ts; mutations additionally carry csrfProtect. The acting operator's
 * userId comes from request.auth.userId and is recorded on every audit write (the audit is written
 * inside the service's repo transaction, atomic with the effect). The service is built lazily from the
 * container (Drizzle event repo) or from a per-instance test override (in-memory repo).
 */

import {
  AdminEventListQuerySchema,
  CancelRequestSchema,
  FlagEventRequestSchema,
  PostMessageRequestSchema,
  SetEventStatusRequestSchema,
  type AdminEventDTO,
  type AdminEventListResponse,
  type AdminOkResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { csrfProtect } from "../../auth/csrf.js"
import { route } from "../../versioning/route.js"
import { idParam, parse } from "./_route-utils.js"
import {
  makeAdminEventService,
  type AdminEventRepository,
  type AdminEventService,
} from "../../services/admin/admin-event-service.js"
import { makeDrizzleAdminEventRepository } from "../../services/admin/admin-event-repository.drizzle.js"

/**
 * Optional injected admin-event dependencies (tests). When present the routes build the service from
 * these (an in-memory repo) instead of the container, so the whole HTTP flow runs offline.
 */
export interface AdminEventRouteOverrides {
  repo: AdminEventRepository
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected admin-event route overrides (tests). See AdminEventRouteOverrides. */
    adminEventOverrides?: AdminEventRouteOverrides
  }
}

export async function registerAdminEventsRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the admin-event service from injected overrides (tests) or the container (production). */
  function service(): AdminEventService {
    const overrides = app.adminEventOverrides
    if (overrides) {
      return makeAdminEventService({
        repo: overrides.repo,
        ...(overrides.now !== undefined ? { now: overrides.now } : {}),
      })
    }
    const repo: AdminEventRepository = makeDrizzleAdminEventRepository(container.getDb().sql)
    return makeAdminEventService({ repo })
  }

  // -------------------------------------------------------------------------
  // GET /admin/events
  // -------------------------------------------------------------------------
  route(app, "listAdminEvents", async (request, reply) => {
    const query = parse(AdminEventListQuerySchema, request.query)
    const payload: AdminEventListResponse = await service().list(query)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /admin/events/:id
  // -------------------------------------------------------------------------
  route(app, "getAdminEvent", async (request, reply) => {
    const { id } = idParam(request)
    const payload: AdminEventDTO = await service().get(id)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/events/:id/status  [csrf]
  // -------------------------------------------------------------------------
  route(app, "setEventStatus", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(SetEventStatusRequestSchema, { ...(request.body as object), id })
    await service().setStatus(id, { status: body.status, actorId: request.auth.userId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/events/:id/flag  [csrf]
  // -------------------------------------------------------------------------
  route(app, "flagEvent", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(FlagEventRequestSchema, { ...(request.body as object), id })
    await service().flag(id, { reason: body.reason ?? null, actorId: request.auth.userId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/events/:id/cancel  [csrf]
  // -------------------------------------------------------------------------
  route(app, "cancelEvent", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(CancelRequestSchema, { ...(request.body as object), id })
    await service().cancel(id, { reason: body.reason ?? null, actorId: request.auth.userId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/events/:id/message  [csrf]
  // -------------------------------------------------------------------------
  route(app, "postEventMessage", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(PostMessageRequestSchema, { ...(request.body as object), id })
    await service().postMessage(id, { body: body.body, actorId: request.auth.userId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })
}
