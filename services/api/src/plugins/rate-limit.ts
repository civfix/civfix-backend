
import fastifyRateLimit from "@fastify/rate-limit"
import type { FastifyInstance } from "fastify"
import type { RedisClient } from "../adapters/redis.js"
import { normalizeIp } from "../abuse/ip-rate-limit.js"

const RATE_LIMIT_ALLOWLIST = new Set(["/healthz", "/readyz"])

export interface RateLimitOptions {
  max?: number
  timeWindow?: string | number
  redis?: RedisClient
}

export async function registerRateLimit(
  app: FastifyInstance,
  opts: RateLimitOptions = {},
): Promise<void> {
  await app.register(fastifyRateLimit, {
    global: true,
    max: opts.max ?? 300,
    timeWindow: opts.timeWindow ?? "1 minute",
    keyGenerator: (req) => normalizeIp(req.ip),
    allowList: (req) => RATE_LIMIT_ALLOWLIST.has((req.url ?? "").split("?")[0] ?? ""),
    skipOnError: true,
    onExceeded: (req, key) => {
      req.log.debug({ key, path: (req.url ?? "").split("?")[0] }, "rate limit exceeded")
    },
    ...(opts.redis ? { redis: opts.redis } : {}),
  })
}
