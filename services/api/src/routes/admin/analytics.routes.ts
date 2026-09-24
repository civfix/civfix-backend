import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import {
  makeAnalyticsService,
  type AnalyticsRepository,
} from "../../services/admin/analytics-service.js"
import {
  ANALYTICS_CACHE_TTL_MS,
  makeDrizzleAnalyticsRepository,
} from "../../services/admin/analytics-repository.drizzle.js"
import { route } from "../../versioning/route.js"
import { overridableService, spreadNow } from "./_route-utils.js"

export interface AnalyticsRouteOverrides {
  repo: AnalyticsRepository
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    analyticsOverrides?: AnalyticsRouteOverrides
  }
}

export async function registerAdminAnalyticsRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const service = overridableService(
    app,
    "analyticsOverrides",
    (overrides) => makeAnalyticsService({ repo: overrides.repo, ...spreadNow(overrides) }),
    () => {
      const repo: AnalyticsRepository = makeDrizzleAnalyticsRepository(container.getDb().sql, {
        cacheTtlMs: ANALYTICS_CACHE_TTL_MS,
      })
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
