/**
 * Admin system-health route (Phase 2).
 *
 *   GET /admin/system/health  service-health summary (SystemHealthResponse).
 *
 * Read-only operator view (no audit written for a read). The requireOperator guard is applied by
 * routes/admin/index.ts. This route wires the real dependency probes (system-health-probes.ts) from the
 * container into the SystemHealthService (which assembles the panel + degrades gracefully on any single
 * probe failure). Probes are only built when DATABASE_URL / REDIS_URL are configured, so the offline /
 * all-fakes boot never opens a connection that does not exist. Tests inject a SystemHealthService via the
 * override so no live infra is needed.
 */

import type { SystemHealthResponse } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import {
  makeSystemHealthService,
  type SystemHealthService,
} from "../../services/admin/system-health-service.js"
import { makeSystemHealthProbes } from "../../services/admin/system-health-probes.js"
import { route } from "../../versioning/route.js"

/**
 * Optional injected system-health service (tests). When present the route uses it directly instead of
 * assembling one from the container, so the whole HTTP flow runs offline with no DB / Redis / pg-boss.
 */
export interface SystemRouteOverrides {
  service: SystemHealthService
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected system-route override (tests). See SystemRouteOverrides. */
    systemOverrides?: SystemRouteOverrides
  }
}

export async function registerAdminSystemRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  // The container-backed service is stable across requests (env + probe closures don't change), so build
  // it once on first use rather than reassembling the whole graph on every /admin/system/health.
  let cached: SystemHealthService | null = null

  function service(): SystemHealthService {
    const override = app.systemOverrides
    if (override) return override.service
    if (cached) return cached

    const env = container.env
    const hasDb = typeof env.DATABASE_URL === "string" && env.DATABASE_URL.length > 0
    const hasRedis = typeof env.REDIS_URL === "string" && env.REDIS_URL.length > 0

    const probes = makeSystemHealthProbes({
      ...(hasDb ? { getSql: () => container.getDb().sql } : {}),
      ...(hasRedis ? { redisPing: () => container.getRedis().ping() } : {}),
    })

    cached = makeSystemHealthService({
      probes,
      env: {
        glitchTipConfigured:
          typeof env.GLITCHTIP_DSN === "string" && env.GLITCHTIP_DSN.length > 0,
        // The clients hardcode the CARTO Voyager raster basemap, so a tile source is always advertised.
        tileCdnConfigured: true,
        mailerIsFake: env.USE_FAKE_MAILER,
        jobsIsFake: env.USE_FAKE_JOBS,
      },
    })
    return cached
  }

  route(app, "adminSystemHealth", async (_request, reply) => {
    const payload: SystemHealthResponse = await service().health()
    reply.status(200).send(payload)
  })
}
