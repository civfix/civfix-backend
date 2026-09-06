
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

const RATE_LIMIT_ALLOWLIST = new Set(["/healthz"])

export const SENSITIVE_RATE_LIMIT_PREFIXES: readonly string[] = [
  "/v1/auth",
  "/auth",
  "/v1/admin/auth",
  "/v1/ws-ticket",
  "/v1/anon",
  "/v1/media",
  "/v1/claim",
  "/v1/me/data-export",
  "/v1/me/volunteer-hours/certificates",
  "/v1/donations",
  "/forms",
]

export const SENSITIVE_WRITE_EXACT_PATHS: readonly string[] = ["/v1/reports"]
export const SENSITIVE_WRITE_PREFIXES: readonly string[] = ["/v1/admin"]

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

function methodIsMutating(method: string | readonly string[] | undefined): boolean {
  if (method === undefined) return false
  const methods = Array.isArray(method) ? method : [method as string]
  return methods.some((m) => MUTATING_METHODS.has(m.toUpperCase()))
}

export function isWriteSensitivePath(path: string): boolean {
  if (SENSITIVE_WRITE_EXACT_PATHS.includes(path)) return true
  return SENSITIVE_WRITE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))
}

const SENSITIVE_MAX = 60
const SENSITIVE_WINDOW = "1 minute"

export interface RateLimitOptions {
  max?: number
  timeWindow?: string | number
  redis?: RedisClient
  sensitiveMax?: number
}

function pathOf(url: string | undefined): string {
  return (url ?? "").split("?")[0] ?? ""
}

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_RATE_LIMIT_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))
}

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
    skipOnError: true,
    onExceeded: (req, key) => {
      req.log.debug({ key, path: pathOf(req.url) }, "rate limit exceeded")
    },
    ...(opts.redis ? { redis: opts.redis } : {}),
  })

  const checkSensitive = app.createRateLimit({
    max: opts.sensitiveMax ?? SENSITIVE_MAX,
    timeWindow: SENSITIVE_WINDOW,
    keyGenerator: sensitiveRateLimitKey,
    allowList: () => false,
    skipOnError: false,
  })

  const sensitiveHook: onRequestAsyncHookHandler = async (req, reply) => {
    let result: Awaited<ReturnType<typeof checkSensitive>>
    try {
      result = await checkSensitive(req)
    } catch (err) {
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

  app.addHook("onRoute", (routeOptions) => {
    const hostCeiling = hostCeilingLimitOf(routeOptions.config, routeOptions.url)
    if (hostCeiling) {
      appendOnRequestHook(
        routeOptions,
        hostCeilingHook(app, `${String(routeOptions.method)}${routeOptions.url}`, hostCeiling),
      )
    }
    const routePath = pathOf(routeOptions.url)
    if (
      isSensitivePath(routePath) ||
      (methodIsMutating(routeOptions.method) && isWriteSensitivePath(routePath))
    ) {
      appendOnRequestHook(routeOptions, sensitiveHook)
    }
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
