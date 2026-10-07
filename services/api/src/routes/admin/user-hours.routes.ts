import {
  AdminCreditUserHoursRequestSchema,
  AdminUserHoursQuerySchema,
  AdminVoidUserHoursRequestSchema,
  type AdminCreditUserHoursResponse,
  type AdminUserHoursResponse,
  type AdminVoidUserHoursResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireOperator } from "../../auth/admin-guard.js"
import { perIdentity } from "../../plugins/rate-limit.js"
import { route } from "../../versioning/route.js"
import { idParam, overridableService, parse, parseBodyWithId, twoIdParams } from "./_route-utils.js"
import { auditRead } from "./_audit-read.js"
import {
  makeAdminUserHoursService,
  type AdminUserHoursServiceDeps,
} from "../../services/admin/admin-user-hours-service.js"
import { makeDrizzleAdminUserRepository } from "../../services/admin/admin-user-repository.drizzle.js"
import { makeInsightsGeneration } from "../../services/host/host-analytics-cache.js"
import { makeRouteNotificationService } from "../../services/route-notifier.js"
import { makeCleanupHoursLookup } from "../volunteer-hours-wiring.js"

export type AdminUserHoursRouteOverrides = Omit<AdminUserHoursServiceDeps, "logger">

declare module "fastify" {
  interface FastifyInstance {
    adminUserHoursOverrides?: AdminUserHoursRouteOverrides
  }
}

export const ADMIN_USER_HOURS_WRITE_RATE_LIMIT = perIdentity({
  max: 30,
  timeWindow: "1 minute",
  skipOnError: false,
})

export async function registerAdminUserHoursRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  const service = overridableService(
    app,
    "adminUserHoursOverrides",
    (overrides) => makeAdminUserHoursService({ ...overrides, logger: app.log }),
    () =>
      makeAdminUserHoursService({
        hours: container.getVolunteerHoursRepo(),
        certificates: container.getCertificateRepo(),
        accounts: makeDrizzleAdminUserRepository(container.getDb().sql),
        events: makeCleanupHoursLookup(container),
        insightsInvalidator: makeInsightsGeneration({
          cache: container.getCache(),
          logger: app.log,
        }),
        notifier: makeRouteNotificationService(container, app.log),
        logger: app.log,
      }),
  )

  route(app, "getUserHours", async (request, reply) => {
    const { id } = idParam(request)
    const query = parse(AdminUserHoursQuerySchema, { ...(request.query as object), id })
    const payload: AdminUserHoursResponse = await service().getUserHours(query)
    await auditRead(request, container, requireOperator(request), {
      action: "user.hours_viewed",
      target: `user:${id}`,
      meta: { returned: payload.items.length, cursor: query.cursor ?? null },
    })
    reply.status(200).send(payload)
  })

  route(
    app,
    "creditUserHours",
    { preHandler: csrfProtect, config: { rateLimit: ADMIN_USER_HOURS_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const operatorId = requireOperator(request)
      const { body } = parseBodyWithId(AdminCreditUserHoursRequestSchema, request)
      const payload: AdminCreditUserHoursResponse = await service().creditUserHours(
        operatorId,
        body,
      )
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "voidUserHours",
    { preHandler: csrfProtect, config: { rateLimit: ADMIN_USER_HOURS_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const operatorId = requireOperator(request)
      const { id, entryId } = twoIdParams(request, "entryId")
      const body = parse(AdminVoidUserHoursRequestSchema, {
        ...(request.body as object),
        id,
        entryId,
      })
      const payload: AdminVoidUserHoursResponse = await service().voidUserHours(operatorId, body)
      reply.status(200).send(payload)
    },
  )
}
