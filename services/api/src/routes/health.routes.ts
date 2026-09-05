
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

export async function registerHealthRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  route(app, "health", async () => {
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
    reply.status(body.ok ? 200 : 503).send(body)
  })
}
