import {
  GetLegalDocumentRequestSchema,
  type GetLegalDocumentResponse,
  type GetLegalDocumentsResponse,
} from "@civfix/contract"
import type { FastifyInstance, FastifyReply } from "fastify"
import { perHost } from "../plugins/rate-limit.js"
import type { Container } from "../di.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"
import type { LegalDocumentsRepository } from "../services/legal-documents-repository.js"
import { makeLegalDocumentsRepository } from "../services/legal-documents-repository.drizzle.js"
import {
  LEGAL_VERSIONS_CACHE_SECONDS,
  makeLegalService,
  type LegalService,
} from "../services/legal-service.js"

export const LEGAL_VERSIONS_RATE_LIMIT = perHost({ max: 120, timeWindow: "1 minute" })

export interface LegalRouteOverrides {
  repo: LegalDocumentsRepository
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    legalOverrides?: LegalRouteOverrides
  }
}

export function legalServiceFor(app: FastifyInstance, container: Container): LegalService {
  const overrides = app.legalOverrides
  return makeLegalService({
    repo: overrides?.repo ?? makeLegalDocumentsRepository(container.getDb().sql),
    now: overrides?.now ?? (() => new Date()),
  })
}

function sendPublic(reply: FastifyReply, payload: unknown): void {
  reply
    .header("cache-control", `public, max-age=${LEGAL_VERSIONS_CACHE_SECONDS}`)
    .status(200)
    .send(payload)
}

export async function registerLegalRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const legal = (): LegalService => legalServiceFor(app, container)
  const config = { rateLimit: LEGAL_VERSIONS_RATE_LIMIT }

  route(app, "getLegalVersions", { config }, async (_request, reply) => {
    sendPublic(reply, await legal().currentVersions())
  })

  route(app, "getLegalDocuments", { config }, async (_request, reply) => {
    const payload: GetLegalDocumentsResponse = { documents: await legal().currentDocuments() }
    sendPublic(reply, payload)
  })

  route(app, "getLegalDocument", { config }, async (request, reply) => {
    // Set before anything can throw: an error (an unknown or malformed version) must not be cached.
    reply.header("cache-control", "no-store")
    const { type, version } = parse(GetLegalDocumentRequestSchema, request.params)
    const payload: GetLegalDocumentResponse = { document: await legal().document(type, version) }
    sendPublic(reply, payload)
  })
}
