import {
  AcceptEventTeamInviteRequestSchema,
  IdSchema,
  InviteEventTeamMemberRequestSchema,
  ListEventTeamRequestSchema,
  RevokeEventTeamInviteRequestSchema,
  type AcceptEventTeamInviteResponse,
  type InviteEventTeamMemberResponse,
  type ListEventTeamResponse,
  type RevokeEventTeamInviteResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireAuth } from "../../auth/context.js"
import { parse } from "../_validate.js"
import { perIdentity } from "../../plugins/rate-limit.js"
import { route } from "../../versioning/route.js"
import { requireCapability } from "../../services/host/authz.js"
import {
  makeHostTeamService,
  type HostTeamService,
  type HostTeamServiceDeps,
} from "../../services/host/host-team-service.js"
import { makeDrizzleHostTeamRepository } from "../../services/host/host-team-repository.drizzle.js"
import type { HostTeamRepository } from "../../services/host/host-team-repository.types.js"

export interface HostTeamOverrides {
  repo: HostTeamRepository
  standing: HostTeamServiceDeps["standing"]
  counters?: HostTeamServiceDeps["counters"]
  mailer?: HostTeamServiceDeps["mailer"]
  eventTitleOf?: HostTeamServiceDeps["eventTitleOf"]
  now?: HostTeamServiceDeps["now"]
  newId?: HostTeamServiceDeps["newId"]
  newToken?: HostTeamServiceDeps["newToken"]
}

declare module "fastify" {
  interface FastifyInstance {
    hostTeamOverrides?: HostTeamOverrides
  }
}

const CleanupIdParamsSchema = z.object({ id: IdSchema }).strict()

const InviteParamsSchema = z.object({ id: IdSchema, inviteId: IdSchema }).strict()

export const TEAM_INVITE_RATE_LIMIT = perIdentity({ max: 20, timeWindow: "1 hour" })

export const TEAM_MUTATION_RATE_LIMIT = perIdentity({ max: 30, timeWindow: "1 minute" })

export async function registerHostTeamRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  function service(): HostTeamService {
    const overrides = app.hostTeamOverrides
    if (overrides !== undefined) {
      return makeHostTeamService({
        repo: overrides.repo,
        standing: overrides.standing,
        ...(overrides.counters !== undefined ? { counters: overrides.counters } : {}),
        ...(overrides.mailer !== undefined ? { mailer: overrides.mailer } : {}),
        ...(overrides.eventTitleOf !== undefined ? { eventTitleOf: overrides.eventTitleOf } : {}),
        ...(overrides.now !== undefined ? { now: overrides.now } : {}),
        ...(overrides.newId !== undefined ? { newId: overrides.newId } : {}),
        ...(overrides.newToken !== undefined ? { newToken: overrides.newToken } : {}),
        logger: app.log,
      })
    }
    const sql = container.getDb().sql
    return makeHostTeamService({
      repo: makeDrizzleHostTeamRepository(sql),
      standing: (cleanupId, userId, capability) =>
        requireCapability(sql, cleanupId, userId, capability),
      counters: container.getCounterStore(),
      mailer: container.mailer,
      eventTitleOf: async (cleanupId: string) => {
        const rows = await sql<{ title: string }[]>`
          SELECT title FROM cleanups WHERE id = ${cleanupId} LIMIT 1
        `
        return rows[0]?.title ?? null
      },
      ...(container.env.WEB_ORIGINS[0] !== undefined
        ? { webOrigin: container.env.WEB_ORIGINS[0] }
        : {}),
      logger: app.log,
    })
  }

  route(app, "listEventTeam", async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(CleanupIdParamsSchema, request.params)
    parse(ListEventTeamRequestSchema, { id })
    const payload: ListEventTeamResponse = await service().listTeam(id, userId)
    reply.status(200).send(payload)
  })

  route(
    app,
    "inviteEventTeamMember",
    { preHandler: csrfProtect, config: { rateLimit: TEAM_INVITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      const body = parse(InviteEventTeamMemberRequestSchema, { ...(request.body as object), id })
      const payload: InviteEventTeamMemberResponse = await service().inviteMember(id, userId, body)
      reply.status(201).send(payload)
    },
  )

  route(
    app,
    "revokeEventTeamInvite",
    { preHandler: csrfProtect, config: { rateLimit: TEAM_MUTATION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id, inviteId } = parse(InviteParamsSchema, request.params)
      const body = parse(RevokeEventTeamInviteRequestSchema, { id, inviteId })
      const payload: RevokeEventTeamInviteResponse = await service().revokeInvite(
        id,
        userId,
        body.inviteId,
      )
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "acceptEventTeamInvite",
    { preHandler: csrfProtect, config: { rateLimit: TEAM_MUTATION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      const body = parse(AcceptEventTeamInviteRequestSchema, { ...(request.body as object), id })
      const payload: AcceptEventTeamInviteResponse = await service().acceptInvite(
        id,
        userId,
        body.token,
      )
      reply.status(200).send(payload)
    },
  )
}
