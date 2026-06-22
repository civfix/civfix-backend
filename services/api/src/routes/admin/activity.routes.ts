/**
 * Admin activity-feed route (Phase 2).
 *
 *   GET /admin/activity  the recent activity feed (ActivityListResponse): a union of audit_log entries +
 *                        recent domain events (new reports, cleanups, mail bounces).
 *
 * Read-only operator view (no audit written for a read). The requireOperator guard is applied by
 * routes/admin/index.ts. The query is validated against the shared ActivityListQuerySchema via parse().
 * The service is built lazily from the container (Drizzle repo) or a test override (in-memory repo).
 */

import { ActivityListQuerySchema, type ActivityListResponse } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { parse } from "./_route-utils.js"
import {
  makeActivityService,
  type ActivityRepository,
  type ActivityService,
} from "../../services/admin/activity-service.js"
import { makeDrizzleActivityRepository } from "../../services/admin/activity-repository.drizzle.js"
import { route } from "../../versioning/route.js"

/**
 * Optional injected activity-service dependencies (tests). When present the route builds the service from
 * these (an in-memory repo) instead of the container, so the whole HTTP flow runs offline.
 */
export interface ActivityRouteOverrides {
  repo: ActivityRepository
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected activity-route overrides (tests). See ActivityRouteOverrides. */
    activityOverrides?: ActivityRouteOverrides
  }
}

export async function registerAdminActivityRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the activity service from injected overrides (tests) or the container (production). */
  function service(): ActivityService {
    const overrides = app.activityOverrides
    if (overrides) {
      return makeActivityService({
        repo: overrides.repo,
        ...(overrides.now !== undefined ? { now: overrides.now } : {}),
      })
    }
    const repo: ActivityRepository = makeDrizzleActivityRepository(container.getDb().sql)
    return makeActivityService({ repo })
  }

  route(app, "adminActivity", async (request, reply) => {
    const query = parse(ActivityListQuerySchema, request.query)
    const payload: ActivityListResponse = await service().list({
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    })
    reply.status(200).send(payload)
  })
}
