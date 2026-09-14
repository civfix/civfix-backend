import type { PageViewSource } from "@civfix/shared"
import type { FastifyBaseLogger } from "fastify"
import type { CacheClient } from "../../auth/cache.js"
import type { MetricUpsert, MetricsRepository } from "./metrics-repository.drizzle.js"
import { eventDayKey } from "./event-day.js"

export { eventDayKey }

export const METRIC_PAGE_VIEWS = "page_views"
export const METRIC_SOURCE = "source"
export const METRIC_DONATION_CLICKS = "donation_clicks"

export const COUNTER_TTL_SEC = 4 * 24 * 60 * 60

const COUNTER_PREFIX = "evm:v1"

const BOT_UA_RE =
  /bot|crawler|spider|crawling|slurp|facebookexternalhit|embedly|quora link preview|whatsapp|telegram|discordbot|preview|monitor|curl|wget|python-requests|headless|lighthouse|pingdom|uptime/i

const SEARCH_HOSTS = ["google.", "bing.", "duckduckgo.", "yahoo.", "ecosia.", "brave.", "baidu."]
const SOCIAL_HOSTS = [
  "facebook.",
  "instagram.",
  "t.co",
  "twitter.",
  "x.com",
  "nextdoor.",
  "reddit.",
  "linkedin.",
  "tiktok.",
  "threads.",
  "bsky.",
  "mastodon.",
]
const APP_SOURCES = new Set(["app", "ios", "android", "mobile", "civfix-app"])
const SEARCH_SOURCES = new Set(["google", "bing", "duckduckgo", "search", "yahoo"])
const SOCIAL_SOURCES = new Set([
  "facebook",
  "instagram",
  "twitter",
  "x",
  "nextdoor",
  "reddit",
  "linkedin",
  "tiktok",
  "threads",
  "bluesky",
  "mastodon",
])

export function isBotUserAgent(userAgent: string | undefined): boolean {
  if (userAgent === undefined || userAgent.trim().length === 0) return true
  return BOT_UA_RE.test(userAgent)
}

export function classifyPageViewSource(input: {
  declared?: PageViewSource
  utmSource?: string
  referrer?: string
  selfHosts?: readonly string[]
}): PageViewSource {
  if (input.declared !== undefined) return input.declared
  const utm = input.utmSource?.trim().toLowerCase()
  if (utm !== undefined && utm.length > 0) {
    if (APP_SOURCES.has(utm)) return "app"
    if (SEARCH_SOURCES.has(utm)) return "search"
    if (SOCIAL_SOURCES.has(utm)) return "social"
    return "other"
  }
  const host = hostOf(input.referrer)
  if (host === null) return "direct"
  const selfHosts = input.selfHosts ?? []
  if (selfHosts.some((self) => host === self || host.endsWith(`.${self}`))) return "direct"
  if (SEARCH_HOSTS.some((prefix) => host.startsWith(prefix) || host.includes(`.${prefix}`))) {
    return "search"
  }
  if (SOCIAL_HOSTS.some((prefix) => host === prefix || host.startsWith(prefix) || host.includes(`.${prefix}`))) {
    return "social"
  }
  return "referral"
}

function hostOf(referrer: string | undefined): string | null {
  if (referrer === undefined || referrer.length === 0) return null
  try {
    return new URL(referrer).hostname.toLowerCase()
  } catch {
    return null
  }
}

export interface MetricsServiceDeps {
  repo: MetricsRepository
  cache: CacheClient
  selfHosts: readonly string[]
  lookbackDays: number
  logger?: Pick<FastifyBaseLogger, "info" | "warn" | "error">
  now?: () => Date
}

export interface PageViewInput {
  slug: string
  declaredSource?: PageViewSource
  utmSource?: string
  referrer?: string
  userAgent?: string
}

export interface MetricsService {
  recordPageView(input: PageViewInput): Promise<{ ok: true }>
  recordDonationClick(cleanupId: string): Promise<void>
  flushCounters(): Promise<{ flushed: number }>
  rollup(): Promise<{ events: number; rows: number }>
}

export function makeMetricsService(deps: MetricsServiceDeps): MetricsService {
  const now = deps.now ?? (() => new Date())

  function counterKey(cleanupId: string, day: string, metric: string, bucket: string): string {
    return `${COUNTER_PREFIX}:${cleanupId}:${day}:${metric}:${bucket}`
  }

  function dirtyKey(day: string): string {
    return `${COUNTER_PREFIX}:dirty:${day}`
  }

  async function bump(
    cleanupId: string,
    timezone: string | null,
    metric: string,
    bucket: string,
  ): Promise<void> {
    const day = eventDayKey(now(), timezone)
    const key = counterKey(cleanupId, day, metric, bucket)
    try {
      await deps.cache.incr(key, COUNTER_TTL_SEC)
      await deps.cache.sadd(dirtyKey(day), key)
      await deps.cache.expire(dirtyKey(day), COUNTER_TTL_SEC)
    } catch (err) {
      deps.logger?.warn(
        { err, metric },
        "event metrics: counter unavailable; view not counted (analytics degrade, the page does not)",
      )
    }
  }

  return {
    async recordPageView(input: PageViewInput) {
      if (isBotUserAgent(input.userAgent)) return { ok: true }
      const resolved = await deps.repo.resolveSlug(input.slug)
      if (resolved === null) return { ok: true }
      const source = classifyPageViewSource({
        ...(input.declaredSource !== undefined ? { declared: input.declaredSource } : {}),
        ...(input.utmSource !== undefined ? { utmSource: input.utmSource } : {}),
        ...(input.referrer !== undefined ? { referrer: input.referrer } : {}),
        selfHosts: deps.selfHosts,
      })
      await bump(resolved.cleanupId, resolved.timezone, METRIC_PAGE_VIEWS, "")
      await bump(resolved.cleanupId, resolved.timezone, METRIC_SOURCE, source)
      return { ok: true }
    },

    async recordDonationClick(cleanupId: string) {
      const timezone = await deps.repo.eventTimezone(cleanupId)
      await bump(cleanupId, timezone, METRIC_DONATION_CLICKS, "")
    },

    async flushCounters() {
      const days: string[] = []
      for (let i = 0; i <= deps.lookbackDays; i += 1) {
        days.push(new Date(now().getTime() - i * 86_400_000).toISOString().slice(0, 10))
      }
      const upserts: MetricUpsert[] = []
      for (const day of days) {
        let keys: string[]
        try {
          keys = await deps.cache.smembers(dirtyKey(day))
        } catch (err) {
          deps.logger?.warn({ err, day }, "event metrics: dirty-set read failed (skipping day)")
          continue
        }
        for (let i = 0; i < keys.length; i += 200) {
          const batch = keys.slice(i, i + 200)
          const values = await readMany(deps.cache, batch)
          batch.forEach((key, index) => {
            const parsed = parseCounterKey(key)
            const raw = values[index]
            if (parsed === null || raw === null || raw === undefined) return
            const value = Number(raw)
            if (!Number.isFinite(value) || value <= 0) return
            upserts.push({ ...parsed, value })
          })
        }
      }
      for (let i = 0; i < upserts.length; i += 500) {
        await deps.repo.upsertGreatest(upserts.slice(i, i + 500))
      }
      return { flushed: upserts.length }
    },

    async rollup() {
      const since = new Date(now().getTime() - deps.lookbackDays * 86_400_000)
      const cleanupIds = await deps.repo.listRollupEvents(since, 500)
      let rows = 0
      for (const cleanupId of cleanupIds) {
        const timezone = (await deps.repo.eventTimezone(cleanupId)) ?? "UTC"
        const computed = await deps.repo.recomputeFromSource(cleanupId, timezone, since)
        await deps.repo.upsertExact(computed)
        rows += computed.length
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      return { events: cleanupIds.length, rows }
    },
  }
}

async function readMany(cache: CacheClient, keys: readonly string[]): Promise<(string | null)[]> {
  if (cache.mget !== undefined) return cache.mget([...keys])
  return Promise.all(keys.map((key) => cache.get(key)))
}

export function parseCounterKey(
  key: string,
): { cleanupId: string; day: string; metric: string; bucket: string } | null {
  const parts = key.split(":")
  if (parts.length !== 6) return null
  const [prefix, version, cleanupId, day, metric, bucket] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ]
  if (`${prefix}:${version}` !== COUNTER_PREFIX) return null
  if (cleanupId.length === 0 || day.length !== 10 || metric.length === 0) return null
  return { cleanupId, day, metric, bucket }
}
