/**
 * Both probes send `Cache-Control: no-store` because the deploy gate polls them through Cloudflare.
 * /healthz answers 503 plus the draining header once SIGTERM starts the drain (lifecycle.ts), which is how
 * blue/green pulls a retiring api color out of the pool BEFORE its listener closes.
 *
 * Both are unauthenticated attack surface. /readyz does real I/O (`select 1` on a 10-connection pool plus a
 * Redis PING), so it is rate limited and memoized for READY_CACHE_MS: an uncached probe was a cheap
 * amplifier, one HTTP request per DB round-trip. /healthz does not disclose the build version, which would
 * only help someone match us against a CVE list; operators see it on the admin system-health surface.
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

const NO_STORE = "no-store"
const REDIS_PING_REPLY = "PONG"
const HTTP_OK = 200
const HTTP_SERVICE_UNAVAILABLE = 503

/**
 * A header, not a body field, so the public 503 body stays a bare {ok:false} and cross-origin browser JS
 * cannot read it (no Access-Control-Expose-Headers). It is not a secret: any `curl -I` sees it. The deploy
 * workflows read it to tell a by-design retiring-color 503 from a real outage.
 */
export const DRAINING_HEADER = "x-civfix-draining"

export async function registerHealthRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  route(app, "health", async (_request, reply) => {
    reply.header("cache-control", NO_STORE)
    if (app.lifecycle.isDraining()) {
      reply.header(DRAINING_HEADER, "1")
      reply.status(HTTP_SERVICE_UNAVAILABLE)
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
        body.checks.redis = pong === REDIS_PING_REPLY ? "ok" : "down"
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
    reply.header("cache-control", NO_STORE)
    reply.status(body.ok ? HTTP_OK : HTTP_SERVICE_UNAVAILABLE).send(body)
  })
}
