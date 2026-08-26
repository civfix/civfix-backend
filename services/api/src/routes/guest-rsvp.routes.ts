import {
  GetCleanupGuestsRequestSchema,
  GuestRsvpCancelRequestSchema,
  GuestRsvpRequestRequestSchema,
  GuestRsvpVerifyRequestSchema,
  IdSchema,
  type GetCleanupGuestsResponse,
  type GuestRsvpCancelResponse,
  type GuestRsvpRequestResponse,
  type GuestRsvpVerifyResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { perHost } from "../plugins/rate-limit.js"
import { route } from "../versioning/route.js"
import { parse, trimTextFields } from "./_validate.js"
import {
  makeContainerGuestRsvpService,
  type GuestRsvpOverrides,
} from "../services/guest-rsvp-wiring.js"
import type { GuestRequestContext, GuestRsvpService } from "../services/guest-rsvp-service.js"

export const GUEST_RSVP_REQUEST_RATE_LIMIT = perHost({ max: 5, timeWindow: "1 minute" })

export const GUEST_RSVP_VERIFY_RATE_LIMIT = perHost({ max: 10, timeWindow: "1 minute" })

export const GUEST_RSVP_CANCEL_RATE_LIMIT = perHost({ max: 10, timeWindow: "1 minute" })

export const GUEST_LIST_RATE_LIMIT = perHost({ max: 30, timeWindow: "1 minute" })

export type { GuestRsvpOverrides }

declare module "fastify" {
  interface FastifyInstance {
    guestRsvpOverrides?: GuestRsvpOverrides
  }
}

const CleanupIdParamsSchema = z.object({ id: IdSchema }).strict()

export const GuestRsvpRequestBodySchema = trimTextFields(GuestRsvpRequestRequestSchema, "name")

export async function registerGuestRsvpRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  let cached: GuestRsvpService | undefined

  function service(): GuestRsvpService {
    return (cached ??= makeContainerGuestRsvpService(container, app.guestRsvpOverrides, app.log))
  }

  route(
    app,
    "guestRsvpRequest",
    { config: { rateLimit: GUEST_RSVP_REQUEST_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = parse(CleanupIdParamsSchema, request.params)
      const body = parse(GuestRsvpRequestBodySchema, { ...(request.body as object), id })
      const payload: GuestRsvpRequestResponse = await service().requestCode(body, ctxOf(request))
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "guestRsvpVerify",
    { config: { rateLimit: GUEST_RSVP_VERIFY_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = parse(CleanupIdParamsSchema, request.params)
      const body = parse(GuestRsvpVerifyRequestSchema, { ...(request.body as object), id })
      const payload: GuestRsvpVerifyResponse = await service().verifyCode(body, ctxOf(request))
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "guestRsvpCancel",
    { config: { rateLimit: GUEST_RSVP_CANCEL_RATE_LIMIT } },
    async (request, reply) => {
      const body = parse(GuestRsvpCancelRequestSchema, request.body)
      const payload: GuestRsvpCancelResponse = await service().cancelRsvp(body.token)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "getCleanupGuests",
    { config: { rateLimit: GUEST_LIST_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      const query = parse(GetCleanupGuestsRequestSchema, { ...(request.query as object), id })
      const payload: GetCleanupGuestsResponse = await service().listGuests(query, userId)
      reply.status(200).send(payload)
    },
  )
}

function ctxOf(request: FastifyRequest): GuestRequestContext {
  return { ip: request.ip || null }
}
