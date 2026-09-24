import type { FastifyBaseLogger } from "fastify"
import type { CacheClient } from "../../auth/cache.js"

const HOST_ANALYTICS_CACHE_PREFIX = "hostan:v1"

const INSIGHTS_GENERATION_TTL_SEC = 86_400

const INSIGHTS_GENERATION_ZERO = "0"

export interface HostAnalyticsCacheDeps {
  cache: CacheClient
  ttlSeconds: number
  logger?: Pick<FastifyBaseLogger, "warn">
}

export interface InsightsGenerationDeps {
  cache: Pick<CacheClient, "get" | "incr">
  logger?: { warn(obj: unknown, msg?: string): void }
}

export interface InsightsGeneration {
  generationOf(cleanupId: string): Promise<string>
  bumpInsightsGeneration(cleanupId: string): Promise<void>
}

export type InsightsInvalidator = Pick<InsightsGeneration, "bumpInsightsGeneration">

export const NOOP_INSIGHTS_INVALIDATOR: InsightsInvalidator = {
  bumpInsightsGeneration(): Promise<void> {
    return Promise.resolve()
  },
}

export function hostAnalyticsCacheKey(args: {
  endpoint: string
  scope: string
  range: string
  viewerScope: string
  generation?: string
}): string {
  const key = `${HOST_ANALYTICS_CACHE_PREFIX}:${args.endpoint}:${args.scope}:${args.range}:${args.viewerScope}`
  return args.generation === undefined ? key : `${key}:g${args.generation}`
}

// Comparison and returning-attendee figures come from the viewer's own hosted events, so the user id
// is part of the key.
export function perViewerScope(viewer: { viewerScope: string; userId: string }): string {
  return `${viewer.viewerScope}:${viewer.userId}`
}

export function insightsGenerationKey(cleanupId: string): string {
  return `${HOST_ANALYTICS_CACHE_PREFIX}:insights:gen:${cleanupId}`
}

export function makeInsightsGeneration(deps: InsightsGenerationDeps): InsightsGeneration {
  return {
    async generationOf(cleanupId: string): Promise<string> {
      try {
        return (await deps.cache.get(insightsGenerationKey(cleanupId))) ?? INSIGHTS_GENERATION_ZERO
      } catch (err) {
        deps.logger?.warn({ err, cleanupId }, "insights generation read failed (treated as zero)")
        return INSIGHTS_GENERATION_ZERO
      }
    },

    async bumpInsightsGeneration(cleanupId: string): Promise<void> {
      try {
        await deps.cache.incr(insightsGenerationKey(cleanupId), INSIGHTS_GENERATION_TTL_SEC)
      } catch (err) {
        deps.logger?.warn({ err, cleanupId }, "insights generation bump failed (ignored)")
      }
    },
  }
}

export function makeHostAnalyticsCache(deps: HostAnalyticsCacheDeps) {
  const generation = makeInsightsGeneration({
    cache: deps.cache,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  })
  return {
    ...generation,

    async getOrSet<T>(key: string, compute: () => Promise<T>, ttlSeconds?: number): Promise<T> {
      try {
        const hit = await deps.cache.get(key)
        if (hit !== null) return JSON.parse(hit) as T
      } catch (err) {
        deps.logger?.warn({ err, key }, "host analytics cache read failed (computing live)")
      }
      const value = await compute()
      try {
        await deps.cache.set(key, JSON.stringify(value), ttlSeconds ?? deps.ttlSeconds)
      } catch (err) {
        deps.logger?.warn({ err, key }, "host analytics cache write failed (ignored)")
      }
      return value
    },
  }
}

export type HostAnalyticsCache = ReturnType<typeof makeHostAnalyticsCache>
