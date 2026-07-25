/**
 * Admin home / dashboard routes (Phase 2).
 *
 *   GET /admin/home/summary  the per-section dashboard aggregate (HomeSummaryResponse).
 *   GET /admin/home/map      the live-map feed of recent reports + events (HomeMapResponse).
 *
 * Read-only operator views (no audit written for a read). The requireOperator guard is applied by
 * routes/admin/index.ts. The summary is RESILIENT: a single failing sub-aggregate degrades only that card
 * (the service guards each section), and the route passes a logger so a degraded card is observable. The
 * service is built lazily from the container (Drizzle home + analytics repos) or a test override.
 */

import type { HomeMapResponse, HomeSummaryResponse } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { makeHomeService, type HomeRepository } from "../../services/admin/home-service.js"
import { makeDrizzleHomeRepository } from "../../services/admin/home-repository.drizzle.js"
import { makeDrizzleAnalyticsRepository } from "../../services/admin/analytics-repository.drizzle.js"
import type { AnalyticsRepository } from "../../services/admin/analytics-service.js"
import { route } from "../../versioning/route.js"
import { overridableService, spreadNow } from "./_route-utils.js"

/**
 * Optional injected home-service dependencies (tests). When present the routes build the service from
 * these (in-memory repos) instead of the container, so the whole HTTP flow runs offline.
 */
export interface HomeRouteOverrides {
  repo: HomeRepository
  analytics: AnalyticsRepository
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected home-route overrides (tests). See HomeRouteOverrides. */
    homeOverrides?: HomeRouteOverrides
  }
}

export async function registerAdminHomeRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const onSectionError = (section: string, err: unknown) =>
    app.log.warn({ err, section }, "admin home summary section failed")

  /** Build the home service from injected overrides (tests) or the container (production). */
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
      const analytics: AnalyticsRepository = makeDrizzleAnalyticsRepository(sql)
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
