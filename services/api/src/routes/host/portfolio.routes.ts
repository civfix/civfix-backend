import { ListMyHostedEventsRequestSchema, type ListMyHostedEventsResponse } from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireAuth } from "../../auth/context.js"
import { parse } from "../_validate.js"
import { perIdentity } from "../../plugins/rate-limit.js"
import { route } from "../../versioning/route.js"
import { makeEventMediaPresigner } from "../../services/host/event-media.js"
import {
  hostedRegistrationTotals,
  makeDrizzleHostPortfolioRepository,
} from "../../services/host/host-portfolio-repository.drizzle.js"
import {
  HOSTED_EVENTS_DEFAULT_LIMIT,
  makeHostPortfolioService,
  type HostPortfolioService,
  type HostPortfolioServiceDeps,
} from "../../services/host/host-portfolio-service.js"
import { hostedEventCounts } from "../../services/host/portfolio-counts.js"

const ONE_MINUTE = "1 minute"

export interface HostPortfolioOverrides {
  repo: HostPortfolioServiceDeps["repo"]
  counts?: HostPortfolioServiceDeps["counts"]
  totals?: HostPortfolioServiceDeps["totals"]
  presignEventMedia?: HostPortfolioServiceDeps["presignEventMedia"]
  now?: HostPortfolioServiceDeps["now"]
}

declare module "fastify" {
  interface FastifyInstance {
    hostPortfolioOverrides?: HostPortfolioOverrides
  }
}

const HostedEventsQuerySchema = z
  .object({
    when: z.string().optional(),
    orgId: z.string().optional(),
    cursor: z.string().optional(),
    limit: z.string().optional(),
  })
  .strict()

export const HOSTED_EVENTS_RATE_LIMIT = perIdentity({ max: 60, timeWindow: ONE_MINUTE })

export async function registerHostPortfolioRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  function service(): HostPortfolioService {
    const overrides = app.hostPortfolioOverrides
    if (overrides !== undefined) {
      return makeHostPortfolioService({
        repo: overrides.repo,
        counts: overrides.counts ?? (() => Promise.resolve(new Map())),
        totals:
          overrides.totals ?? (() => Promise.resolve({ totalRegistrations: 0, totalCheckedIn: 0 })),
        ...(overrides.presignEventMedia !== undefined
          ? { presignEventMedia: overrides.presignEventMedia }
          : {}),
        ...(overrides.now !== undefined ? { now: overrides.now } : {}),
      })
    }
    const sql = container.getDb().sql
    return makeHostPortfolioService({
      repo: makeDrizzleHostPortfolioRepository(sql),
      counts: (cleanupIds) => hostedEventCounts(sql, cleanupIds),
      totals: (args) => hostedRegistrationTotals(sql, args),
      presignEventMedia: makeEventMediaPresigner(container.storage),
    })
  }

  route(
    app,
    "listMyHostedEvents",
    { config: { rateLimit: HOSTED_EVENTS_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const q = parse(HostedEventsQuerySchema, request.query ?? {})
      const validated = parse(ListMyHostedEventsRequestSchema, {
        ...(q.when !== undefined ? { when: q.when } : {}),
        ...(q.orgId !== undefined ? { orgId: q.orgId } : {}),
        ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
      })
      const payload: ListMyHostedEventsResponse = await service().listMyHostedEvents(userId, {
        ...(validated.when !== undefined ? { when: validated.when } : {}),
        ...(validated.orgId !== undefined ? { orgId: validated.orgId } : {}),
        ...(validated.cursor !== undefined ? { cursor: validated.cursor } : {}),
        limit: validated.limit ?? HOSTED_EVENTS_DEFAULT_LIMIT,
      })
      reply.status(200).send(payload)
    },
  )
}
