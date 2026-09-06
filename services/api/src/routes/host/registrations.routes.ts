import {
  CancelEventRegistrationRequestSchema,
  CreateWalkupRegistrationRequestSchema,
  GetEventRegistrationAnswersRequestSchema,
  GetEventRegistrationRequestSchema,
  ListEventRegistrationsRequestSchema,
  RegisterForEventRequestSchema,
  RemoveEventRegistrationRequestSchema,
  SetEventRegistrationNoteRequestSchema,
  TransferEventRegistrationRequestSchema,
  type CancelEventRegistrationResponse,
  type CreateWalkupRegistrationResponse,
  type GetEventRegistrationAnswersResponse,
  type GetEventRegistrationResponse,
  type ListEventRegistrationsResponse,
  type RegisterForEventResponse,
  type RemoveEventRegistrationResponse,
  type SetEventRegistrationNoteResponse,
  type TransferEventRegistrationResponse,
} from "@civfix/shared"
import { can, type HostStanding } from "@civfix/shared/host"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireAuth } from "../../auth/context.js"
import { route } from "../../versioning/route.js"
import { parse, trimTextFields } from "../_validate.js"
import type { RegistrationProjection } from "../../services/host/registration-service.js"
import {
  CleanupIdParamsSchema,
  REGISTER_RATE_LIMIT,
  REGISTRATION_WRITE_RATE_LIMIT,
  ROSTER_READ_RATE_LIMIT,
  RegistrationParamsSchema,
  WALKUP_RATE_LIMIT,
  bodyWith,
  queryWith,
  type HostRouteContext,
} from "./_host-routes.js"

export const WalkupBodySchema = trimTextFields(CreateWalkupRegistrationRequestSchema, "name")

function projectionFor(standing: HostStanding): RegistrationProjection {
  return {
    includeHostNote: can(standing, "manage_event"),
    includeAnswersPreview: can(standing, "view_answers"),
  }
}

export function registerHostRegistrationRoutes(
  app: FastifyInstance,
  container: Container,
  ctx: HostRouteContext,
): void {
  const csrfProtect = container.csrf.protect

  route(
    app,
    "registerForEvent",
    { preHandler: csrfProtect, config: { rateLimit: REGISTER_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      await ctx.guards().requireVisible(id, userId)
      const body = parse(RegisterForEventRequestSchema, bodyWith(request, { id }))
      const payload: RegisterForEventResponse = await ctx
        .services()
        .registrations.register(body, { kind: "user", userId })
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "listEventRegistrations",
    { config: { rateLimit: ROSTER_READ_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      const standing = await ctx.guards().requireCapability(id, userId, "view_roster")
      const query = parse(ListEventRegistrationsRequestSchema, queryWith(request, { id }))
      const payload: ListEventRegistrationsResponse = await ctx
        .services()
        .registrations.listRoster(query, userId, projectionFor(standing))
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "createWalkupRegistration",
    { preHandler: csrfProtect, config: { rateLimit: WALKUP_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      await ctx.guards().requireCapability(id, userId, "check_in")
      const body = parse(WalkupBodySchema, bodyWith(request, { id }))
      const payload: CreateWalkupRegistrationResponse = await ctx
        .services()
        .registrations.walkup(body, userId)
      reply.status(201).send(payload)
    },
  )

  route(
    app,
    "getEventRegistration",
    { config: { rateLimit: ROSTER_READ_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id, registrationId } = parse(RegistrationParamsSchema, request.params)
      const standing = await ctx.guards().requireCapability(id, userId, "view_roster")
      parse(GetEventRegistrationRequestSchema, { id, registrationId })
      const payload: GetEventRegistrationResponse = await ctx
        .services()
        .registrations.getRegistration(id, registrationId, userId, projectionFor(standing))
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "removeEventRegistration",
    { preHandler: csrfProtect, config: { rateLimit: REGISTRATION_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id, registrationId } = parse(RegistrationParamsSchema, request.params)
      await ctx.guards().requireCapability(id, userId, "manage_event")
      const body = parse(
        RemoveEventRegistrationRequestSchema,
        bodyWith(request, { id, registrationId }),
      )
      const payload: RemoveEventRegistrationResponse = await ctx
        .services()
        .registrations.remove(body, userId)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "cancelEventRegistration",
    { preHandler: csrfProtect, config: { rateLimit: REGISTRATION_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id, registrationId } = parse(RegistrationParamsSchema, request.params)
      const byHost = await ctx.guards().canManage(id, userId, "manage_event")
      if (!byHost) {
        const mine = await ctx
          .services()
          .repo.findRegistration(id, registrationId)
        if (mine === null || mine.userId !== userId) {
          await ctx.guards().requireCapability(id, userId, "manage_event")
        }
      }
      const body = parse(
        CancelEventRegistrationRequestSchema,
        bodyWith(request, { id, registrationId }),
      )
      const payload: CancelEventRegistrationResponse = await ctx
        .services()
        .registrations.cancel(body, userId, byHost)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "transferEventRegistration",
    { preHandler: csrfProtect, config: { rateLimit: REGISTRATION_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id, registrationId } = parse(RegistrationParamsSchema, request.params)
      await ctx.guards().requireCapability(id, userId, "manage_tickets")
      const body = parse(
        TransferEventRegistrationRequestSchema,
        bodyWith(request, { id, registrationId }),
      )
      const payload: TransferEventRegistrationResponse = await ctx
        .services()
        .registrations.transfer(body, userId)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "setEventRegistrationNote",
    { preHandler: csrfProtect, config: { rateLimit: REGISTRATION_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id, registrationId } = parse(RegistrationParamsSchema, request.params)
      await ctx.guards().requireCapability(id, userId, "manage_event")
      const body = parse(
        SetEventRegistrationNoteRequestSchema,
        bodyWith(request, { id, registrationId }),
      )
      const payload: SetEventRegistrationNoteResponse = await ctx
        .services()
        .registrations.setNote(body, userId)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "getEventRegistrationAnswers",
    { config: { rateLimit: ROSTER_READ_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id, registrationId } = parse(RegistrationParamsSchema, request.params)
      await ctx.guards().requireCapability(id, userId, "view_answers")
      parse(GetEventRegistrationAnswersRequestSchema, { id, registrationId })
      const payload: GetEventRegistrationAnswersResponse = await ctx
        .services()
        .registrations.getAnswers(id, registrationId, userId)
      reply.status(200).send(payload)
    },
  )
}
