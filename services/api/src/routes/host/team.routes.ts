import {
  AcceptEventTeamInviteRequestSchema,
  AcceptMyEventInviteRequestSchema,
  DeclineMyEventInviteRequestSchema,
  IdSchema,
  InviteEventTeamMemberRequestSchema,
  ListEventTeamRequestSchema,
  ListMyEventInvitesRequestSchema,
  RevokeEventTeamInviteRequestSchema,
  type AcceptEventTeamInviteResponse,
  type AcceptMyEventInviteResponse,
  type DeclineMyEventInviteResponse,
  type InviteEventTeamMemberResponse,
  type ListEventTeamResponse,
  type ListMyEventInvitesResponse,
  type RevokeEventTeamInviteResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireAuth } from "../../auth/context.js"
import { parse } from "../_validate.js"
import { perIdentity } from "../../plugins/rate-limit.js"
import { route } from "../../versioning/route.js"
import {
  makeHostTeamService,
  makeSqlTeamStanding,
  MY_EVENT_INVITES_DEFAULT_LIMIT,
  type HostTeamService,
  type HostTeamServiceDeps,
} from "../../services/host/host-team-service.js"
import { makeDrizzleHostTeamRepository } from "../../services/host/host-team-repository.drizzle.js"
import type { HostTeamRepository } from "../../services/host/host-team-repository.js"
import { makeEventMediaPresigner } from "../../services/host/event-media.js"
import { makeRouteNotificationService } from "../../services/route-notifier.js"
import { makeRouteCleanupReader } from "../../services/route-cleanup-reader.js"
import { webBaseUrlOf } from "../../lib/base-url.js"

const ONE_MINUTE = "1 minute"
const ONE_HOUR = "1 hour"

export interface HostTeamOverrides {
  repo: HostTeamRepository
  standing: HostTeamServiceDeps["standing"]
  loadEvent: HostTeamServiceDeps["loadEvent"]
  counters?: HostTeamServiceDeps["counters"]
  mailer?: HostTeamServiceDeps["mailer"]
  notifier?: HostTeamServiceDeps["notifier"]
  presignEventMedia?: HostTeamServiceDeps["presignEventMedia"]
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

const MyInviteParamsSchema = z.object({ inviteId: IdSchema }).strict()

const MyInvitesQuerySchema = z
  .object({ cursor: z.string().optional(), limit: z.string().optional() })
  .strict()

export const TEAM_INVITE_RATE_LIMIT = perIdentity({ max: 20, timeWindow: ONE_HOUR })

export const TEAM_MUTATION_RATE_LIMIT = perIdentity({ max: 30, timeWindow: ONE_MINUTE })

export const MY_EVENT_INVITES_READ_RATE_LIMIT = perIdentity({ max: 60, timeWindow: ONE_MINUTE })

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
        loadEvent: overrides.loadEvent,
        ...(overrides.counters !== undefined ? { counters: overrides.counters } : {}),
        ...(overrides.mailer !== undefined ? { mailer: overrides.mailer } : {}),
        ...(overrides.notifier !== undefined ? { notifier: overrides.notifier } : {}),
        ...(overrides.presignEventMedia !== undefined
          ? { presignEventMedia: overrides.presignEventMedia }
          : {}),
        ...(overrides.eventTitleOf !== undefined ? { eventTitleOf: overrides.eventTitleOf } : {}),
        ...(overrides.now !== undefined ? { now: overrides.now } : {}),
        ...(overrides.newId !== undefined ? { newId: overrides.newId } : {}),
        ...(overrides.newToken !== undefined ? { newToken: overrides.newToken } : {}),
        webOrigin: webBaseUrlOf(container.env),
        logger: app.log,
      })
    }
    const sql = container.getDb().sql
    const repo = makeDrizzleHostTeamRepository(sql)
    return makeHostTeamService({
      repo,
      standing: makeSqlTeamStanding(sql),
      loadEvent: makeRouteCleanupReader(container, app.log),
      counters: container.getCounterStore(),
      mailer: container.mailer,
      notifier: makeRouteNotificationService(container, app.log),
      presignEventMedia: makeEventMediaPresigner(container.storage),
      affiliations: container.getAffiliationLoader(),
      eventTitleOf: (cleanupId: string) => repo.eventTitleOf(cleanupId),
      webOrigin: webBaseUrlOf(container.env),
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

  route(
    app,
    "listMyEventInvites",
    { config: { rateLimit: MY_EVENT_INVITES_READ_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const q = parse(MyInvitesQuerySchema, request.query ?? {})
      const validated = parse(ListMyEventInvitesRequestSchema, {
        ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
      })
      const payload: ListMyEventInvitesResponse = await service().listMyInvites(userId, {
        ...(validated.cursor !== undefined ? { cursor: validated.cursor } : {}),
        limit: validated.limit ?? MY_EVENT_INVITES_DEFAULT_LIMIT,
      })
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "acceptMyEventInvite",
    { preHandler: csrfProtect, config: { rateLimit: TEAM_MUTATION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const params = parse(MyInviteParamsSchema, request.params)
      const body = parse(AcceptMyEventInviteRequestSchema, { inviteId: params.inviteId })
      const payload: AcceptMyEventInviteResponse = await service().acceptMyInvite(
        userId,
        body.inviteId,
      )
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "declineMyEventInvite",
    { preHandler: csrfProtect, config: { rateLimit: TEAM_MUTATION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const params = parse(MyInviteParamsSchema, request.params)
      const body = parse(DeclineMyEventInviteRequestSchema, { inviteId: params.inviteId })
      const payload: DeclineMyEventInviteResponse = await service().declineMyInvite(
        userId,
        body.inviteId,
      )
      reply.status(200).send(payload)
    },
  )
}
