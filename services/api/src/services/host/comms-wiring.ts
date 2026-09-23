import { AppError } from "@civfix/shared"
import type { FastifyBaseLogger } from "fastify"
import type { Container } from "../../di.js"
import type { Queryable } from "../../db/client.js"
import { domainOf } from "../../adapters/mail-text.js"
import { apiBaseUrlOf, webBaseUrlOf } from "../../lib/base-url.js"
import { writeAudit, type WriteAuditInput } from "../admin/audit.js"
import { makeRouteNotificationService } from "../route-notifier.js"
import { makeDrizzleAnalyticsRepository } from "./analytics-repository.drizzle.js"
import { makeAnalyticsService, type AnalyticsService } from "./analytics-service.js"
import { makeDrizzleEventAnalyticsRepository } from "./event-analytics-repository.drizzle.js"
import { makeEventAnalyticsService, type EventAnalyticsService } from "./event-analytics-service.js"
import { makeDrizzleAnnouncementIdentityRepository } from "./announcement-repository.drizzle.js"
import { makeAnnouncementService, type AnnouncementService } from "./announcement-service.js"
import { MEDIA_GET_URL_TTL_SEC } from "../media-intake-service.js"
import { makeInsightsService, type InsightsService } from "./insights-service.js"
import { makeDrizzleHostRegistrationRepository } from "./registration-repository.drizzle.js"
import { makeHostAnalyticsCache } from "./host-analytics-cache.js"
import { makeDrizzleBroadcastRepository } from "./broadcast-repository.drizzle.js"
import type { BroadcastRepository } from "./broadcast-repository.js"
import {
  makeBroadcastService,
  type BroadcastConfig,
  type BroadcastService,
} from "./broadcast-service.js"
import { makeBroadcastPipeline, type BroadcastPipeline } from "./broadcast-pipeline.js"
import { makeBroadcastLanes, type BroadcastLanes } from "./broadcast-lanes.js"
import { BROADCAST_CHUNK_JOB, BROADCAST_PLAN_JOB } from "./broadcast-queues.js"
import {
  makeDrizzleMetricsRepository,
  type MetricsRepository,
} from "./metrics-repository.drizzle.js"
import { makeMetricsService, type MetricsService } from "./metrics-service.js"
import { makeDrizzleHostExportRepository } from "./export-repository.drizzle.js"
import {
  DEFAULT_EXPORT_MAX_BYTES,
  makeHostExportService,
  type HostExportService,
} from "./export-service.js"
import { registerEventExportBuilders } from "./host-export-builders.js"
import { requireCapability } from "./authz.js"

export type CommsLogger = Pick<FastifyBaseLogger, "info" | "warn" | "error">

export interface CommsRuntime {
  repo: BroadcastRepository
  metricsRepo: MetricsRepository
  broadcasts: BroadcastService
  announcements: AnnouncementService
  pipeline: BroadcastPipeline
  lanes: BroadcastLanes
  metrics: MetricsService
  analytics: AnalyticsService
  eventAnalytics: EventAnalyticsService
  insights: InsightsService
  exports: HostExportService
}

export { apiBaseUrlOf, webBaseUrlOf } from "../../lib/base-url.js"

/**
 * The effect this row records has already happened (a send, an export enqueue), so a failed audit
 * write must not turn it into an error the caller would retry. It is logged instead of dropped so the
 * gap in the trail is visible.
 */
export async function auditBestEffort(
  sql: Queryable,
  entry: WriteAuditInput,
  logger: Pick<CommsLogger, "warn"> | undefined,
): Promise<void> {
  try {
    await writeAudit(sql, entry)
  } catch (err) {
    logger?.warn(
      { err, action: entry.action, target: entry.target ?? null },
      "audit write failed (suppressed)",
    )
  }
}

function selfHostsOf(webOrigins: readonly string[]): string[] {
  const hosts: string[] = []
  for (const origin of webOrigins) {
    try {
      hosts.push(new URL(origin).hostname.toLowerCase())
    } catch {
      // A malformed origin cannot match any referrer, so skipping it only drops a no-op entry.
      continue
    }
  }
  return hosts
}

export function broadcastConfigOf(container: Container): BroadcastConfig {
  const env = container.env
  return {
    killSwitch: env.HOST_MESSAGING_KILL_SWITCH,
    perEventPerDay: env.HOST_BROADCAST_PER_EVENT_PER_DAY,
    recipientsPerDay: env.HOST_BROADCAST_RECIPIENTS_PER_DAY,
    cooldownSec: env.HOST_BROADCAST_COOLDOWN_SEC,
    minAccountAgeHours: env.HOST_BROADCAST_MIN_ACCOUNT_AGE_HOURS,
    maxRecipients: env.BROADCAST_MAX_RECIPIENTS,
    chunkSize: env.BROADCAST_CHUNK_SIZE,
    emailConcurrency: env.BROADCAST_EMAIL_CONCURRENCY,
    emailRatePerSec: env.BROADCAST_EMAIL_RATE_PER_SEC,
    linkAllowedHosts: env.BROADCAST_LINK_ALLOWED_HOSTS,
    mailFromEvents: env.MAIL_FROM_EVENTS,
    unsubscribeSigningKey: env.UNSUBSCRIBE_SIGNING_KEY,
    webBaseUrl: webBaseUrlOf(env),
    apiBaseUrl: apiBaseUrlOf(env),
    eventUpdatePerEventPerHour: env.HOST_EVENT_UPDATE_PER_EVENT_PER_HOUR,
  }
}

let buildersRegistered = false

export function makeCommsRuntime(container: Container, logger?: CommsLogger): CommsRuntime {
  const env = container.env
  const sql = container.getDb().sql
  const config = broadcastConfigOf(container)

  if (!buildersRegistered) {
    registerEventExportBuilders(() => container.getDb().sql)
    buildersRegistered = true
  }

  const repo = makeDrizzleBroadcastRepository(sql)
  const metricsRepo = makeDrizzleMetricsRepository(sql)

  const broadcasts = makeBroadcastService({
    repo,
    counters: container.getCounterStore(),
    config,
    mailer: container.mailer,
    enqueuePlan: async (broadcastId) => {
      await container.jobs.enqueue(
        BROADCAST_PLAN_JOB,
        { broadcastId },
        { singletonKey: `plan:${broadcastId}`, retryLimit: 3 },
      )
    },
    ...(logger !== undefined ? { logger } : {}),
  })

  const announcements = makeAnnouncementService({
    repo,
    identities: makeDrizzleAnnouncementIdentityRepository(sql, (key) =>
      container.storage.presignGet(key, MEDIA_GET_URL_TTL_SEC),
    ),
    broadcasts,
    config,
    ...(logger !== undefined ? { logger } : {}),
  })

  const pipeline = makeBroadcastPipeline({
    repo,
    service: broadcasts,
    notifications: makeRouteNotificationService(container, logger as FastifyBaseLogger | undefined),
    mailer: container.mailer,
    cache: container.getCache(),
    config,
    mailDomain: domainOf(config.mailFromEvents),
    enqueueChunk: async (broadcastId, chunkNo, opts) => {
      await container.jobs.enqueue(
        BROADCAST_CHUNK_JOB,
        { broadcastId, chunkNo, authRetry: opts?.authRetry ?? 0 },
        {
          singletonKey: `chunk:${broadcastId}:${chunkNo}`,
          retryLimit: 3,
          ...(opts?.startAfterSec !== undefined ? { startAfter: opts.startAfterSec } : {}),
        },
      )
    },
    audit: (action, actorId, target, meta) =>
      auditBestEffort(sql, { action, actorId, target, meta }, logger),
    ...(logger !== undefined ? { logger } : {}),
  })

  const lanes = makeBroadcastLanes({
    repo,
    counters: container.getCounterStore(),
    perEventPerHour: config.eventUpdatePerEventPerHour,
    enqueuePlan: async (broadcastId) => {
      await container.jobs.enqueue(
        BROADCAST_PLAN_JOB,
        { broadcastId },
        { singletonKey: `plan:${broadcastId}`, retryLimit: 3 },
      )
    },
    ...(logger !== undefined ? { logger } : {}),
  })

  const metrics = makeMetricsService({
    repo: metricsRepo,
    cache: container.getCache(),
    selfHosts: selfHostsOf(container.env.WEB_ORIGINS),
    lookbackDays: env.METRICS_ROLLUP_LOOKBACK_DAYS,
    ...(logger !== undefined ? { logger } : {}),
  })

  const analyticsRepo = makeDrizzleAnalyticsRepository(sql)
  const analyticsCache = makeHostAnalyticsCache({
    cache: container.getCache(),
    ttlSeconds: env.HOST_ANALYTICS_CACHE_TTL_SEC,
    ...(logger !== undefined ? { logger } : {}),
  })

  const analytics = makeAnalyticsService({
    analytics: analyticsRepo,
    metrics: metricsRepo,
    cache: analyticsCache,
  })

  const eventAnalytics = makeEventAnalyticsService({
    analytics: analyticsRepo,
    events: makeDrizzleEventAnalyticsRepository(sql),
    metrics: metricsRepo,
    cache: analyticsCache,
  })

  const insights = makeInsightsService({
    analytics: analyticsRepo,
    registrations: makeDrizzleHostRegistrationRepository(sql),
    cache: analyticsCache,
  })

  const exports = makeHostExportService({
    repo: makeDrizzleHostExportRepository(sql),
    storage: container.storage,
    config: {
      maxRows: env.HOST_EXPORT_MAX_ROWS,
      maxBytes: DEFAULT_EXPORT_MAX_BYTES,
      ttlHours: env.HOST_EXPORT_TTL_HOURS,
    },
    authorize: async (record) => {
      if (record.cleanupId === null) throw AppError.notFound("Export not found")
      await requireCapability(sql, record.cleanupId, record.requestedBy, "export")
    },
    ...(logger !== undefined ? { logger } : {}),
  })

  return {
    repo,
    metricsRepo,
    broadcasts,
    announcements,
    pipeline,
    lanes,
    metrics,
    analytics,
    eventAnalytics,
    insights,
    exports,
  }
}
