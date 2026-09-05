/**
 * Liveness and readiness routes.
 *
 *   GET /healthz  liveness: pure, no dependencies, always `Cache-Control: no-store` so no edge or
 *                 client ever serves a stale verdict. 200 while the process is serving; 503 plus the
 *                 x-civfix-draining header once SIGTERM has started the shutdown drain (lifecycle.ts),
 *                 which is how the blue/green load balancer pulls a retiring api color out of the pool
 *                 BEFORE its listener closes. Used by the load balancer / Caddy and by unit tests
 *                 (works with no DB/Redis).
 *   GET /readyz   readiness, also `Cache-Control: no-store` (the deploy gate polls it through
 *                 Cloudflare): pings DB and Redis when they are wired (real seams). In all-fakes mode
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

const READY_CACHE_MS = 5_000

/**
 * Drain marker. It rides in a RESPONSE HEADER so the public 503 body stays a bare {ok:false} - no
 * deploy state mixed into the JSON every client parses, and cross-origin browser JS cannot read it
 * (no Access-Control-Expose-Headers). It is NOT a secret either way: any `curl -I` sees it. The
 * deploy workflows read it to tell a by-design retiring-color 503 from a real outage.
 */
export const DRAINING_HEADER = "x-civfix-draining"

export async function registerHealthRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  route(app, "health", async (_request, reply) => {
    reply.header("cache-control", "no-store")
    if (app.lifecycle.isDraining()) {
      reply.header(DRAINING_HEADER, "1")
      reply.status(503)
      return { ok: false }
    }
    return { ok: true, service: SERVICE_NAME }
  })

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
    const realDbConsumer = container.usesRealDb
    const realRedisConsumer = container.usesRealRedis

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
    reply.header("cache-control", "no-store")
    reply.status(body.ok ? 200 : 503).send(body)
  })
}
