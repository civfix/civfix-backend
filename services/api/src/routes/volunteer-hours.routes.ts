import {
  EventHoursQuerySchema,
  LeaderboardQuerySchema,
  LogEventHoursRequestSchema,
  MyVolunteerHoursEntriesQuerySchema,
  PublicVolunteerHoursQuerySchema,
  IdSchema,
  type EventHoursResponse,
  type GetMyHoursResponse,
  type LeaderboardResponse,
  type LogEventHoursResponse,
  type MyVolunteerHoursEntriesResponse,
  type PublicVolunteerHoursResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance, FastifyReply } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import {
  makeVolunteerHoursService,
  type CleanupHoursLookup,
  type HoursModerationSink,
  type VolunteerHoursRepository,
  type VolunteerHoursService,
} from "../services/volunteer-hours-service.js"
import { toHoursAnomalyModerationItem } from "../services/volunteer-hours-anomaly.js"
import { makeModerationService } from "../services/admin/moderation-service.js"
import { makeDrizzleModerationRepository } from "../services/admin/moderation-repository.drizzle.js"
import { makeDrizzleCleanupRepository } from "../services/cleanup-repository.drizzle.js"
import { makeDrizzleVerificationRepository } from "../services/verification-repository.drizzle.js"
import { makeRouteNotificationService } from "../services/route-notifier.js"
import type { NotificationService } from "../services/notification-service.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"

export interface VolunteerHoursOverrides {
  repo: VolunteerHoursRepository
  cleanups?: CleanupHoursLookup
  isVerified?: (userId: string) => Promise<boolean>
  notifier?: Pick<NotificationService, "createNotification">
  moderation?: HoursModerationSink
}

declare module "fastify" {
  interface FastifyInstance {
    volunteerOverrides?: VolunteerHoursOverrides
  }
}

const CleanupIdParamsSchema = z.object({ id: IdSchema }).strict()
const GeoidParamsSchema = z.object({ geoid: z.string().min(1).max(64) }).strict()
const UserIdParamsSchema = z.object({ id: IdSchema }).strict()

const LEADERBOARD_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const

const PUBLIC_HOURS_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const

const LOG_EVENT_HOURS_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const

function appendVary(reply: FastifyReply, ...fields: readonly string[]): void {
  const existing = reply.getHeader("Vary")
  const raw = Array.isArray(existing) ? existing.join(",") : typeof existing === "string" ? existing : ""
  const current = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  for (const field of fields) {
    if (!current.some((c) => c.toLowerCase() === field.toLowerCase())) current.push(field)
  }
  reply.header("Vary", current.join(", "))
}

export async function registerVolunteerHoursRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  function repo(): VolunteerHoursRepository {
    const overrides = app.volunteerOverrides
    if (overrides) return overrides.repo
    return container.getVolunteerHoursRepo()
  }

  function cleanupLookup(): CleanupHoursLookup {
    const overrides = app.volunteerOverrides
    if (overrides?.cleanups) return overrides.cleanups
    return {
      async load(cleanupId: string) {
        const record = await makeDrizzleCleanupRepository(container.getDb().sql).findCleanupById(
          cleanupId,
          null,
        )
        if (!record) return null
        return {
          organizerUserId: record.organizerUserId,
          status: record.status,
          jurisdictionGeoid: record.jurisdictionGeoid,
          title: record.title,
          scheduledAt: record.scheduledAt,
          completedAt: record.completedAt,
        }
      },
      listMemberIds: (cleanupId: string, limit: number) =>
        makeDrizzleCleanupRepository(container.getDb().sql).listMemberIds(cleanupId, limit),
      roleOf: (cleanupId: string, userId: string) =>
        makeDrizzleCleanupRepository(container.getDb().sql).roleOf(cleanupId, userId),
    }
  }

  function isVerified(): (userId: string) => Promise<boolean> {
    const overrides = app.volunteerOverrides
    if (overrides?.isVerified) return overrides.isVerified
    return (userId: string) =>
      makeDrizzleVerificationRepository(container.getDb().sql).isVerified(userId)
  }

  function notifier(): Pick<NotificationService, "createNotification"> | undefined {
    const overrides = app.volunteerOverrides
    if (overrides) return overrides.notifier
    return makeRouteNotificationService(container, app.log)
  }

  function moderationSink(): HoursModerationSink | undefined {
    const overrides = app.volunteerOverrides
    if (overrides) return overrides.moderation
    return {
      async flag(input) {
        await makeModerationService({
          repo: makeDrizzleModerationRepository(container.getDb().sql),
        }).createItem(toHoursAnomalyModerationItem(input))
      },
    }
  }

  function service(): VolunteerHoursService {
    const bells = notifier()
    const moderation = moderationSink()
    const isBlockedEitherWay = app.volunteerOverrides
      ? undefined
      : (viewerId: string, targetId: string) =>
          container.getBlocksRepo().isBlockedEitherWay(viewerId, targetId)
    return makeVolunteerHoursService({
      repo: repo(),
      cleanups: cleanupLookup(),
      isVerified: isVerified(),
      ...(bells !== undefined ? { notifier: bells } : {}),
      ...(moderation !== undefined ? { moderation } : {}),
      ...(isBlockedEitherWay !== undefined ? { isBlockedEitherWay } : {}),
      weeklyFlagHours: container.env.VOLUNTEER_HOURS_WEEKLY_FLAG_HOURS,
      logger: app.log,
    })
  }

  route(app, "getMyHours", async (request, reply) => {
    const userId = requireAuth(request)
    const hours = await service().getMyHours(userId)
    const payload: GetMyHoursResponse = { hours }
    reply.status(200).send(payload)
  })

  route(app, "getMyHoursEntries", async (request, reply) => {
    const userId = requireAuth(request)
    const query = parse(MyVolunteerHoursEntriesQuerySchema, request.query ?? {})
    const payload: MyVolunteerHoursEntriesResponse = await service().getMyHoursEntries(userId, query)
    reply.status(200).send(payload)
  })

  route(
    app,
    "getPublicVolunteerHours",
    { config: { rateLimit: PUBLIC_HOURS_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = parse(UserIdParamsSchema, request.params)
      const query = parse(PublicVolunteerHoursQuerySchema, {
        ...((request.query as object | undefined) ?? {}),
        id,
      })
      const viewerId = request.auth?.userId ?? null
      const payload: PublicVolunteerHoursResponse = await service().getPublicHours(query, viewerId)

      appendVary(reply, "Cookie", "Authorization")
      reply.header(
        "Cache-Control",
        viewerId === null ? "public, max-age=60" : "private, max-age=0, no-store",
      )
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "logEventHours",
    { preHandler: csrfProtect, config: { rateLimit: LOG_EVENT_HOURS_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      const body = parse(LogEventHoursRequestSchema, { ...(request.body as object), id })
      const payload: LogEventHoursResponse = await service().logEventHours({
        cleanupId: body.id,
        actorId: userId,
        entries: body.entries,
      })
      reply.status(200).send(payload)
    },
  )

  route(app, "getEventHours", async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(CleanupIdParamsSchema, request.params)
    const query = parse(EventHoursQuerySchema, {
      ...((request.query as object | undefined) ?? {}),
      id,
    })
    const payload: EventHoursResponse = await service().getEventHours(query.id, userId)
    reply.status(200).send(payload)
  })

  route(
    app,
    "getJurisdictionLeaderboard",
    { config: { rateLimit: LEADERBOARD_RATE_LIMIT } },
    async (request, reply) => {
      const { geoid } = parse(GeoidParamsSchema, request.params)
      const query = parse(LeaderboardQuerySchema, {
        ...((request.query as object | undefined) ?? {}),
        geoid,
      })
      const viewerId = request.auth?.userId ?? null
      const payload: LeaderboardResponse = await service().leaderboard(geoid, query, viewerId)

      appendVary(reply, "Cookie", "Authorization")
      reply.header(
        "Cache-Control",
        viewerId === null ? "public, max-age=60" : "private, max-age=0, no-store",
      )
      reply.status(200).send(payload)
    },
  )
}
