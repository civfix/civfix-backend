import {
  ListEventQuestionsRequestSchema,
  SaveEventQuestionsRequestSchema,
  type ListEventQuestionsResponse,
  type SaveEventQuestionsResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireAuth, resolveAuthContext } from "../../auth/context.js"
import { route } from "../../versioning/route.js"
import { parse } from "../_validate.js"
import {
  CleanupIdParamsSchema,
  QUESTION_WRITE_RATE_LIMIT,
  TICKET_TYPE_READ_RATE_LIMIT,
  bodyWith,
  queryWith,
  type HostRouteContext,
} from "./_host-routes.js"

export function registerHostQuestionRoutes(
  app: FastifyInstance,
  container: Container,
  ctx: HostRouteContext,
): void {
  const csrfProtect = container.csrf.protect

  route(
    app,
    "listEventQuestions",
    { config: { rateLimit: TICKET_TYPE_READ_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = parse(CleanupIdParamsSchema, request.params)
      const auth = await resolveAuthContext(request)
      await ctx.guards().requireVisible(id, auth.userId ?? null)
      const query = parse(ListEventQuestionsRequestSchema, queryWith(request, { id }))
      const payload: ListEventQuestionsResponse = await ctx.services().questions.list(query)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "saveEventQuestions",
    { preHandler: csrfProtect, config: { rateLimit: QUESTION_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(CleanupIdParamsSchema, request.params)
      await ctx.guards().requireCapability(id, userId, "manage_tickets")
      const body = parse(SaveEventQuestionsRequestSchema, bodyWith(request, { id }))
      const payload: SaveEventQuestionsResponse = await ctx.services().questions.save(body)
      reply.status(200).send(payload)
    },
  )
}
