import type { GetLegalVersionsResponse } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { route } from "../../versioning/route.js"
import { legalDocumentVersions } from "../../services/legal-service.js"

export async function registerAdminLegalRoutes(
  app: FastifyInstance,
  _container: Container,
): Promise<void> {
  route(app, "adminGetLegalVersions", async (_request, reply) => {
    const payload: GetLegalVersionsResponse = {
      documents: legalDocumentVersions(),
      generatedAt: new Date().toISOString(),
    }
    reply.status(200).send(payload)
  })
}
