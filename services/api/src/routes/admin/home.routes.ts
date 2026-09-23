import type { HomeMapResponse, HomeSummaryResponse } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { makeHomeService, type HomeRepository } from "../../services/admin/home-service.js"
import { makeDrizzleHomeRepository } from "../../services/admin/home-repository.drizzle.js"
import {
  ANALYTICS_CACHE_TTL_MS,
  makeDrizzleAnalyticsRepository,
} from "../../services/admin/analytics-repository.drizzle.js"
import type { AnalyticsRepository } from "../../services/admin/analytics-service.js"
import { route } from "../../versioning/route.js"
import { overridableService, spreadNow } from "./_route-utils.js"

export interface HomeRouteOverrides {
  repo: HomeRepository
  analytics: AnalyticsRepository
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    homeOverrides?: HomeRouteOverrides
  }
}

export async function registerAdminHomeRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const onSectionError = (section: string, err: unknown) =>
    app.log.warn({ err, section }, "admin home summary section failed")

  const service = overridableService(
    app,
    "homeOverrides",
    (overrides) =>
      makeHomeService({
        repo: overrides.repo,
        analytics: overrides.analytics,
        ...spreadNow(overrides),
        onSectionError,
      }),
    () => {
      const sql = container.getDb().sql
      const repo: HomeRepository = makeDrizzleHomeRepository(sql)
      const analytics: AnalyticsRepository = makeDrizzleAnalyticsRepository(sql, {
        cacheTtlMs: ANALYTICS_CACHE_TTL_MS,
      })
      return makeHomeService({ repo, analytics, onSectionError })
    },
  )

  route(app, "adminHomeSummary", async (_request, reply) => {
    const payload: HomeSummaryResponse = await service().summary()
    reply.status(200).send(payload)
  })

  route(app, "adminHomeMap", async (_request, reply) => {
    const payload: HomeMapResponse = await service().map()
    reply.status(200).send(payload)
  })
}
