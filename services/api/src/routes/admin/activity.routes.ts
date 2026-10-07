/**
 * GET /admin/activity: a union of audit_log entries and recent domain events (new reports, cleanups, mail
 * bounces). No read audit (aggregate view).
 *
 * `filter` and `sort` are free-form strings on the wire and are forwarded verbatim: the service normalizes
 * them so an unrecognized value degrades to the default instead of 422ing or reaching SQL.
 */

import { ActivityListQuerySchema, type ActivityListResponse } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { overridableService, parse, spreadNow } from "./_route-utils.js"
import { makeActivityService } from "../../services/admin/activity-service.js"
import type { ActivityRepository } from "../../services/admin/activity-repository.js"
import { makeDrizzleActivityRepository } from "../../services/admin/activity-repository.drizzle.js"
import { route } from "../../versioning/route.js"

/** Injected activity-service deps (tests), so the whole HTTP flow runs offline. */
export interface ActivityRouteOverrides {
  repo: ActivityRepository
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    activityOverrides?: ActivityRouteOverrides
  }
}

export async function registerAdminActivityRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const service = overridableService(
    app,
    "activityOverrides",
    (overrides) => makeActivityService({ repo: overrides.repo, ...spreadNow(overrides) }),
    () => {
      const repo: ActivityRepository = makeDrizzleActivityRepository(container.getDb().sql)
      return makeActivityService({ repo })
    },
  )

  route(app, "adminActivity", async (request, reply) => {
    const query = parse(ActivityListQuerySchema, request.query)
    const payload: ActivityListResponse = await service().list(query)
    reply.status(200).send(payload)
  })
}
