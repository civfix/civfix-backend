import {
  CheckInEventSeatRequestSchema,
  GetEventCheckinCountersRequestSchema,
  GetGuestEventTicketRequestSchema,
  GetMyEventTicketRequestSchema,
  MarkEventNoShowsRequestSchema,
  ScanEventTicketRequestSchema,
  UndoEventCheckInRequestSchema,
  type CheckInEventSeatResponse,
  type GetEventCheckinCountersResponse,
  type GetGuestEventTicketResponse,
  type GetMyEventTicketResponse,
  type MarkEventNoShowsResponse,
  type ScanEventTicketResponse,
  type UndoEventCheckInResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireAuth } from "../../auth/context.js"
import { route } from "../../versioning/route.js"
import { parse } from "../_validate.js"
import {
  CHECKIN_RATE_LIMIT,
  CleanupIdParamsSchema,
  GUEST_TICKET_RATE_LIMIT,
  SCAN_RATE_LIMIT,
  SeatParamsSchema,
  TICKET_READ_RATE_LIMIT,
  bodyWith,
  type HostRouteContext,
} from "./_host-routes.js"

export function registerHostCheckinRoutes(
  app: FastifyInstance,
  container: Container,
  ctx: HostRouteContext,
): void {
  const csrfProtect = container.csrf.protect

  route(
    app,
    "getMyEventTicket",
    { config: { rateLimit: TICKET_READ_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      const query = parse(GetMyEventTicketRequestSchema, { id })
      const payload: GetMyEventTicketResponse = await ctx
        .services()
        .checkin.myTicket(query, userId)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "getGuestEventTicket",
    { config: { rateLimit: GUEST_TICKET_RATE_LIMIT } },
    async (request, reply) => {
      const body = parse(GetGuestEventTicketRequestSchema, request.body)
      const payload: GetGuestEventTicketResponse = await ctx.services().checkin.guestTicket(body)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "scanEventTicket",
    { preHandler: csrfProtect, config: { rateLimit: SCAN_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      await ctx.guards().requireCapability(id, userId, "check_in")
      const body = parse(ScanEventTicketRequestSchema, bodyWith(request, { id }))
      const payload: ScanEventTicketResponse = await ctx.services().checkin.scan(body, userId)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "checkInEventSeat",
    { preHandler: csrfProtect, config: { rateLimit: CHECKIN_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      await ctx.guards().requireCapability(id, userId, "check_in")
      const body = parse(CheckInEventSeatRequestSchema, bodyWith(request, { id }))
      const payload: CheckInEventSeatResponse = await ctx.services().checkin.checkIn(body, userId)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "markEventNoShows",
    { preHandler: csrfProtect, config: { rateLimit: CHECKIN_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      await ctx.guards().requireCapability(id, userId, "check_in")
      const body = parse(MarkEventNoShowsRequestSchema, bodyWith(request, { id }))
      const payload: MarkEventNoShowsResponse = await ctx
        .services()
        .checkin.markNoShows(body, userId)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "undoEventCheckIn",
    { preHandler: csrfProtect, config: { rateLimit: CHECKIN_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id, seatId } = parse(SeatParamsSchema, request.params)
      await ctx.guards().requireCapability(id, userId, "check_in")
      const body = parse(UndoEventCheckInRequestSchema, { id, seatId })
      const payload: UndoEventCheckInResponse = await ctx.services().checkin.undo(body, userId)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "getEventCheckinCounters",
    { config: { rateLimit: CHECKIN_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      await ctx.guards().requireCapability(id, userId, "check_in")
      const query = parse(GetEventCheckinCountersRequestSchema, { id })
      const payload: GetEventCheckinCountersResponse = await ctx
        .services()
        .checkin.counters(query)
      reply.status(200).send(payload)
    },
  )
}
