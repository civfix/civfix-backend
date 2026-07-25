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
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { ANON_COOKIE } from "../auth/transport.js"
import { makeClaimService, type ClaimService } from "../services/claim-service.js"
import { makeDrizzleClaimRepository } from "../services/anon-repository.drizzle.js"
import { makeDrizzleReportRepository } from "../services/report-repository.drizzle.js"
import { makeReportService, type ReportService } from "../services/report-service.js"
import { makeMediaPresigner } from "../services/media-presign.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"

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

/**
 * Dedicated, tighter per-IP rate limit for the claim-code endpoints (P2-7). The claim code is a 256-bit
 * unguessable secret so these are not brute-forcible, but the global 300/min limiter is broad; a small
 * dedicated cap on the public claim/nudge surface is cheap defense-in-depth (and keeps the per-IP key
 * meaningful now that request.ip is the real client). 20 requests / minute / IP is ample for a real
 * client (one nudge poll + one claim) while bounding automated probing.
 */
const CLAIM_RATE_LIMIT = { max: 20, timeWindow: "1 minute" } as const

export async function registerClaimRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  // The report service is only needed to project the claimed ReportDTO and depends only on the stable
  // container seams (sql + storage), so build it ONCE on first use instead of per request (the prior code
  // rebuilt the whole report repo + presign closure on every nudge/claim). Tests bypass it via claimOverride.
  let reportServiceMemo: ReportService | undefined
  function reportService(): ReportService {
    if (reportServiceMemo === undefined) {
      reportServiceMemo = makeReportService({
        repo: makeDrizzleReportRepository(container.getDb().sql),
        resolveJurisdictionGeoid: () => Promise.resolve(null),
        presignMedia: makeMediaPresigner(container.storage),
      })
    }
    return reportServiceMemo
  }

  /** Build the claim service from an injected override (tests) or the container seams (production). */
  function service(): ClaimService {
    const override = app.claimOverride
    if (override) return override.service

    return makeClaimService({
      repo: makeDrizzleClaimRepository(container.getDb().sql),
      anonTokenSigningKey: container.env.ANON_TOKEN_SIGNING_KEY,
      getReportForOwner: (reportId, owner) => reportService().getReport(reportId, owner),
    })
  }

  // GET /claim/nudge  [anon-ok]  (dedicated tighter per-IP limit)
  route(app, "claimNudge", { config: { rateLimit: CLAIM_RATE_LIMIT } }, async (request, reply) => {
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

  // POST /claim/report  [auth][csrf]  (dedicated tighter per-IP limit)
  route(
    app,
    "claimReport",
    { preHandler: csrfProtect, config: { rateLimit: CLAIM_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(ClaimReportRequestSchema, request.body)
      const payload: ClaimReportResponse = await service().claimReport(body.claimCode, userId)
      reply.status(200).send(payload)
    },
  )
}
