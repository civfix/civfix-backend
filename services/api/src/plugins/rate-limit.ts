/**
 * HTTP rate limiting.
 *
 * TWO limiters, deliberately, because "browsing the map" and "grinding OTP codes" must fail in opposite
 * directions when the Redis store is sick:
 *
 *   1. The GLOBAL bucket (300/min) covers ordinary traffic and is `skipOnError: true` — a Redis blip must
 *      not take the read-only product offline.
 *   2. The SENSITIVE bucket covers the abuse-relevant prefixes (auth, admin auth, WS tickets, anon
 *      reporting, media presign, claim redemption, public form intake) and is `skipOnError: false` — it
 *      FAILS CLOSED. H4:
 *      previously every bucket was skipOnError:true, so one Redis error silently removed the OTP,
 *      OAuth, anon-report and media-presign limits at the same time, and a *misconfigured* REDIS_URL
 *      produced an API that booted happily with no rate limiting at all. (di.assertRedisReachable adds
 *      the boot-time PING so that misconfiguration is loud rather than merely fail-closed.)
 *
 * Route-level `config.rateLimit` buckets (OTP 5/min etc.) still inherit the global, skip-on-error store;
 * the sensitive limiter sits UNDER them as the fail-closed floor for those same paths.
 *
 * KEYING (M22): the key is the authenticated user id when there is one, else the normalized IP. An
 * authenticated attacker used to escape any limit simply by rotating IPs while their account was never
 * counted. Ordering matters and holds: `registerAuthContext` adds an INSTANCE-level `onRequest` hook, and
 * both limiters run as ROUTE-level `onRequest` handlers, which Fastify executes after all instance-level
 * hooks of the same phase — so `req.auth` is always resolved before a keyGenerator reads it. The optional
 * chain is the safety net for bare test servers that mount a route without the auth plugin.
 *
 * ALLOWLIST (L19): only `/healthz` (a pure, I/O-free liveness reply) is exempt. `/readyz` used to be
 * exempt too while doing a real `select 1` + Redis PING per hit — an unauthenticated amplifier against a
 * 10-connection pool; it now takes the normal global bucket and caches its result (health.routes.ts).
 */

import fastifyRateLimit from "@fastify/rate-limit"
import { AppError } from "@civfix/shared"
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestAsyncHookHandler,
} from "fastify"
import type { RedisClient } from "../adapters/redis.js"
import { normalizeIp } from "../abuse/ip-rate-limit.js"

/** Only the I/O-free liveness probe is exempt. `/readyz` is deliberately NOT here (L19). */
const RATE_LIMIT_ALLOWLIST = new Set(["/healthz"])

/**
 * Path prefixes whose limits must survive a Redis outage. Everything that mints credentials, consumes a
 * one-shot secret, creates content without an account, or hands out an upload URL.
 */
export const SENSITIVE_RATE_LIMIT_PREFIXES: readonly string[] = [
  "/v1/auth",
  // The web OAuth redirect flow is registered UNVERSIONED — /auth/google/start, /auth/google/callback,
  // /auth/apple/start, /auth/apple/callback — so "/v1/auth" does not cover it. Without this entry the
  // entire browser sign-in surface kept only its inherited fail-OPEN bucket, which is the exact condition
  // this limiter exists to close.
  "/auth",
  "/v1/admin/auth",
  // Mints a bearer credential for the WS upgrade, so it belongs with the other credential-minting paths:
  // its own per-route bucket inherits the fail-OPEN global store, which is what this bucket backstops.
  "/v1/ws-ticket",
  "/v1/anon",
  "/v1/media",
  "/v1/claim",
  // Enumerated by the original H4 finding as a bucket that vanishes on a store error: one call assembles
  // and mails a full personal-data archive.
  "/v1/me/data-export",
  // Mints a durable, publicly-verifiable artifact from personal data and hands back a capability URL —
  // squarely in this list's stated scope. `isSensitivePath` matches `path === p || startsWith(p + "/")`,
  // so the plain `GET /v1/me/volunteer-hours` read is NOT dragged into this fail-closed bucket.
  //
  // ⚠ "/v1/service-hours/verify" must NOT be added here (C3). This bucket is fail-CLOSED
  // (skipOnError: false, below), so a Redis blip would 429 the PUBLIC verification read — the school
  // registrar holding a printed transcript is the one audience this feature exists for. A read-only
  // lookup mints nothing, consumes no one-shot secret and hands out no upload URL; it keeps the
  // fail-OPEN global bucket plus its own 60/min route limit. A negative case in
  // test/unit/rate-limit-plugin.test.ts pins this so a later "tighten the limits" pass cannot quietly
  // re-add it.
  "/v1/me/volunteer-hours/certificates",
  "/forms",
]

/** Ceiling for the fail-closed bucket: well above every per-route limit it backstops, per key per minute. */
const SENSITIVE_MAX = 60
const SENSITIVE_WINDOW = "1 minute"

export interface RateLimitOptions {
  max?: number
  timeWindow?: string | number
  redis?: RedisClient
  /** Ceiling for the fail-closed sensitive-prefix bucket (tests lower it to assert the 429). */
  sensitiveMax?: number
}

/** Path without its query string. */
function pathOf(url: string | undefined): string {
  return (url ?? "").split("?")[0] ?? ""
}

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_RATE_LIMIT_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))
}

/**
 * IP key for the GLOBAL bucket, and the floor under everything.
 *
 * This must never be replaced by the caller's identity. An earlier cut of M22 returned
 * `user:<id> ?? ip:<ip>`, which dropped the IP entirely for any authenticated request — so one host
 * holding N accounts got N × every budget (N × 300/min globally, N × 30/min on media presign, and so on),
 * where before it was capped at a single bucket. That is strictly weaker than what it replaced. The
 * per-IP ceiling has to hold regardless of whether a session was presented; identity is an ADDITIONAL
 * dimension, counted by the sensitive bucket below, not a substitute.
 */
export function rateLimitKey(req: FastifyRequest): string {
  return `ip:${normalizeIp(req.ip)}`
}

export function identityRateLimitKey(req: FastifyRequest): string {
  const userId = req.auth?.userId
  return userId ? `user:${userId}` : `ip:${normalizeIp(req.ip)}`
}

export interface RouteRateLimitSpec {
  max: number
  timeWindow: string | number
  hostMax?: number
  skipOnError?: boolean
}

const ROUTE_RATE_LIMIT_POLICY: unique symbol = Symbol("civfix.routeRateLimitPolicy")

export type RouteRateLimitPolicy = Readonly<RouteRateLimitSpec> & {
  readonly keyGenerator?: (req: FastifyRequest) => string
  readonly [ROUTE_RATE_LIMIT_POLICY]: true
}

export const HOST_CEILING_MULTIPLIER = 10

const SENSITIVE_BUCKET = "sensitive"
const WS_UPGRADE_BUCKET = "ws-upgrade"
const STORE_ERROR_RETRY_AFTER_SECONDS = 5

export function sensitiveRateLimitKey(req: FastifyRequest): string {
  return `${SENSITIVE_BUCKET}:${identityRateLimitKey(req)}`
}

export function wsUpgradeRateLimitKey(req: FastifyRequest): string {
  return `${WS_UPGRADE_BUCKET}:ip:${normalizeIp(req.ip)}`
}

export function perIdentity(spec: RouteRateLimitSpec): RouteRateLimitPolicy {
  return Object.freeze({
    ...spec,
    keyGenerator: identityRateLimitKey,
    [ROUTE_RATE_LIMIT_POLICY]: true as const,
  })
}

export function perHost(spec: RouteRateLimitSpec): RouteRateLimitPolicy {
  return Object.freeze({ ...spec, [ROUTE_RATE_LIMIT_POLICY]: true as const })
}

export interface RateLimitVerdict {
  max: number
  remaining: number
  ttlInSeconds: number
}

export function applyRateLimitHeaders(reply: FastifyReply, verdict: RateLimitVerdict): void {
  reply.header("x-ratelimit-limit", verdict.max)
  reply.header("x-ratelimit-remaining", verdict.remaining)
  reply.header("x-ratelimit-reset", verdict.ttlInSeconds)
  reply.header("retry-after", verdict.ttlInSeconds)
}

export async function registerRateLimit(
  app: FastifyInstance,
  opts: RateLimitOptions = {},
): Promise<void> {
  await app.register(fastifyRateLimit, {
    global: true,
    max: opts.max ?? 300,
    timeWindow: opts.timeWindow ?? "1 minute",
    keyGenerator: rateLimitKey,
    allowList: (req) => RATE_LIMIT_ALLOWLIST.has(pathOf(req.url)),
    // Lax on purpose: see the module header. The sensitive prefixes get the fail-closed limiter below.
    skipOnError: true,
    onExceeded: (req, key) => {
      req.log.debug({ key, path: pathOf(req.url) }, "rate limit exceeded")
    },
    ...(opts.redis ? { redis: opts.redis } : {}),
  })

  // `createRateLimit` (as opposed to `rateLimit`) hands back a bare checker with no headers, no 429
  // throwing, and — crucially — no `rateLimitRan` short-circuit, so this bucket is counted INDEPENDENTLY
  // of the global one that already ran on the same request.
  const checkSensitive = app.createRateLimit({
    max: opts.sensitiveMax ?? SENSITIVE_MAX,
    timeWindow: SENSITIVE_WINDOW,
    keyGenerator: sensitiveRateLimitKey,
    // Never inherit the global allowList here; these prefixes are exempt from nothing.
    allowList: () => false,
    // THE POINT: a store error propagates instead of waving the request through.
    skipOnError: false,
  })

  const sensitiveHook: onRequestAsyncHookHandler = async (req, reply) => {
    let result: Awaited<ReturnType<typeof checkSensitive>>
    try {
      result = await checkSensitive(req)
    } catch (err) {
      // Fail CLOSED: we could not count this request, so we cannot promise it is within the limit.
      req.log.error({ err, path: pathOf(req.url) }, "rate limit store error on a sensitive path")
      reply.header("retry-after", STORE_ERROR_RETRY_AFTER_SECONDS)
      throw AppError.rateLimited("Rate limiting is temporarily unavailable; please retry shortly.")
    }
    if (!result.isAllowed && result.isExceeded) {
      req.log.warn({ key: result.key, path: pathOf(req.url) }, "sensitive rate limit exceeded")
      applyRateLimitHeaders(reply, result)
      throw AppError.rateLimited()
    }
  }

  // Attach per route at registration time (the same mechanism the plugin uses). A route-level onRequest
  // handler runs after the instance-level auth hook, which is what makes the identity-aware key work.
  app.addHook("onRoute", (routeOptions) => {
    const hostCeiling = hostCeilingLimitOf(routeOptions.config, routeOptions.url)
    if (hostCeiling) {
      appendOnRequestHook(
        routeOptions,
        hostCeilingHook(app, `${String(routeOptions.method)}${routeOptions.url}`, hostCeiling),
      )
    }
    if (isSensitivePath(pathOf(routeOptions.url))) appendOnRequestHook(routeOptions, sensitiveHook)
  })
}

function appendOnRequestHook(
  routeOptions: { onRequest?: unknown },
  hook: onRequestAsyncHookHandler,
): void {
  const existing = routeOptions.onRequest
  if (Array.isArray(existing)) {
    existing.push(hook)
  } else if (typeof existing === "function") {
    routeOptions.onRequest = [existing, hook]
  } else {
    routeOptions.onRequest = [hook]
  }
}

function hostCeilingLimitOf(config: unknown, url: string): RouteRateLimitSpec | null {
  const limit = (config as {
    rateLimit?: Partial<RouteRateLimitSpec> & {
      keyGenerator?: unknown
      [ROUTE_RATE_LIMIT_POLICY]?: unknown
    }
  })?.rateLimit
  if (!limit || typeof limit !== "object") return null
  if (limit.keyGenerator === undefined) return null
  if (limit[ROUTE_RATE_LIMIT_POLICY] !== true || limit.keyGenerator !== identityRateLimitKey) {
    throw new Error(
      `the rate limit on ${url} sets its own keyGenerator; declare it with perIdentity() or perHost() from plugins/rate-limit.js so it cannot lose its per-host ceiling`,
    )
  }
  const { max, timeWindow, hostMax } = limit
  if (typeof max !== "number" || (typeof timeWindow !== "string" && typeof timeWindow !== "number")) {
    throw new Error(
      `the rate limit on ${url} replaces the per-host key, so it needs a literal max and timeWindow to derive its host ceiling`,
    )
  }
  return hostMax === undefined ? { max, timeWindow } : { max, timeWindow, hostMax }
}

function hostCeilingHook(
  app: FastifyInstance,
  routeId: string,
  limit: RouteRateLimitSpec,
): onRequestAsyncHookHandler {
  const checkHost = app.createRateLimit({
    max: limit.hostMax ?? limit.max * HOST_CEILING_MULTIPLIER,
    timeWindow: limit.timeWindow,
    keyGenerator: (req) => `host:${routeId}:ip:${normalizeIp(req.ip)}`,
    allowList: () => false,
    skipOnError: true,
  })
  return async (req, reply) => {
    const result = await checkHost(req)
    if (!result.isAllowed && result.isExceeded) {
      req.log.warn(
        { key: result.key, path: pathOf(req.url), route: routeId },
        "host ceiling rate limit exceeded",
      )
      reply.header("x-ratelimit-reset", result.ttlInSeconds)
      reply.header("retry-after", result.ttlInSeconds)
      throw AppError.rateLimited()
    }
  }
}
