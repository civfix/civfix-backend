/**
 * Admin events (cleanups) routes (Phase 2): list / detail / set-status / outcome / flag / cancel / message
 * / link-reports / unlink-report.
 *
 * Every body/query is validated against the shared Zod schema via parse(). The requireOperator guard is
 * applied by routes/admin/index.ts; mutations additionally carry csrfProtect. The acting operator's userId
 * is resolved once per handler via requireOperator(request) and recorded on every audit write (the audit
 * is written inside the service's repo transaction, atomic with the effect). The service is built lazily
 * from the container (Drizzle event repo) or from a per-instance test override (in-memory repo).
 */

import {
  AdminEventListQuerySchema,
  CancelRequestSchema,
  FlagEventRequestSchema,
  LinkEventReportsRequestSchema,
  PostMessageRequestSchema,
  SetEventOutcomeRequestSchema,
  SetEventStatusRequestSchema,
  IdSchema,
  type AdminEventDTO,
  type AdminEventListResponse,
  type AdminOkResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { csrfProtect } from "../../auth/csrf.js"
import { requireOperator } from "../../auth/admin-guard.js"
import { route } from "../../versioning/route.js"
import { idParam, parse } from "./_route-utils.js"
import {
  makeAdminEventService,
  type AdminEventRepository,
  type AdminEventService,
} from "../../services/admin/admin-event-service.js"
import { makeDrizzleAdminEventRepository } from "../../services/admin/admin-event-repository.drizzle.js"
import { MEDIA_GET_URL_TTL_SEC } from "../../services/media-intake-service.js"

// When present the routes build the service from these (an in-memory repo) instead of the container, so
// the whole HTTP flow runs offline in tests.
export interface AdminEventRouteOverrides {
  repo: AdminEventRepository
  presignThumb?: (thumbKey: string) => Promise<string>
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    adminEventOverrides?: AdminEventRouteOverrides
  }
}

export async function registerAdminEventsRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  function service(): AdminEventService {
    const overrides = app.adminEventOverrides
    if (overrides) {
      return makeAdminEventService({
        repo: overrides.repo,
        ...(overrides.presignThumb !== undefined ? { presignThumb: overrides.presignThumb } : {}),
        ...(overrides.now !== undefined ? { now: overrides.now } : {}),
      })
    }
    const repo: AdminEventRepository = makeDrizzleAdminEventRepository(container.getDb().sql)
    return makeAdminEventService({
      repo,
      presignThumb: (thumbKey) => container.storage.presignGet(thumbKey, MEDIA_GET_URL_TTL_SEC),
    })
  }

  route(app, "listAdminEvents", async (request, reply) => {
    const query = parse(AdminEventListQuerySchema, request.query)
    const payload: AdminEventListResponse = await service().list(query)
    reply.status(200).send(payload)
  })

  route(app, "getAdminEvent", async (request, reply) => {
    const { id } = idParam(request)
    const payload: AdminEventDTO = await service().get(id)
    reply.status(200).send(payload)
  })

  route(app, "setEventStatus", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id } = idParam(request)
    const body = parse(SetEventStatusRequestSchema, { ...(request.body as object), id })
    await service().setStatus(id, { status: body.status, actorId: operatorId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // Log bags collected — the only write path for cleanups.bags.
  route(app, "setEventOutcome", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id } = idParam(request)
    const body = parse(SetEventOutcomeRequestSchema, { ...(request.body as object), id })
    await service().setOutcome(id, { bags: body.bags, actorId: operatorId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(app, "flagEvent", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id } = idParam(request)
    const body = parse(FlagEventRequestSchema, { ...(request.body as object), id })
    await service().flag(id, { reason: body.reason ?? null, actorId: operatorId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(app, "cancelEvent", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id } = idParam(request)
    const body = parse(CancelRequestSchema, { ...(request.body as object), id })
    await service().cancel(id, { reason: body.reason ?? null, actorId: operatorId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(app, "postEventMessage", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id } = idParam(request)
    const body = parse(PostMessageRequestSchema, { ...(request.body as object), id })
    await service().postMessage(id, { body: body.body, actorId: operatorId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // The audit (event.reports_linked) is written inside the service's repo transaction (atomic with the
  // junction + timeline rows), using the operator userId resolved here.
  route(app, "linkEventReports", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id } = idParam(request)
    const body = parse(LinkEventReportsRequestSchema, { ...(request.body as object), id })
    await service().linkReports(id, body.reportIds, operatorId)
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(app, "unlinkEventReport", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id, reportId } = parse(
      z.object({ id: IdSchema, reportId: IdSchema }).strict(),
      request.params,
    )
    await service().unlinkReport(id, reportId, operatorId)
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })
}
