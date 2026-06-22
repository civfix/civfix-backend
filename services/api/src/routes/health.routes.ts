/**
 * Liveness and readiness routes.
 *
 *   GET /healthz  liveness: pure, no dependencies. Always 200 while the process is up. Used by the
 *                 load balancer / Caddy and by unit tests (works with no DB/Redis).
 *   GET /readyz   readiness: pings DB and Redis when they are wired (real seams). In all-fakes mode
 *                 there is nothing to check, so each check reports "skipped" and the overall status
 *                 is 200. If a real handle exists but its ping fails, returns 503.
 */

import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { route } from "../versioning/route.js"
import { SERVICE_NAME, SERVICE_VERSION } from "../version.js"

type CheckStatus = "ok" | "skipped" | "down"

interface ReadyBody {
  ok: boolean
  checks: {
    db: CheckStatus
    redis: CheckStatus
  }
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  route(app, "health", async () => {
    return { ok: true, service: SERVICE_NAME, version: SERVICE_VERSION }
  })

  app.get("/readyz", async (_request, reply) => {
    // Probe a backend only when a real consumer would have created its handle, OR one already exists
    // (handles are lazy, so an existing handle is the unambiguous "real" signal). The env-flag fallback
    // mirrors di.ts's real-vs-fake wiring; when di.ts grows a `container.usesRealDb`, prefer that to
    // remove this hand-enumeration. (USE_FAKE_JOBS/PUSH/CHAT are the seams that force a DB handle; CHAT
    // is the only Redis consumer outside the rate-limit store.)
    const env = container.env
    const realDbConsumer = !(env.USE_FAKE_CHAT && env.USE_FAKE_PUSH && env.USE_FAKE_JOBS)
    const realRedisConsumer = !env.USE_FAKE_CHAT

    const body: ReadyBody = {
      ok: true,
      checks: { db: "skipped", redis: "skipped" },
    }

    if (realDbConsumer || container.dbHandle) {
      try {
        const handle = container.getDb()
        await handle.sql`select 1`
        body.checks.db = "ok"
      } catch (err) {
        app.log.error({ err }, "readyz: db ping failed")
        body.checks.db = "down"
        body.ok = false
      }
    }

    if (realRedisConsumer || container.redis) {
      try {
        const redis = container.getRedis()
        const pong = await redis.ping()
        body.checks.redis = pong === "PONG" ? "ok" : "down"
        if (body.checks.redis === "down") body.ok = false
      } catch (err) {
        app.log.error({ err }, "readyz: redis ping failed")
        body.checks.redis = "down"
        body.ok = false
      }
    }

    reply.status(body.ok ? 200 : 503).send(body)
  })
}
