import type { PageViewSource } from "@civfix/shared"
import type { FastifyBaseLogger } from "fastify"
import type { CacheClient } from "../../auth/cache.js"
import type { MetricUpsert, MetricsRepository } from "./metrics-repository.drizzle.js"
import { eventDayKey } from "./event-day.js"
import { DEFAULT_EVENT_TIME_ZONE } from "./event-fields.js"
import {
  METRIC_DONATION_CLICKS,
  METRIC_PAGE_VIEWS,
  METRIC_SOURCE,
  NO_BUCKET,
} from "./event-metric-names.js"
import { isoDayOf } from "./host-analytics-shaping.js"
import { MS_PER_DAY } from "../../lib/time.js"

export { eventDayKey }

const COUNTER_TTL_SEC = 4 * 24 * 60 * 60

const ROLLUP_PAGE_SIZE = 500

const FLUSH_READ_BATCH = 200

const FLUSH_UPSERT_BATCH = 500

// One day ahead: a bump keys its dirty set by the event-local day, which east of UTC is already
// tomorrow.
const FLUSH_LEAD_DAYS = 1

const COUNTER_PREFIX = "evm:v1"

const COUNTER_KEY_PARTS = 6

const DAY_KEY_LENGTH = 10

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
  if (
    SOCIAL_HOSTS.some(
      (prefix) => host === prefix || host.startsWith(prefix) || host.includes(`.${prefix}`),
    )
  ) {
    return "social"
  }
  return "referral"
}

function hostOf(referrer: string | undefined): string | null {
  if (referrer === undefined || referrer.length === 0) return null
  try {
    return new URL(referrer).hostname.toLowerCase()
  } catch {
    // An unparseable Referer is client-controlled noise; it is counted as a direct visit.
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

  function flushDays(): string[] {
    const days: string[] = []
    for (let i = -FLUSH_LEAD_DAYS; i <= deps.lookbackDays; i += 1) {
      days.push(isoDayOf(new Date(now().getTime() - i * MS_PER_DAY)))
    }
    return days
  }

  async function bump(
    cleanupId: string,
    timezone: string | null,
    metric: string,
    bucket: string,
  ): Promise<void> {
    const day = eventDayKey(now(), timezone ?? DEFAULT_EVENT_TIME_ZONE)
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
      await bump(resolved.cleanupId, resolved.timezone, METRIC_PAGE_VIEWS, NO_BUCKET)
      await bump(resolved.cleanupId, resolved.timezone, METRIC_SOURCE, source)
      return { ok: true }
    },

    async recordDonationClick(cleanupId: string) {
      const timezone = await deps.repo.eventTimezone(cleanupId)
      await bump(cleanupId, timezone, METRIC_DONATION_CLICKS, NO_BUCKET)
    },

    async flushCounters() {
      const upserts: MetricUpsert[] = []
      for (const day of flushDays()) {
        let keys: string[]
        try {
          keys = await deps.cache.smembers(dirtyKey(day))
        } catch (err) {
          deps.logger?.warn({ err, day }, "event metrics: dirty-set read failed (skipping day)")
          continue
        }
        await collectCounters(deps.cache, keys, upserts)
      }
      for (let i = 0; i < upserts.length; i += FLUSH_UPSERT_BATCH) {
        await deps.repo.upsertGreatest(upserts.slice(i, i + FLUSH_UPSERT_BATCH))
      }
      return { flushed: upserts.length }
    },

    async rollup() {
      const since = new Date(now().getTime() - deps.lookbackDays * MS_PER_DAY)
      let after: string | null = null
      let events = 0
      let rows = 0
      for (;;) {
        const cleanupIds = await deps.repo.listRollupEvents(since, after, ROLLUP_PAGE_SIZE)
        for (const cleanupId of cleanupIds) {
          const timezone = (await deps.repo.eventTimezone(cleanupId)) ?? DEFAULT_EVENT_TIME_ZONE
          const computed = await deps.repo.recomputeFromSource(cleanupId, timezone, since)
          await deps.repo.upsertExact(computed)
          rows += computed.length
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        events += cleanupIds.length
        const last = cleanupIds.at(-1)
        if (cleanupIds.length < ROLLUP_PAGE_SIZE || last === undefined) break
        after = last
      }
      return { events, rows }
    },
  }
}

async function readMany(cache: CacheClient, keys: readonly string[]): Promise<(string | null)[]> {
  if (cache.mget !== undefined) return cache.mget([...keys])
  return Promise.all(keys.map((key) => cache.get(key)))
}

async function collectCounters(
  cache: CacheClient,
  keys: readonly string[],
  upserts: MetricUpsert[],
): Promise<void> {
  for (let i = 0; i < keys.length; i += FLUSH_READ_BATCH) {
    const batch = keys.slice(i, i + FLUSH_READ_BATCH)
    const values = await readMany(cache, batch)
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

export function parseCounterKey(
  key: string,
): { cleanupId: string; day: string; metric: string; bucket: string } | null {
  const parts = key.split(":")
  if (parts.length !== COUNTER_KEY_PARTS) return null
  const [prefix, version, cleanupId, day, metric, bucket] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ]
  if (`${prefix}:${version}` !== COUNTER_PREFIX) return null
  if (cleanupId.length === 0 || day.length !== DAY_KEY_LENGTH || metric.length === 0) return null
  return { cleanupId, day, metric, bucket }
}
