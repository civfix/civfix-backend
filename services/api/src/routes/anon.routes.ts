import {
  AnonReportRequestSchema,
  AnonReportResponseSchema,
  AnonReportStatusRequestSchema,
  IdSchema,
  ReportStatusSchema,
  type AnonReportResponse,
  type AnonReportStatusResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Container } from "../di.js"
import { ANON_COOKIE } from "../auth/transport.js"
import { isProd } from "../env.js"
import { ANON_TOKEN_TTL_SECONDS } from "../abuse/anon-token.js"
import { cfGeoFromTrustedEdge } from "../abuse/gps-sanity.js"
import { makeAnonService, type AnonService } from "../services/anon-service.js"
import { makeDrizzleAnonReportRepository } from "../services/anon-repository.drizzle.js"
import { makeCachedAddressResolver, makeGeoidResolver } from "../services/route-geo-helpers.js"
import { resolveJurisdictionCode } from "../db/reference-code.js"
import { route } from "../versioning/route.js"
import { parse, trimTextFields } from "./_validate.js"

const ANON_TOKEN_HEADER = "x-anon-token"

export interface AnonServiceOverride {
  service: AnonService
}

declare module "fastify" {
  interface FastifyInstance {
    anonOverride?: AnonServiceOverride
  }
}

const AnonReportIdParamsSchema = z.object({ id: IdSchema }).strict()

export const AnonReportBodySchema = trimTextFields(
  AnonReportRequestSchema,
  "title",
  "description",
  "addr",
)

export const ANON_CREATE_RATE_LIMIT = { max: 15, timeWindow: "1 minute" } as const
const ANON_STATUS_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const

const AnonReportResponseJsonSchema = {
  type: "object",
  properties: {
    reportId: { type: "string" },
    status: { type: "string", enum: [...AnonReportResponseSchema.shape.status.options] },
    claimCode: { type: "string" },
  },
  required: ["reportId", "status", "claimCode"],
} as const

const AnonReportStatusResponseJsonSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: [...ReportStatusSchema.options] },
    publishedAt: { type: "string", nullable: true },
  },
  required: ["status"],
} as const

export async function registerAnonRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  function service(): AnonService {
    const override = app.anonOverride
    if (override) return override.service

    const sql = container.getDb().sql
    const repo = makeDrizzleAnonReportRepository(sql)
    return makeAnonService({
      repo,
      abuseChecks: container.abuseChecks,
      counters: container.getCounterStore(),
      anonTokenSigningKey: container.env.ANON_TOKEN_SIGNING_KEY,
      resolveJurisdictionGeoid: makeGeoidResolver(container),
      resolveJurisdictionCode: (geoid) => resolveJurisdictionCode(sql, geoid),
      resolveAddress: makeCachedAddressResolver(container),
      raiseAbuseFlag: (subjectType, subjectId, reason) =>
        repo.raiseAbuseFlag(subjectType, subjectId, reason),
      log: (line, extra) => app.log.info(extra ?? {}, line),
    })
  }

  route(
    app,
    "anonCreateReport",
    {
      config: { rateLimit: ANON_CREATE_RATE_LIMIT },
      schema: { response: { 202: AnonReportResponseJsonSchema } },
    },
    async (request, reply) => {
      const body = parse(AnonReportBodySchema, request.body)

      const presentedAnonToken = body.anonToken ?? cookieAnonToken(request)
      const effectiveBody =
        presentedAnonToken !== undefined ? { ...body, anonToken: presentedAnonToken } : body

      const result = await service().submitAnonReport(effectiveBody, {
        ip: request.ip || null,
        cfGeo: request.headers,
        cfGeoTrusted: cfGeoFromTrustedEdge(request),
        ...(request.headers["user-agent"] !== undefined
          ? { userAgent: String(request.headers["user-agent"]) }
          : {}),
      })

      if (result.issuedAnonToken !== undefined) {
        setAnonCookie(reply, result.issuedAnonToken)
        reply.header(ANON_TOKEN_HEADER, result.issuedAnonToken)
      }

      const payload: AnonReportResponse = result.response
      reply.status(202).send(payload)
    },
  )

  route(
    app,
    "anonReportStatus",
    {
      config: { rateLimit: ANON_STATUS_RATE_LIMIT },
      schema: { response: { 200: AnonReportStatusResponseJsonSchema } },
    },
    async (request, reply) => {
      const { id } = parse(AnonReportIdParamsSchema, request.params)
      const { claimCode } = parse(AnonReportStatusRequestSchema, {
        reportId: id,
        claimCode: queryClaimCode(request),
      })

      const payload: AnonReportStatusResponse = await service().anonReportStatus(id, claimCode)
      reply.status(200).send(payload)
    },
  )
}

function queryClaimCode(request: FastifyRequest): unknown {
  return (request.query as Record<string, unknown> | undefined)?.claimCode
}

function cookieAnonToken(request: FastifyRequest): string | undefined {
  const value = request.cookies[ANON_COOKIE]
  return value && value.length > 0 ? value : undefined
}

function setAnonCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(ANON_COOKIE, token, {
    httpOnly: false,
    sameSite: "lax",
    secure: isProd(),
    path: "/",
    maxAge: ANON_TOKEN_TTL_SECONDS,
  })
}
