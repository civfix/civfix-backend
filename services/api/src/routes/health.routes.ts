/**
 * Liveness and readiness routes.
 *
 *   GET /healthz  liveness: pure, no dependencies. Always 200 while the process is up. Used by the
 *                 load balancer / Caddy and by unit tests (works with no DB/Redis).
 *   GET /readyz   readiness: pings DB and Redis when they are wired (real seams). In all-fakes mode
 *                 there is nothing to check, so each check reports "skipped" and the overall status
 *                 is 200. If a real handle exists but its ping fails, returns 503.
 *
 * L19 hardening. Both probes are unauthenticated, so both are attack surface:
 *   - /readyz is no longer exempt from rate limiting (see plugins/rate-limit.ts) AND its result is memoized
 *     for READY_CACHE_MS. It does real I/O — `select 1` against a 10-connection pool plus a Redis PING —
 *     so an uncapped, uncached probe was a cheap amplifier: one HTTP request per DB round-trip. The cache
 *     keeps the probe honest for an orchestrator polling every few seconds while flattening a flood into
 *     at most one backend check per window.
 *   - /healthz no longer discloses the build version. Liveness needs `{ok:true}`; publishing the exact
 *     running version to anonymous callers only helps someone match us against a CVE list. The version is
 *     still available to operators via the authenticated admin system-health surface.
 */

import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { route } from "../versioning/route.js"
import { SERVICE_NAME } from "../version.js"

type CheckStatus = "ok" | "skipped" | "down"

interface ReadyBody {
  ok: boolean
  checks: {
    db: CheckStatus
    redis: CheckStatus
  }
}

/** How long a readiness verdict is reused before the backends are probed again. */
export const READY_CACHE_MS = 5_000

export async function registerHealthRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  route(app, "health", async () => {
    return { ok: true, service: SERVICE_NAME }
  })

  // Memoized readiness verdict (L19). Concurrent hits share the SAME in-flight probe promise, so a burst
  // of N requests costs one `select 1` + one PING, not N of each.
  let cached: { at: number; body: ReadyBody } | undefined
  let inFlight: Promise<ReadyBody> | undefined

  async function readiness(): Promise<ReadyBody> {
    const now = Date.now()
    if (cached && now - cached.at < READY_CACHE_MS) return cached.body
    if (inFlight) return inFlight
    inFlight = probe()
      .then((body) => {
        cached = { at: Date.now(), body }
        return body
      })
      .finally(() => {
        inFlight = undefined
      })
    return inFlight
  }

  async function probe(): Promise<ReadyBody> {
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

    return body
  }

  app.get("/readyz", async (_request, reply) => {
    const body = await readiness()
    reply.status(body.ok ? 200 : 503).send(body)
  })
}
