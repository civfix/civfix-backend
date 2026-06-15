/**
 * Base global rate-limit via @fastify/rate-limit. This is the conservative default ceiling; later
 * route steps add tighter per-route limits (e.g. OTP request, report create) using the same plugin
 * with route-level `config.rateLimit`.
 *
 * STORE: in-memory by default (works with no Redis, fine for a single instance). When a Redis client is
 * provided (production, where REDIS_URL is configured), it is passed to @fastify/rate-limit so the
 * counters are SHARED across instances - otherwise each instance would enforce the limit independently
 * and the effective ceiling would scale with the instance count. ioredis is the supported client; we
 * pass the same lazily-connecting client the rest of the app uses (the container's getRedis()).
 */

import fastifyRateLimit from "@fastify/rate-limit"
import type { FastifyInstance } from "fastify"
import type { RedisClient } from "../adapters/redis.js"
import { normalizeIp } from "../abuse/ip-rate-limit.js"

export interface RateLimitOptions {
  /** Max requests per window per key. Default 300. */
  max?: number
  /** Window duration. Default "1 minute". */
  timeWindow?: string | number
  /**
   * ioredis client to back the store across instances. Omit for the in-memory store (single instance /
   * no Redis). When provided, counters are shared cluster-wide.
   */
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
    // SECURITY: key every bucket (global + route-level) on the NORMALIZED client IP. The plugin's default
    // keyGenerator uses the full request.ip, so an IPv6 client could rotate the /64 host bits to mint a
    // fresh bucket per request and bypass the limit entirely. normalizeIp collapses IPv6 to its /64
    // prefix (IPv4 stays the full address), matching the anon abuse controls.
    keyGenerator: (req) => normalizeIp(req.ip),
    // Health/readiness checks must never be throttled. allowList as an ARRAY is matched against the
    // keyGenerator value (the IP) — so path strings never matched and these were in fact being throttled.
    // The function form receives the request, so match on the URL path (query string stripped).
    allowList: (req) => {
      const path = (req.url ?? "").split("?")[0]
      return path === "/healthz" || path === "/readyz"
    },
    // Use the shared Redis store when a client is supplied; otherwise the plugin's default in-memory LRU.
    ...(opts.redis ? { redis: opts.redis } : {}),
  })
}
