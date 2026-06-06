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
  type AnalyticsService,
} from "../../services/admin/analytics-service.js"
import { makeDrizzleAnalyticsRepository } from "../../services/admin/analytics-repository.drizzle.js"

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
  function service(): AnalyticsService {
    const overrides = app.analyticsOverrides
    if (overrides) {
      return makeAnalyticsService({
        repo: overrides.repo,
        ...(overrides.now !== undefined ? { now: overrides.now } : {}),
      })
    }
    const repo: AnalyticsRepository = makeDrizzleAnalyticsRepository(container.getDb().sql)
    return makeAnalyticsService({ repo })
  }

  app.get("/admin/analytics/kpis", async (_request, reply) => {
    reply.status(200).send(await service().kpis())
  })

  app.get("/admin/analytics/pins-by-week", async (_request, reply) => {
    reply.status(200).send(await service().pinsByWeek())
  })

  app.get("/admin/analytics/by-category", async (_request, reply) => {
    reply.status(200).send(await service().byCategory())
  })

  app.get("/admin/analytics/funnel", async (_request, reply) => {
    reply.status(200).send(await service().funnel())
  })

  app.get("/admin/analytics/coverage", async (_request, reply) => {
    reply.status(200).send(await service().coverage())
  })

  app.get("/admin/analytics/resolution-by-category", async (_request, reply) => {
    reply.status(200).send(await service().resolutionByCategory())
  })

  app.get("/admin/analytics/events", async (_request, reply) => {
    reply.status(200).send(await service().events())
  })

  app.get("/admin/analytics/top-jurisdictions", async (_request, reply) => {
    reply.status(200).send(await service().topJurisdictions())
  })

  app.get("/admin/analytics/top-contributors", async (_request, reply) => {
    reply.status(200).send(await service().topContributors())
  })

  app.get("/admin/analytics/heatmap", async (_request, reply) => {
    reply.status(200).send(await service().heatmap())
  })

  app.get("/admin/analytics/retention", async (_request, reply) => {
    reply.status(200).send(await service().retention())
  })
}
