import {
  CreateEventTicketTypeRequestSchema,
  DeleteEventTicketTypeRequestSchema,
  ListEventTicketTypesRequestSchema,
  ReorderEventTicketTypesRequestSchema,
  UpdateEventTicketTypeRequestSchema,
  type CreateEventTicketTypeResponse,
  type DeleteEventTicketTypeResponse,
  type ListEventTicketTypesResponse,
  type ReorderEventTicketTypesResponse,
  type UpdateEventTicketTypeResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireAuth } from "../../auth/context.js"
import { resolveAuthContext } from "../../auth/context.js"
import { route } from "../../versioning/route.js"
import { parse } from "../_validate.js"
import {
  CleanupIdParamsSchema,
  TICKET_TYPE_READ_RATE_LIMIT,
  TICKET_TYPE_WRITE_RATE_LIMIT,
  TicketTypeParamsSchema,
  bodyWith,
  queryWith,
  type HostRouteContext,
} from "./_host-routes.js"

export function registerHostTicketRoutes(
  app: FastifyInstance,
  _container: Container,
  ctx: HostRouteContext,
): void {
  const csrfProtect = _container.csrf.protect

  route(
    app,
    "listEventTicketTypes",
    { config: { rateLimit: TICKET_TYPE_READ_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = parse(CleanupIdParamsSchema, request.params)
      const auth = await resolveAuthContext(request)
      const userId = auth.userId ?? null
      await ctx.guards().requireVisible(id, userId)
      const query = parse(ListEventTicketTypesRequestSchema, queryWith(request, { id }))
      const canManage = await ctx.guards().canManage(id, userId, "manage_tickets")
      const payload: ListEventTicketTypesResponse = await ctx
        .services()
        .tickets.list(query, { userId, canManage })
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "createEventTicketType",
    { preHandler: csrfProtect, config: { rateLimit: TICKET_TYPE_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      await ctx.guards().requireCapability(id, userId, "manage_tickets")
      const body = parse(CreateEventTicketTypeRequestSchema, bodyWith(request, { id }))
      const payload: CreateEventTicketTypeResponse = await ctx
        .services()
        .tickets.create(body, userId)
      reply.status(201).send(payload)
    },
  )

  route(
    app,
    "reorderEventTicketTypes",
    { preHandler: csrfProtect, config: { rateLimit: TICKET_TYPE_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      await ctx.guards().requireCapability(id, userId, "manage_tickets")
      const body = parse(ReorderEventTicketTypesRequestSchema, bodyWith(request, { id }))
      const payload: ReorderEventTicketTypesResponse = await ctx.services().tickets.reorder(body)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "updateEventTicketType",
    { preHandler: csrfProtect, config: { rateLimit: TICKET_TYPE_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id, ticketTypeId } = parse(TicketTypeParamsSchema, request.params)
      await ctx.guards().requireCapability(id, userId, "manage_tickets")
      const body = parse(
        UpdateEventTicketTypeRequestSchema,
        bodyWith(request, { id, ticketTypeId }),
      )
      const payload: UpdateEventTicketTypeResponse = await ctx
        .services()
        .tickets.update(body, userId)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "deleteEventTicketType",
    { preHandler: csrfProtect, config: { rateLimit: TICKET_TYPE_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id, ticketTypeId } = parse(TicketTypeParamsSchema, request.params)
      await ctx.guards().requireCapability(id, userId, "manage_tickets")
      const body = parse(DeleteEventTicketTypeRequestSchema, { id, ticketTypeId })
      const payload: DeleteEventTicketTypeResponse = await ctx.services().tickets.remove(body)
      reply.status(200).send(payload)
    },
  )
}
