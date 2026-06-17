/**
 * Verification route plugin (document "verified neighbor").
 *
 *   GET  /me/verification                       [auth]        the viewer's own verification status.
 *   POST /me/verification                       [auth][csrf]  apply (upload ids + note) -> pending.
 *   GET  /me/verification/documents/:mediaId/url [auth]       owner-only signed URL for one of their docs.
 *
 * Bodies/params are validated against the @civfix/shared Zod schemas via the same `parse` ->
 * AppError.validation pattern as the other routes. The service is built per request from an injected
 * override (tests) or the container (production: the Drizzle verification repo + the storage presigner).
 * A dedicated per-IP rate limit bounds the apply surface (mirrors the claim routes).
 */

import {
  ApplyForVerificationRequestSchema,
  IdSchema,
  AppError,
  type ApplyForVerificationResponse,
  type GetMyVerificationResponse,
  type VerificationDocumentUrlResponse,
} from "@civfix/shared"
import { ZodError, z, type ZodTypeAny } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { csrfProtect } from "../auth/csrf.js"
import {
  makeVerificationService,
  type VerificationService,
} from "../services/verification-service.js"
import { makeDrizzleVerificationRepository } from "../services/verification-repository.drizzle.js"
import { MEDIA_GET_URL_TTL_SEC } from "../services/media-intake-service.js"
import { route } from "../versioning/route.js"

/** Optional injected verification-service override (tests) so the HTTP flow runs offline. */
export interface VerificationServiceOverride {
  service: VerificationService
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected verification-service override (tests). See VerificationServiceOverride. */
    verificationOverride?: VerificationServiceOverride
  }
}

/** Path param schema for the per-document signed-URL route. */
const MediaIdParamsSchema = z.object({ mediaId: IdSchema }).strict()

/**
 * Dedicated, tighter per-IP rate limit for the apply surface. Applying repeatedly is never needed for a
 * real client, so a small cap bounds abuse (each apply tags media + upserts a row); mirrors CLAIM_RATE_LIMIT.
 */
export const VERIFICATION_RATE_LIMIT = { max: 12, timeWindow: "1 minute" } as const

export async function registerVerificationRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the verification service from an injected override (tests) or the container (production). */
  function service(): VerificationService {
    const override = app.verificationOverride
    if (override) return override.service
    return makeVerificationService({
      repo: makeDrizzleVerificationRepository(container.getDb().sql),
      presignGet: (r2Key) => container.storage.presignGet(r2Key, MEDIA_GET_URL_TTL_SEC),
    })
  }

  // -------------------------------------------------------------------------
  // GET /me/verification  [auth]
  // -------------------------------------------------------------------------
  route(app, "myVerification", async (request, reply) => {
    const userId = requireAuth(request)
    const verification = await service().getMine(userId)
    const payload: GetMyVerificationResponse = { verification }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /me/verification  [auth][csrf]  (dedicated tighter per-IP limit)
  // -------------------------------------------------------------------------
  route(
    app,
    "applyForVerification",
    { preHandler: csrfProtect, config: { rateLimit: VERIFICATION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(ApplyForVerificationRequestSchema, request.body)
      const verification = await service().apply(userId, body.uploadIds, body.note ?? null)
      const payload: ApplyForVerificationResponse = { verification }
      reply.status(200).send(payload)
    },
  )

  // -------------------------------------------------------------------------
  // GET /me/verification/documents/:mediaId/url  [auth]
  // -------------------------------------------------------------------------
  route(app, "myVerificationDocumentUrl", async (request, reply) => {
    const userId = requireAuth(request)
    const { mediaId } = parse(MediaIdParamsSchema, request.params)
    const url = await service().documentUrl(userId, mediaId)
    if (url === null) throw AppError.notFound("Document not found")
    const payload: VerificationDocumentUrlResponse = {
      url,
      expiresAt: new Date(Date.now() + MEDIA_GET_URL_TTL_SEC * 1000).toISOString(),
    }
    reply.status(200).send(payload)
  })
}

/** Validate `data` against a Zod schema, throwing AppError.validation (422) on failure (mirrors others). */
function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  try {
    return schema.parse(data)
  } catch (err) {
    if (err instanceof ZodError) {
      const fields: Record<string, string> = {}
      for (const issue of err.issues) {
        const key = issue.path.length > 0 ? issue.path.join(".") : "_"
        fields[key] = issue.message
      }
      throw AppError.validation(fields)
    }
    throw err
  }
}
