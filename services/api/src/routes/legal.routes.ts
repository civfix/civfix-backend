import type { GetLegalVersionsResponse } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import { perHost } from "../plugins/rate-limit.js"
import type { Container } from "../di.js"
import { route } from "../versioning/route.js"
import { LEGAL_VERSIONS_CACHE_SECONDS, legalDocumentVersions } from "../services/legal-service.js"

export const LEGAL_VERSIONS_RATE_LIMIT = perHost({ max: 120, timeWindow: "1 minute" })

export async function registerLegalRoutes(
  app: FastifyInstance,
  _container: Container,
): Promise<void> {
  route(
    app,
    "getLegalVersions",
    { config: { rateLimit: LEGAL_VERSIONS_RATE_LIMIT } },
    async (_request, reply) => {
      const payload: GetLegalVersionsResponse = {
        documents: legalDocumentVersions(),
        generatedAt: new Date().toISOString(),
      }
      reply
        .header("cache-control", `public, max-age=${LEGAL_VERSIONS_CACHE_SECONDS}`)
        .status(200)
        .send(payload)
    },
  )
}
