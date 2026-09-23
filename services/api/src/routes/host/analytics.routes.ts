import {
  AppError,
  EventAnalyticsRequestSchema,
  GetEventAnalyticsRequestSchema,
  GetEventInsightsRequestSchema,
  HostAnalyticsSummaryRequestSchema,
  HostedEventsAnalyticsRequestSchema,
  type AnalyticsRange,
  type PortfolioAnalyticsRange,
} from "@civfix/shared"
import { can, type HostStanding } from "@civfix/shared/host"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { ZodType } from "zod"
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
import type { EventAnalyticsService } from "../../services/host/event-analytics-service.js"
import type { InsightsService } from "../../services/host/insights-service.js"

export const ANALYTICS_RATE_LIMIT = perIdentity({ max: 60, timeWindow: "1 minute" })

const DEFAULT_EVENT_RANGE: AnalyticsRange = "30d"
const DEFAULT_PORTFOLIO_RANGE: PortfolioAnalyticsRange = "90d"
const DEFAULT_EVENT_ANALYTICS_SCOPE = "full"
const SELF_VIEWER_SCOPE = "self"
const NO_ROLE = "none"

export interface HostAnalyticsOverrides {
  analytics: AnalyticsService
  eventAnalytics: EventAnalyticsService
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

function viewerScopeOf(standing: HostStanding): string {
  return `${standing.eventRole ?? NO_ROLE}:${standing.orgRole ?? NO_ROLE}`
}

export async function registerHostAnalyticsRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  let cached: CommsRuntime | undefined

  function services(): HostAnalyticsOverrides {
    return app.hostAnalyticsOverrides ?? (cached ??= makeCommsRuntime(container, app.log))
  }

  const analytics = (): AnalyticsService => services().analytics
  const eventAnalytics = (): EventAnalyticsService => services().eventAnalytics
  const insights = (): InsightsService => services().insights

  async function authorizeEventView<T extends { id: string }>(
    request: FastifyRequest,
    schema: ZodType<T>,
    input: unknown,
  ) {
    const userId = requireAuth(request)
    const query = parse(schema, input)
    const resolution = await requireCapability(
      container.getDb().sql,
      query.id,
      userId,
      "view_analytics",
    )
    return { userId, query, resolution, viewerScope: viewerScopeOf(resolution.standing) }
  }

  async function eventScope(
    request: FastifyRequest,
  ): Promise<{ cleanupId: string; range: AnalyticsRange; viewerScope: string }> {
    const { query, viewerScope } = await authorizeEventView(
      request,
      EventAnalyticsRequestSchema,
      mergeQuery(request),
    )
    return { cleanupId: query.id, range: query.range ?? DEFAULT_EVENT_RANGE, viewerScope }
  }

  async function portfolioViewerScope(userId: string, orgId: string | undefined): Promise<string> {
    if (orgId === undefined) return SELF_VIEWER_SCOPE
    const standing = await requireOrgCapability(
      container.getDb().sql,
      orgId,
      userId,
      "view_analytics",
    )
    return `org:${standing.orgRole ?? NO_ROLE}`
  }

  route(
    app,
    "getEventAnalytics",
    { config: { rateLimit: ANALYTICS_RATE_LIMIT } },
    async (request, reply) => {
      const { userId, query, resolution, viewerScope } = await authorizeEventView(
        request,
        GetEventAnalyticsRequestSchema,
        mergeQuery(request),
      )
      reply.status(200).send(
        await eventAnalytics().analytics(query.id, query.scope ?? DEFAULT_EVENT_ANALYTICS_SCOPE, {
          userId,
          organizationId: resolution.organizationId,
          viewerScope,
        }),
      )
    },
  )

  route(
    app,
    "eventAnalyticsOverview",
    { config: { rateLimit: ANALYTICS_RATE_LIMIT } },
    async (request, reply) => {
      const scope = await eventScope(request)
      reply
        .status(200)
        .send(await analytics().overview(scope.cleanupId, scope.range, scope.viewerScope))
    },
  )

  route(
    app,
    "eventAnalyticsRegistrations",
    { config: { rateLimit: ANALYTICS_RATE_LIMIT } },
    async (request, reply) => {
      const scope = await eventScope(request)
      reply
        .status(200)
        .send(await analytics().registrations(scope.cleanupId, scope.range, scope.viewerScope))
    },
  )

  route(
    app,
    "eventAnalyticsCheckins",
    { config: { rateLimit: ANALYTICS_RATE_LIMIT } },
    async (request, reply) => {
      const scope = await eventScope(request)
      reply
        .status(200)
        .send(await analytics().checkins(scope.cleanupId, scope.range, scope.viewerScope))
    },
  )

  route(
    app,
    "eventAnalyticsBroadcasts",
    { config: { rateLimit: ANALYTICS_RATE_LIMIT } },
    async (request, reply) => {
      const scope = await eventScope(request)
      reply
        .status(200)
        .send(await analytics().broadcasts(scope.cleanupId, scope.range, scope.viewerScope))
    },
  )

  route(
    app,
    "eventAnalyticsSources",
    { config: { rateLimit: ANALYTICS_RATE_LIMIT } },
    async (request, reply) => {
      const scope = await eventScope(request)
      reply
        .status(200)
        .send(await analytics().sources(scope.cleanupId, scope.range, scope.viewerScope))
    },
  )

  route(
    app,
    "getEventInsights",
    { config: { rateLimit: ANALYTICS_RATE_LIMIT } },
    async (request, reply) => {
      const { userId, query, resolution, viewerScope } = await authorizeEventView(
        request,
        GetEventInsightsRequestSchema,
        request.params,
      )
      if (!can(resolution.standing, "view_roster")) {
        throw AppError.forbidden(hostForbiddenCopy("view_roster"))
      }
      reply.status(200).send(await insights().insights(query.id, { userId, viewerScope }))
    },
  )

  route(
    app,
    "hostedEventsAnalytics",
    { config: { rateLimit: ANALYTICS_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const query = parse(HostedEventsAnalyticsRequestSchema, request.query)
      const viewerScope = await portfolioViewerScope(userId, query.orgId)
      const range: PortfolioAnalyticsRange = query.range ?? DEFAULT_PORTFOLIO_RANGE
      reply
        .status(200)
        .send(await analytics().portfolio(userId, query.orgId ?? null, range, viewerScope))
    },
  )

  route(
    app,
    "hostedEventsAnalyticsSummary",
    { config: { rateLimit: ANALYTICS_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const query = parse(HostAnalyticsSummaryRequestSchema, request.query)
      const viewerScope = await portfolioViewerScope(userId, query.orgId)
      const range: AnalyticsRange = query.range ?? DEFAULT_EVENT_RANGE
      reply
        .status(200)
        .send(await analytics().summary(userId, query.orgId ?? null, range, viewerScope))
    },
  )
}
