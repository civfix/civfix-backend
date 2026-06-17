/**
 * Admin verification routes (document "verified neighbor" review).
 *
 *   GET  /admin/verifications                              the review queue (AdminVerificationListResponse).
 *   GET  /admin/verifications/:userId                      one request's detail (GetAdminVerificationResponse).
 *   GET  /admin/verifications/:userId/documents/:mediaId/url  signed URL for one uploaded document.
 *   POST /admin/verifications/:userId/approve              set the user verified (ApproveVerificationRequest). [csrf]
 *   POST /admin/verifications/:userId/reject               reject with a reason (RejectVerificationRequest). [csrf]
 *
 * Mirrors the gov-claims router: runs inside the requireOperator scope (applied by routes/admin/index.ts);
 * mutations additionally carry csrfProtect. The acting operator's userId comes from request.auth.userId and
 * is audited inside the repo transaction. The service is built lazily from the container (Drizzle repo +
 * the storage presigner). Approval changes NO role.
 */

import {
  AppError,
  IdSchema,
  AdminVerificationListQuerySchema,
  ApproveVerificationRequestSchema,
  RejectVerificationRequestSchema,
  type AdminOkResponse,
  type AdminVerificationListResponse,
  type GetAdminVerificationResponse,
  type VerificationDocumentUrlResponse,
} from "@civfix/shared"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../../di.js"
import { csrfProtect } from "../../auth/csrf.js"
import { route } from "../../versioning/route.js"
import { parse } from "./_route-utils.js"
import {
  makeAdminVerificationService,
  type AdminVerificationService,
} from "../../services/admin/verification-service.js"
import { makeDrizzleAdminVerificationRepository } from "../../services/admin/verification-repository.drizzle.js"
import { MEDIA_GET_URL_TTL_SEC } from "../../services/media-intake-service.js"

/** Optional injected admin-verification-service override (tests). */
export interface AdminVerificationRouteOverride {
  service: AdminVerificationService
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected admin-verification-route override (tests). */
    adminVerificationOverride?: AdminVerificationRouteOverride
  }
}

/** Read + validate a UUID path param by name (the admin queue is keyed by :userId, not :id). */
function uuidParam(request: FastifyRequest, name: string): string {
  const params = request.params as Record<string, unknown>
  const raw = typeof params[name] === "string" ? (params[name] as string) : ""
  const parsed = IdSchema.safeParse(raw)
  if (!parsed.success) {
    throw AppError.validation({ [name]: raw === "" ? "required" : "must be a valid id" })
  }
  return parsed.data
}

export async function registerAdminVerificationRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the admin verification service from an override (tests) or the container (production). */
  function service(): AdminVerificationService {
    const override = app.adminVerificationOverride
    if (override) return override.service
    return makeAdminVerificationService({
      repo: makeDrizzleAdminVerificationRepository(container.getDb().sql),
      presignGet: (r2Key) => container.storage.presignGet(r2Key, MEDIA_GET_URL_TTL_SEC),
    })
  }

  // -------------------------------------------------------------------------
  // GET /admin/verifications
  // -------------------------------------------------------------------------
  route(app, "listAdminVerifications", async (request, reply) => {
    const query = parse(AdminVerificationListQuerySchema, request.query)
    const payload: AdminVerificationListResponse = await service().list(query)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /admin/verifications/:userId
  // -------------------------------------------------------------------------
  route(app, "getAdminVerification", async (request, reply) => {
    const userId = uuidParam(request, "userId")
    const payload: GetAdminVerificationResponse = await service().get(userId)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /admin/verifications/:userId/documents/:mediaId/url
  // -------------------------------------------------------------------------
  route(app, "adminVerificationDocumentUrl", async (request, reply) => {
    const userId = uuidParam(request, "userId")
    const mediaId = uuidParam(request, "mediaId")
    const url = await service().documentUrl(userId, mediaId)
    if (url === null) throw AppError.notFound("Document not found")
    const payload: VerificationDocumentUrlResponse = {
      url,
      expiresAt: new Date(Date.now() + MEDIA_GET_URL_TTL_SEC * 1000).toISOString(),
    }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/verifications/:userId/approve  [csrf]
  // -------------------------------------------------------------------------
  route(app, "approveVerification", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = uuidParam(request, "userId")
    const body = parse(ApproveVerificationRequestSchema, { ...(request.body as object), userId })
    await service().approve(userId, { actorId: request.auth.userId, note: body.note ?? null })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/verifications/:userId/reject  [csrf]
  // -------------------------------------------------------------------------
  route(app, "rejectVerification", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = uuidParam(request, "userId")
    const body = parse(RejectVerificationRequestSchema, { ...(request.body as object), userId })
    await service().reject(userId, { actorId: request.auth.userId, reason: body.reason })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })
}
