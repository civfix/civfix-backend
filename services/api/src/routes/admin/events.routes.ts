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
  type AdminEventDTO,
  type AdminEventListResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireOperator } from "../../auth/admin-guard.js"
import { route } from "../../versioning/route.js"
import {
  idParam,
  overridableService,
  parse,
  parseBodyWithId,
  sendOk,
  spreadNow,
  twoIdParams,
} from "./_route-utils.js"
import {
  makeAdminEventService,
  type AdminEventRepository,
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
  const csrfProtect = container.csrf.protect

  const service = overridableService(
    app,
    "adminEventOverrides",
    (overrides) =>
      makeAdminEventService({
        repo: overrides.repo,
        ...(overrides.presignThumb !== undefined ? { presignThumb: overrides.presignThumb } : {}),
        ...spreadNow(overrides),
      }),
    () => {
      const repo: AdminEventRepository = makeDrizzleAdminEventRepository(container.getDb().sql)
      return makeAdminEventService({
        repo,
        presignThumb: (thumbKey) => container.storage.presignGet(thumbKey, MEDIA_GET_URL_TTL_SEC),
      })
    },
  )

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
    const { id, body } = parseBodyWithId(SetEventStatusRequestSchema, request)
    await service().setStatus(id, { status: body.status, actorId: operatorId })
    sendOk(reply)
  })

  // Log bags collected — the only write path for cleanups.bags.
  route(app, "setEventOutcome", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id, body } = parseBodyWithId(SetEventOutcomeRequestSchema, request)
    await service().setOutcome(id, { bags: body.bags, actorId: operatorId })
    sendOk(reply)
  })

  route(app, "flagEvent", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id, body } = parseBodyWithId(FlagEventRequestSchema, request)
    await service().flag(id, { reason: body.reason ?? null, actorId: operatorId })
    sendOk(reply)
  })

  route(app, "cancelEvent", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id, body } = parseBodyWithId(CancelRequestSchema, request)
    await service().cancel(id, { reason: body.reason ?? null, actorId: operatorId })
    sendOk(reply)
  })

  route(app, "postEventMessage", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id, body } = parseBodyWithId(PostMessageRequestSchema, request)
    await service().postMessage(id, { body: body.body, actorId: operatorId })
    sendOk(reply)
  })

  // The audit (event.reports_linked) is written inside the service's repo transaction (atomic with the
  // junction + timeline rows), using the operator userId resolved here.
  route(app, "linkEventReports", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id, body } = parseBodyWithId(LinkEventReportsRequestSchema, request)
    await service().linkReports(id, body.reportIds, operatorId)
    sendOk(reply)
  })

  route(app, "unlinkEventReport", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id, reportId } = twoIdParams(request, "reportId")
    await service().unlinkReport(id, reportId, operatorId)
    sendOk(reply)
  })
}
