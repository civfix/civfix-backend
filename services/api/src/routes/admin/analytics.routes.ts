/**
 * Admin analytics routes (Phase 2). All read-only aggregate queries; one endpoint per card (#56-#66).
 *
 *   GET /admin/analytics/kpis                    headline KPIs + deltas (AnalyticsKpisResponse).
 *   GET /admin/analytics/pins-by-week            8-week pin trend (AnalyticsPinsByWeekResponse).
 *   GET /admin/analytics/by-category             counts + pct per category (AnalyticsByCategoryResponse).
 *   GET /admin/analytics/funnel                  pin->routed->ack->resolved (AnalyticsFunnelResponse).
 *   GET /admin/analytics/coverage                mapped vs needs-mapping (AnalyticsCoverageResponse).
 *   GET /admin/analytics/resolution-by-category  median hours/category (AnalyticsResolutionByCategoryResponse).
 *   GET /admin/analytics/events                  cleanup events trend (AnalyticsEventsResponse).
 *   GET /admin/analytics/top-jurisdictions       by pin volume + resolved (AnalyticsTopJurisdictionsResponse).
 *   GET /admin/analytics/top-contributors        reports + cleanups per user (AnalyticsTopContributorsResponse).
 *   GET /admin/analytics/heatmap                 per-jurisdiction density (AnalyticsHeatmapResponse).
 *   GET /admin/analytics/retention               cohort retention (AnalyticsRetentionResponse).
 *
 * Read-only operator views (no audit written for a read). The requireOperator guard is applied by
 * routes/admin/index.ts. These take no body/params; the service does the aggregation + shaping. The
 * service is built lazily from the container (Drizzle repo) or a test override (in-memory repo).
 */

import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import {
  makeAnalyticsService,
  type AnalyticsRepository,
} from "../../services/admin/analytics-service.js"
import { makeDrizzleAnalyticsRepository } from "../../services/admin/analytics-repository.drizzle.js"
import { route } from "../../versioning/route.js"
import { overridableService, spreadNow } from "./_route-utils.js"

/**
 * Optional injected analytics-service dependencies (tests). When present the routes build the service from
 * these (an in-memory repo) instead of the container, so the whole HTTP flow runs offline.
 */
export interface AnalyticsRouteOverrides {
  repo: AnalyticsRepository
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected analytics-route overrides (tests). See AnalyticsRouteOverrides. */
    analyticsOverrides?: AnalyticsRouteOverrides
  }
}

export async function registerAdminAnalyticsRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the analytics service from injected overrides (tests) or the container (production). */
  const service = overridableService(
    app,
    "analyticsOverrides",
    (overrides) => makeAnalyticsService({ repo: overrides.repo, ...spreadNow(overrides) }),
    () => {
      const repo: AnalyticsRepository = makeDrizzleAnalyticsRepository(container.getDb().sql)
      return makeAnalyticsService({ repo })
    },
  )

  route(app, "analyticsKpis", async (_request, reply) => {
    reply.status(200).send(await service().kpis())
  })

  route(app, "analyticsPinsByWeek", async (_request, reply) => {
    reply.status(200).send(await service().pinsByWeek())
  })

  route(app, "analyticsByCategory", async (_request, reply) => {
    reply.status(200).send(await service().byCategory())
  })

  route(app, "analyticsFunnel", async (_request, reply) => {
    reply.status(200).send(await service().funnel())
  })

  route(app, "analyticsCoverage", async (_request, reply) => {
    reply.status(200).send(await service().coverage())
  })

  route(app, "analyticsResolutionByCategory", async (_request, reply) => {
    reply.status(200).send(await service().resolutionByCategory())
  })

  route(app, "analyticsEvents", async (_request, reply) => {
    reply.status(200).send(await service().events())
  })

  route(app, "analyticsTopJurisdictions", async (_request, reply) => {
    reply.status(200).send(await service().topJurisdictions())
  })

  route(app, "analyticsTopContributors", async (_request, reply) => {
    reply.status(200).send(await service().topContributors())
  })

  route(app, "analyticsHeatmap", async (_request, reply) => {
    reply.status(200).send(await service().heatmap())
  })

  route(app, "analyticsRetention", async (_request, reply) => {
    reply.status(200).send(await service().retention())
  })
}
