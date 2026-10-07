import {
  CheckEventPageSlugRequestSchema,
  GetEventPageRequestSchema,
  GetPublicEventPageRequestSchema,
  PublishEventPageRequestSchema,
  SaveEventPageRequestSchema,
  type CheckEventPageSlugResponse,
  type GetEventPageResponse,
  type GetPublicEventPageResponse,
  type PublishEventPageResponse,
  type SaveEventPageResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireAuth, resolveAuthContext } from "../../auth/context.js"
import { route } from "../../versioning/route.js"
import { parse } from "../_validate.js"
import {
  CleanupIdParamsSchema,
  PAGE_READ_RATE_LIMIT,
  PAGE_WRITE_RATE_LIMIT,
  PUBLIC_PAGE_RATE_LIMIT,
  PageSlugParamsSchema,
  bodyWith,
  queryWith,
  type HostRouteContext,
} from "./_host-routes.js"

export function registerHostPageRoutes(
  app: FastifyInstance,
  container: Container,
  ctx: HostRouteContext,
): void {
  const csrfProtect = container.csrf.protect

  route(
    app,
    "getPublicEventPage",
    { config: { rateLimit: PUBLIC_PAGE_RATE_LIMIT } },
    async (request, reply) => {
      const { slug } = parse(PageSlugParamsSchema, request.params)
      const query = parse(GetPublicEventPageRequestSchema, { slug })
      const auth = await resolveAuthContext(request)
      const payload: GetPublicEventPageResponse = await ctx
        .pages()
        .getPublicEventPage(query, auth.userId ?? null)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "getEventPage",
    { config: { rateLimit: PAGE_READ_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      await ctx.pageGuards().requireCapability(id, userId, "manage_page")
      const query = parse(GetEventPageRequestSchema, { id })
      const payload: GetEventPageResponse = await ctx.pages().get(query)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "saveEventPage",
    { preHandler: csrfProtect, config: { rateLimit: PAGE_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      await ctx.pageGuards().requireCapability(id, userId, "manage_page")
      const body = parse(SaveEventPageRequestSchema, bodyWith(request, { id }))
      const payload: SaveEventPageResponse = await ctx.pages().save(body, userId)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "publishEventPage",
    { preHandler: csrfProtect, config: { rateLimit: PAGE_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      await ctx.pageGuards().requireCapability(id, userId, "manage_page")
      const body = parse(PublishEventPageRequestSchema, bodyWith(request, { id }))
      const payload: PublishEventPageResponse = await ctx.pages().publish(body, userId)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "checkEventPageSlug",
    { config: { rateLimit: PAGE_READ_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      await ctx.pageGuards().requireCapability(id, userId, "manage_page")
      const query = parse(CheckEventPageSlugRequestSchema, queryWith(request, { id }))
      const payload: CheckEventPageSlugResponse = await ctx.pages().checkSlug(query)
      reply.status(200).send(payload)
    },
  )
}
