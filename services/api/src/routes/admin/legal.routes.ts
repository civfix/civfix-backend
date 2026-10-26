import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { route } from "../../versioning/route.js"
import { legalServiceFor } from "../legal.routes.js"

export async function registerAdminLegalRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  route(app, "adminGetLegalVersions", async (_request, reply) => {
    reply.status(200).send(await legalServiceFor(app, container).allVersions())
  })
}
