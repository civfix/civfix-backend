/**
 * Account-claim route plugin.
 *
 *   GET  /claim/nudge   [anon-ok]      the post-submit prompt: given the caller's anon token (the
 *                                      `civfix_anon` cookie, or an `anonToken` query param for mobile),
 *                                      return {claimCode, reportId} for the pending anon report so the
 *                                      client can offer "sign in to keep your report".
 *   POST /claim/report  [auth][csrf]   claim a report into the signed-in account by its claim code.
 *
 * The nudge is anon-ok (a logged-out user is exactly who needs it); the claim itself requires a real
 * session (the account to attach to) and CSRF on the cookie flow. The service is built per request from
 * an injected override (tests) or the container (production: the Drizzle claim repo + report service for
 * the DTO projection).
 */

import {
  ClaimReportRequestSchema,
  AppError,
  type ClaimNudgeResponse,
  type ClaimReportResponse,
} from "@civfix/shared"
import { ZodError, z, type ZodTypeAny } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { csrfProtect } from "../auth/csrf.js"
import { ANON_COOKIE } from "../auth/transport.js"
import { makeClaimService, type ClaimService } from "../services/claim-service.js"
import { makeDrizzleClaimRepository } from "../services/anon-repository.drizzle.js"
import { makeDrizzleReportRepository } from "../services/report-repository.drizzle.js"
import { makeReportService } from "../services/report-service.js"
import { MEDIA_GET_URL_TTL_SEC } from "../services/media-intake-service.js"

/**
 * Optional injected claim-service (tests). When present the routes use it directly so the nudge/claim
 * HTTP flow runs offline. Left unset in production.
 */
export interface ClaimServiceOverride {
  service: ClaimService
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected claim-service override (tests). See ClaimServiceOverride. */
    claimOverride?: ClaimServiceOverride
  }
}

/** Query schema for GET /claim/nudge: an optional anonToken (mobile sends it when it has no cookie). */
const ClaimNudgeQuerySchema = z.object({ anonToken: z.string().optional() }).strict()

export async function registerClaimRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the claim service from an injected override (tests) or the container seams (production). */
  function service(): ClaimService {
    const override = app.claimOverride
    if (override) return override.service

    const sql = container.getDb().sql
    const reportService = makeReportService({
      repo: makeDrizzleReportRepository(sql),
      resolveJurisdictionGeoid: () => Promise.resolve(null),
      presignMedia: async (r2Key, thumbKey) => {
        const url = await container.storage.presignGet(r2Key, MEDIA_GET_URL_TTL_SEC)
        if (thumbKey === null) return { url }
        const thumbUrl = await container.storage.presignGet(thumbKey, MEDIA_GET_URL_TTL_SEC)
        return { url, thumbUrl }
      },
    })
    return makeClaimService({
      repo: makeDrizzleClaimRepository(sql),
      anonTokenSigningKey: container.env.ANON_TOKEN_SIGNING_KEY,
      getReportForOwner: (reportId, owner) => reportService.getReport(reportId, owner),
    })
  }

  // -------------------------------------------------------------------------
  // GET /claim/nudge  [anon-ok]
  // -------------------------------------------------------------------------
  app.get("/claim/nudge", async (request, reply) => {
    const q = parse(ClaimNudgeQuerySchema, request.query)
    // Prefer the query param (mobile) and fall back to the readable anon cookie (web).
    const anonToken = q.anonToken ?? request.cookies[ANON_COOKIE]
    if (!anonToken) {
      // No anon identity at all -> nothing to nudge. 404 keeps it indistinguishable from "no pending".
      throw AppError.notFound("No pending report for this session")
    }
    const payload: ClaimNudgeResponse = await service().claimNudge(anonToken)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /claim/report  [auth][csrf]
  // -------------------------------------------------------------------------
  app.post("/claim/report", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const body = parse(ClaimReportRequestSchema, request.body)
    const payload: ClaimReportResponse = await service().claimReport(body.claimCode, userId)
    reply.status(200).send(payload)
  })
}

/**
 * Validate `data` against a Zod schema, throwing AppError.validation (422 with field details) on
 * failure so the canonical envelope is returned. Mirrors the other route plugins.
 */
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
