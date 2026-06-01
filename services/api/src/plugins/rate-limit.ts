/**
 * Base global rate-limit via @fastify/rate-limit. This is the conservative default ceiling; later
 * route steps add tighter per-route limits (e.g. OTP request, report create) using the same plugin
 * with route-level `config.rateLimit`.
 *
 * In-memory store is used here. A Redis-backed store can be wired later for multi-instance limits
 * by passing the ioredis client; kept simple for the scaffold so it works with no Redis.
 */

import fastifyRateLimit from "@fastify/rate-limit"
import type { FastifyInstance } from "fastify"

export interface RateLimitOptions {
  /** Max requests per window per key. Default 300. */
  max?: number
  /** Window duration. Default "1 minute". */
  timeWindow?: string | number
}

export async function registerRateLimit(
  app: FastifyInstance,
  opts: RateLimitOptions = {},
): Promise<void> {
  await app.register(fastifyRateLimit, {
    global: true,
    max: opts.max ?? 300,
    timeWindow: opts.timeWindow ?? "1 minute",
    // Health/readiness checks must never be throttled.
    allowList: ["/healthz", "/readyz"],
  })
}
