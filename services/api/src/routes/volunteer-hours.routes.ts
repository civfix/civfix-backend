import {
  LeaderboardQuerySchema,
  LogEventHoursRequestSchema,
  IdSchema,
  type GetMyHoursResponse,
  type LeaderboardResponse,
  type LogEventHoursResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import {
  makeVolunteerHoursService,
  type CleanupHoursLookup,
  type VolunteerHoursRepository,
  type VolunteerHoursService,
} from "../services/volunteer-hours-service.js"
import { makeDrizzleCleanupRepository } from "../services/cleanup-repository.drizzle.js"
import { makeDrizzleVerificationRepository } from "../services/verification-repository.drizzle.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"

export interface VolunteerHoursOverrides {
  repo: VolunteerHoursRepository
  cleanups?: CleanupHoursLookup
  isVerified?: (userId: string) => Promise<boolean>
}

declare module "fastify" {
  interface FastifyInstance {
    volunteerOverrides?: VolunteerHoursOverrides
  }
}

const CleanupIdParamsSchema = z.object({ id: IdSchema }).strict()
const GeoidParamsSchema = z.object({ geoid: z.string().min(1).max(64) }).strict()

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
        }
      },
      listMemberIds: (cleanupId: string, limit: number) =>
        makeDrizzleCleanupRepository(container.getDb().sql).listMemberIds(cleanupId, limit),
      // WS4/WS5: the acting user's membership role — gates logging to organizer|cohost (D4).
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

  function service(): VolunteerHoursService {
    return makeVolunteerHoursService({
      repo: repo(),
      cleanups: cleanupLookup(),
      isVerified: isVerified(),
      logger: app.log,
    })
  }

  route(app, "getMyHours", async (request, reply) => {
    const userId = requireAuth(request)
    const hours = await service().getMyHours(userId)
    const payload: GetMyHoursResponse = { hours }
    reply.status(200).send(payload)
  })

  // WS5 per-attendee shape: {entries: [{userId, hours}]} (the flat bulk `hours` body is gone). The
  // service enforces the D4 gate (actor organizer|cohost AND the ACTOR verified), the status 'done'
  // gate, and per-entry membership; `credited` = attendee rows written.
  route(app, "logEventHours", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(CleanupIdParamsSchema, request.params)
    const body = parse(LogEventHoursRequestSchema, { ...(request.body as object), id })
    const payload: LogEventHoursResponse = await service().logEventHours({
      cleanupId: body.id,
      actorId: userId,
      entries: body.entries,
    })
    reply.status(200).send(payload)
  })

  route(app, "getJurisdictionLeaderboard", async (request, reply) => {
    const { geoid } = parse(GeoidParamsSchema, request.params)
    const query = parse(LeaderboardQuerySchema, request.query)
    const payload: LeaderboardResponse = await service().leaderboard(geoid, query)
    reply.status(200).send(payload)
  })
}
