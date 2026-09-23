/**
 * Every audit is written inside the service's repo transaction with the operator id resolved here, so the
 * audit row and the effect commit or roll back together.
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

/** Shared with the org routes (adminListOrgEvents). */
export function makeContainerAdminEventService(
  app: FastifyInstance,
  container: Container,
): () => AdminEventService {
  return overridableService(
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
}

export async function registerAdminEventsRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  const service = makeContainerAdminEventService(app, container)

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

  // The only write path for cleanups.bags.
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
