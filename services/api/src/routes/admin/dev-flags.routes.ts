import {
  AdminSetRuntimeFlagRequestSchema,
  AppError,
  type AdminListRuntimeFlagsResponse,
  type RuntimeFlagStateDTO,
} from "@civfix/contract"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { route } from "../../versioning/route.js"
import { parse, paramsOverBody } from "../_validate.js"
import { requireOperator } from "../../auth/admin-guard.js"
import { perIdentity } from "../../plugins/rate-limit.js"
import { isRuntimeFlagKey } from "../../services/admin/runtime-flag-service.js"

const ADMIN_RUNTIME_FLAG_RATE_LIMIT = perIdentity({
  max: 20,
  timeWindow: "1 minute",
  skipOnError: false,
})

export async function registerDevFlagRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  route(app, "adminListRuntimeFlags", async (_request, reply) => {
    const payload: AdminListRuntimeFlagsResponse = {
      flags: await container.getRuntimeFlags().list(),
    }
    reply.status(200).send(payload)
  })

  route(
    app,
    "adminSetRuntimeFlag",
    { preHandler: csrfProtect, config: { rateLimit: ADMIN_RUNTIME_FLAG_RATE_LIMIT } },
    async (request, reply) => {
      const actorId = requireOperator(request)
      const { key } = request.params as { key: string }
      if (!isRuntimeFlagKey(key)) throw AppError.notFound()
      const body = parse(AdminSetRuntimeFlagRequestSchema, paramsOverBody(request))
      const payload: RuntimeFlagStateDTO = await container
        .getRuntimeFlags()
        .set(key, body.value, actorId)
      reply.status(200).send(payload)
    },
  )
}
