import {
  ClaimWaitlistOfferRequestSchema,
  JoinEventWaitlistRequestSchema,
  LeaveEventWaitlistRequestSchema,
  ListEventWaitlistRequestSchema,
  PromoteFromWaitlistRequestSchema,
  type ClaimWaitlistOfferResponse,
  type JoinEventWaitlistResponse,
  type LeaveEventWaitlistResponse,
  type ListEventWaitlistResponse,
  type PromoteFromWaitlistResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireAuth } from "../../auth/context.js"
import { route } from "../../versioning/route.js"
import { parse } from "../_validate.js"
import {
  CleanupIdParamsSchema,
  WAITLIST_READ_RATE_LIMIT,
  WAITLIST_WRITE_RATE_LIMIT,
  WaitlistParamsSchema,
  bodyWith,
  queryWith,
  type HostRouteContext,
} from "./_host-routes.js"

export function registerHostWaitlistRoutes(
  app: FastifyInstance,
  container: Container,
  ctx: HostRouteContext,
): void {
  const csrfProtect = container.csrf.protect

  route(
    app,
    "joinEventWaitlist",
    { preHandler: csrfProtect, config: { rateLimit: WAITLIST_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      await ctx.guards().requireVisible(id, userId)
      const body = parse(JoinEventWaitlistRequestSchema, bodyWith(request, { id }))
      const payload: JoinEventWaitlistResponse = await ctx
        .services()
        .waitlist.join(body, { kind: "user", userId })
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "leaveEventWaitlist",
    { preHandler: csrfProtect, config: { rateLimit: WAITLIST_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      const body = parse(LeaveEventWaitlistRequestSchema, queryWith(request, { id }))
      const payload: LeaveEventWaitlistResponse = await ctx
        .services()
        .waitlist.leave(body, { kind: "user", userId })
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "listEventWaitlist",
    { config: { rateLimit: WAITLIST_READ_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      await ctx.guards().requireCapability(id, userId, "view_roster")
      const query = parse(ListEventWaitlistRequestSchema, queryWith(request, { id }))
      const payload: ListEventWaitlistResponse = await ctx.services().waitlist.list(query)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "claimWaitlistOffer",
    { preHandler: csrfProtect, config: { rateLimit: WAITLIST_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      const body = parse(ClaimWaitlistOfferRequestSchema, bodyWith(request, { id }))
      const payload: ClaimWaitlistOfferResponse = await ctx
        .services()
        .waitlist.claim(body, { kind: "user", userId })
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "promoteFromWaitlist",
    { preHandler: csrfProtect, config: { rateLimit: WAITLIST_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id, waitlistId } = parse(WaitlistParamsSchema, request.params)
      await ctx.guards().requireCapability(id, userId, "manage_tickets")
      const body = parse(PromoteFromWaitlistRequestSchema, { id, waitlistId })
      const payload: PromoteFromWaitlistResponse = await ctx
        .services()
        .waitlist.promote(body, userId)
      reply.status(200).send(payload)
    },
  )
}
