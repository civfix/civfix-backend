
import type { SystemHealthResponse } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import {
  makeSystemHealthService,
  type SystemHealthService,
} from "../../services/admin/system-health-service.js"
import { makeSystemHealthProbes } from "../../services/admin/system-health-probes.js"
import { route } from "../../versioning/route.js"

export interface SystemRouteOverrides {
  service: SystemHealthService
}

declare module "fastify" {
  interface FastifyInstance {
    systemOverrides?: SystemRouteOverrides
  }
}

export async function registerAdminSystemRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
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
      log: (err, meta) => app.log.warn({ err, ...meta }, "admin system-health probe failed"),
      env: {
        glitchTipConfigured:
          typeof env.GLITCHTIP_DSN === "string" && env.GLITCHTIP_DSN.length > 0,
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
