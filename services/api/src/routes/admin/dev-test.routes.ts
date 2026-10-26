import {
  AdminDevResetFirstRunRequestSchema,
  AdminDevSetForceUpdateRequestSchema,
  AdminDevTestEmailRequestSchema,
  AdminDevTestPushRequestSchema,
  AppError,
} from "@civfix/contract"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../../di.js"
import { route } from "../../versioning/route.js"
import { parse } from "../_validate.js"
import { requireOperator } from "../../auth/admin-guard.js"
import { perIdentity } from "../../plugins/rate-limit.js"

export const ADMIN_DEV_TEST_RATE_LIMIT = perIdentity({
  max: 10,
  timeWindow: "1 minute",
  skipOnError: false,
})

/** The staging test tools: each answers NOT_FOUND, before reading its body, whenever dev tools are off. */
export async function registerDevTestRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect
  const limited = { config: { rateLimit: ADMIN_DEV_TEST_RATE_LIMIT } }
  const mutation = { ...limited, preHandler: csrfProtect }

  function servedOperator(request: FastifyRequest): string {
    const actorId = requireOperator(request)
    if (!container.env.devToolsEnabled) throw AppError.notFound()
    return actorId
  }

  route(app, "adminDevListForceUpdate", limited, async (request, reply) => {
    servedOperator(request)
    reply.status(200).send(await container.getDevTestTools().listForceUpdate())
  })

  route(app, "adminDevSetForceUpdate", mutation, async (request, reply) => {
    const actorId = servedOperator(request)
    const body = parse(AdminDevSetForceUpdateRequestSchema, request.body)
    reply
      .status(200)
      .send(await container.getDevTestTools().setForceUpdate(actorId, body.email, body.enabled))
  })

  route(app, "adminDevTestPush", mutation, async (request, reply) => {
    const actorId = servedOperator(request)
    const body = parse(AdminDevTestPushRequestSchema, request.body)
    reply.status(200).send(await container.getDevTestTools().sendTestPush(actorId, body))
  })

  route(app, "adminDevTestEmail", mutation, async (request, reply) => {
    const actorId = servedOperator(request)
    parse(AdminDevTestEmailRequestSchema, request.body)
    reply.status(200).send(await container.getDevTestTools().sendTestEmail(actorId))
  })

  route(app, "adminDevResetFirstRun", mutation, async (request, reply) => {
    const actorId = servedOperator(request)
    const body = parse(AdminDevResetFirstRunRequestSchema, request.body)
    reply.status(200).send(await container.getDevTestTools().resetFirstRun(actorId, body.email))
  })
}
