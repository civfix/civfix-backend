import {
  AppError,
  EventAnalyticsRequestSchema,
  GetEventInsightsRequestSchema,
  HostedEventsAnalyticsRequestSchema,
  type AnalyticsRange,
  type PortfolioAnalyticsRange,
} from "@civfix/shared"
import { can } from "@civfix/shared/host"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../../di.js"
import { requireAuth } from "../../auth/context.js"
import { perIdentity } from "../../plugins/rate-limit.js"
import { route } from "../../versioning/route.js"
import { parse } from "../_validate.js"
import {
  hostForbiddenCopy,
  requireCapability,
  requireOrgCapability,
} from "../../services/host/authz.js"
import { makeCommsRuntime } from "../../services/host/comms-wiring.js"
import type { CommsRuntime } from "../../services/host/comms-wiring.js"
import type { AnalyticsService } from "../../services/host/analytics-service.js"
import type { InsightsService } from "../../services/host/insights-service.js"

export const ANALYTICS_RATE_LIMIT = perIdentity({ max: 60, timeWindow: "1 minute" })

export interface HostAnalyticsOverrides {
  analytics: AnalyticsService
  insights: InsightsService
}

declare module "fastify" {
  interface FastifyInstance {
    hostAnalyticsOverrides?: HostAnalyticsOverrides
  }
}

function mergeQuery(request: FastifyRequest): Record<string, unknown> {
  const params = (request.params ?? {}) as Record<string, unknown>
  const query = (request.query ?? {}) as Record<string, unknown>
  return { ...query, ...params }
}

export async function registerHostAnalyticsRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  let cached: CommsRuntime | undefined

  function analytics(): AnalyticsService {
    const override = app.hostAnalyticsOverrides
    if (override) return override.analytics
    return (cached ??= makeCommsRuntime(container, app.log)).analytics
  }

  function insights(): InsightsService {
    const override = app.hostAnalyticsOverrides
    if (override) return override.insights
    return (cached ??= makeCommsRuntime(container, app.log)).insights
  }

  async function eventScope(
    request: FastifyRequest,
  ): Promise<{ cleanupId: string; range: AnalyticsRange; viewerScope: string }> {
    const userId = requireAuth(request)
    const query = parse(EventAnalyticsRequestSchema, mergeQuery(request))
    const resolution = await requireCapability(
      container.getDb().sql,
      query.id,
      userId,
      "view_analytics",
    )
    const viewerScope = `${resolution.standing.eventRole ?? "none"}:${resolution.standing.orgRole ?? "none"}`
    return { cleanupId: query.id, range: query.range ?? "30d", viewerScope }
  }

  route(app, "eventAnalyticsOverview", { config: { rateLimit: ANALYTICS_RATE_LIMIT } }, async (request, reply) => {
    const scope = await eventScope(request)
    reply.status(200).send(await analytics().overview(scope.cleanupId, scope.range, scope.viewerScope))
  })

  route(app, "eventAnalyticsRegistrations", { config: { rateLimit: ANALYTICS_RATE_LIMIT } }, async (request, reply) => {
    const scope = await eventScope(request)
    reply
      .status(200)
      .send(await analytics().registrations(scope.cleanupId, scope.range, scope.viewerScope))
  })

  route(app, "eventAnalyticsCheckins", { config: { rateLimit: ANALYTICS_RATE_LIMIT } }, async (request, reply) => {
    const scope = await eventScope(request)
    reply.status(200).send(await analytics().checkins(scope.cleanupId, scope.range, scope.viewerScope))
  })

  route(app, "eventAnalyticsBroadcasts", { config: { rateLimit: ANALYTICS_RATE_LIMIT } }, async (request, reply) => {
    const scope = await eventScope(request)
    reply.status(200).send(await analytics().broadcasts(scope.cleanupId, scope.range, scope.viewerScope))
  })

  route(app, "eventAnalyticsSources", { config: { rateLimit: ANALYTICS_RATE_LIMIT } }, async (request, reply) => {
    const scope = await eventScope(request)
    reply.status(200).send(await analytics().sources(scope.cleanupId, scope.range, scope.viewerScope))
  })

  route(app, "getEventInsights", { config: { rateLimit: ANALYTICS_RATE_LIMIT } }, async (request, reply) => {
    const userId = requireAuth(request)
    const params = parse(GetEventInsightsRequestSchema, request.params)
    const resolution = await requireCapability(
      container.getDb().sql,
      params.id,
      userId,
      "view_analytics",
    )
    if (!can(resolution.standing, "view_roster")) {
      throw AppError.forbidden(hostForbiddenCopy("view_roster"))
    }
    const viewerScope = `${resolution.standing.eventRole ?? "none"}:${resolution.standing.orgRole ?? "none"}`
    reply.status(200).send(
      await insights().insights(params.id, {
        userId,
        canViewDonations: can(resolution.standing, "view_donations"),
        viewerScope,
      }),
    )
  })

  route(app, "hostedEventsAnalytics", { config: { rateLimit: ANALYTICS_RATE_LIMIT } }, async (request, reply) => {
    const userId = requireAuth(request)
    const query = parse(HostedEventsAnalyticsRequestSchema, request.query)
    let viewerScope = "self"
    if (query.orgId !== undefined) {
      const standing = await requireOrgCapability(
        container.getDb().sql,
        query.orgId,
        userId,
        "view_analytics",
      )
      viewerScope = `org:${standing.orgRole ?? "none"}`
    }
    const range: PortfolioAnalyticsRange = query.range ?? "90d"
    reply
      .status(200)
      .send(await analytics().portfolio(userId, query.orgId ?? null, range, viewerScope))
  })
}
