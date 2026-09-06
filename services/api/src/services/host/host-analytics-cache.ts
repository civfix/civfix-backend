import type { FastifyBaseLogger } from "fastify"
import type { CacheClient } from "../../auth/cache.js"

export const HOST_ANALYTICS_CACHE_PREFIX = "hostan:v1"

export interface HostAnalyticsCacheDeps {
  cache: CacheClient
  ttlSeconds: number
  logger?: Pick<FastifyBaseLogger, "warn">
}

export function hostAnalyticsCacheKey(args: {
  endpoint: string
  scope: string
  range: string
  viewerScope: string
}): string {
  return `${HOST_ANALYTICS_CACHE_PREFIX}:${args.endpoint}:${args.scope}:${args.range}:${args.viewerScope}`
}

export function makeHostAnalyticsCache(deps: HostAnalyticsCacheDeps) {
  return {
    async getOrSet<T>(key: string, compute: () => Promise<T>): Promise<T> {
      try {
        const hit = await deps.cache.get(key)
        if (hit !== null) return JSON.parse(hit) as T
      } catch (err) {
        deps.logger?.warn({ err, key }, "host analytics cache read failed (computing live)")
      }
      const value = await compute()
      try {
        await deps.cache.set(key, JSON.stringify(value), deps.ttlSeconds)
      } catch (err) {
        deps.logger?.warn({ err, key }, "host analytics cache write failed (ignored)")
      }
      return value
    },
  }
}

export type HostAnalyticsCache = ReturnType<typeof makeHostAnalyticsCache>
