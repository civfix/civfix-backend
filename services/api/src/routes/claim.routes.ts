import {
  ClaimNudgeRequestSchema,
  ClaimReportRequestSchema,
  AppError,
  type ClaimNudgeResponse,
  type ClaimReportResponse,
} from "@civfix/shared"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { perHost } from "../plugins/rate-limit.js"
import type { Container } from "../di.js"
import { isProd } from "../env.js"
import { requireAuth } from "../auth/context.js"
import { ANON_COOKIE } from "../auth/transport.js"
import { makeClaimService, type ClaimService } from "../services/claim-service.js"
import { makeDrizzleClaimRepository } from "../services/anon-repository.drizzle.js"
import { makeDrizzleReportRepository } from "../services/report-repository.drizzle.js"
import { makeReportService, type ReportService } from "../services/report-service.js"
import { makeMediaPresigner, makePrivateMediaPresigner } from "../services/media-presign.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"

const ANON_HOLD_RELEASE_JOB = "anon.hold.release"

export interface ClaimServiceOverride {
  service: ClaimService
}

declare module "fastify" {
  interface FastifyInstance {
    claimOverride?: ClaimServiceOverride
  }
}

export const CLAIM_RATE_LIMIT = perHost({ max: 20, timeWindow: "1 minute" })

// A bodiless credentialed POST is a CORS simple request, so any same-site page could make the
// browser attach the Lax anon cookie and rotate the visitor's on-screen claim code. csrfProtect
// cannot help because anonymous reporters have no session cookie. Browsers always send Origin on a
// cross-origin POST, so an absent Origin is a non-browser caller that could send the token in the
// body anyway; only a present origin outside the web allowlist (including "null") is refused.
function isCookieNudgeOriginAllowed(
  request: FastifyRequest,
  webOrigins: readonly string[],
): boolean {
  const origin = request.headers.origin
  if (origin === undefined) return true
  if (webOrigins.length === 0) return !isProd()
  return webOrigins.includes(origin)
}

export async function registerClaimRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  let reportServiceMemo: ReportService | undefined
  function reportService(): ReportService {
    if (reportServiceMemo === undefined) {
      reportServiceMemo = makeReportService({
        repo: makeDrizzleReportRepository(container.getDb().sql),
        resolveJurisdictionGeoid: () => Promise.resolve(null),
        presignMedia: makeMediaPresigner(container.storage),
        presignPrivateMedia: makePrivateMediaPresigner(container.storage),
      })
    }
    return reportServiceMemo
  }

  function service(): ClaimService {
    const override = app.claimOverride
    if (override) return override.service

    return makeClaimService({
      repo: makeDrizzleClaimRepository(container.getDb().sql),
      anonTokenSigningKey: container.env.ANON_TOKEN_SIGNING_KEY,
      getReportForOwner: (reportId, owner) => reportService().getReport(reportId, owner),
      enqueueHoldRelease: async (reportId) => {
        await container.jobs.enqueue(
          ANON_HOLD_RELEASE_JOB,
          { reportId },
          { singletonKey: reportId },
        )
      },
      logger: app.log,
    })
  }

  route(app, "claimNudge", { config: { rateLimit: CLAIM_RATE_LIMIT } }, async (request, reply) => {
    const body = parse(ClaimNudgeRequestSchema, request.body ?? {})
    const anonToken = body.anonToken ?? request.cookies[ANON_COOKIE]
    if (!anonToken) {
      throw AppError.notFound("No pending report for this session")
    }
    if (
      body.anonToken === undefined &&
      !isCookieNudgeOriginAllowed(request, container.env.WEB_ORIGINS)
    ) {
      throw AppError.forbidden("Origin not allowed.")
    }
    const payload: ClaimNudgeResponse = await service().claimNudge(anonToken)
    reply.status(200).send(payload)
  })

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
