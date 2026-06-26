/**
 * Anonymous reporting route plugin.
 *
 *   POST /anon/reports             [public]                 submit an anonymous report. Runs the FULL
 *                                                           abuse stack (Turnstile, honeypot, anon-token
 *                                                           cap, per-IP cap, per-H3-cell cap, GPS
 *                                                           sanity, idempotency) and creates the report
 *                                                           HELD. Returns AnonReportResponse.
 *   GET  /anon/reports/:id/status  [public, claimCode-gated] the report's status, gated by the matching
 *                                                           claim code (a wrong code 404s).
 *
 * TRANSPORT of the issued anon token: when a submit MINTS a fresh anon token (no valid one was
 * presented), the route hands it back two ways so either client can persist it:
 *   - web : a readable (non-httpOnly) `civfix_anon` cookie, so the SPA can echo it as anonToken next
 *           time (and the auth context already reads this cookie).
 *   - all : the `X-Anon-Token` response header, which the mobile client stores and sends back as
 *           the `anonToken` field on the next submit.
 * On an idempotent replay (or when an existing token was reused) no new token is issued, so neither is
 * set. The cookie is NOT httpOnly because the client must read it to round-trip; it is SameSite=Lax +
 * Secure-in-prod like the CSRF cookie. The anon token carries NO authority by itself (the server loads
 * + caps the row), so a readable cookie is acceptable.
 *
 * The service is built per request from either an injected override (tests: in-memory repo + fakes, so
 * the whole abuse + held-create flow runs offline) or from the container (production: the Drizzle anon
 * repo + the real AbuseChecks + a Redis CounterStore + the real jurisdiction service).
 */

import {
  AnonReportRequestSchema,
  AnonReportStatusRequestSchema,
  IdSchema,
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
import { RedisCounterStore } from "../abuse/counter-store.js"
import { makeAnonService, type AnonService } from "../services/anon-service.js"
import { makeDrizzleAnonReportRepository } from "../services/anon-repository.drizzle.js"
import { makeJurisdictionService } from "../services/jurisdiction-service.js"
import { resolveJurisdictionCode } from "../db/reference-code.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"

/** Response header carrying a freshly-issued anon token (mobile reads + re-sends it as anonToken). */
export const ANON_TOKEN_HEADER = "x-anon-token"

/**
 * Optional injected anon-service (tests). When present the routes use it directly so the full HTTP
 * submit/status flow runs offline. Left unset in production, where the routes build the Drizzle-backed
 * service lazily.
 */
export interface AnonServiceOverride {
  service: AnonService
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected anon-service override (tests). See AnonServiceOverride. */
    anonOverride?: AnonServiceOverride
  }
}

/** Path param schema for the status route. */
const AnonReportIdParamsSchema = z.object({ id: IdSchema }).strict()

/** Per-route caps for the abuse-heavy anon surface (each attempt drives DB/Redis writes). */
const ANON_CREATE_RATE_LIMIT = { max: 15, timeWindow: "1 minute" } as const
const ANON_STATUS_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const

// fast-json-stringify response schemas (the 202/200 bodies serialize on the fast path; an undeclared
// property is dropped, so the optional publishedAt MUST be listed to reach the wire).
const AnonReportResponseJsonSchema = {
  type: "object",
  properties: {
    reportId: { type: "string" },
    status: { type: "string", enum: ["held", "published"] },
    claimCode: { type: "string" },
  },
  required: ["reportId", "status", "claimCode"],
} as const

const AnonReportStatusResponseJsonSchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["submitted", "held", "published", "acknowledged", "in_progress", "resolved", "rejected"],
    },
    publishedAt: { type: "string", nullable: true },
  },
  required: ["status"],
} as const

export async function registerAnonRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the anon service from an injected override (tests) or the container seams (production). */
  function service(): AnonService {
    const override = app.anonOverride
    if (override) return override.service

    const sql = container.getDb().sql
    return makeAnonService({
      repo: makeDrizzleAnonReportRepository(sql),
      abuseChecks: container.abuseChecks,
      counters: new RedisCounterStore(container.getRedis()),
      anonTokenSigningKey: container.env.ANON_TOKEN_SIGNING_KEY,
      resolveJurisdictionGeoid: async (lat, lng) => {
        const jurisdiction = makeJurisdictionService({
          sql,
          geocoder: container.geocoder,
          jobs: container.jobs,
          // Write-time Census fallback: the anon path also self-maps on a local miss instead of "Unmapped"
          // (fake/no-op outside production).
          jurisdictionLookup: container.jurisdictionLookup,
        })
        const resolved = await jurisdiction.resolveForPoint(lat, lng)
        return resolved?.geoid ?? null
      },
      // Resolve the geoid's compact jurisdictions.code (reference-code JURCODE segment, #56) pre-tx; 0
      // when the geoid is null or has no code on file (D5). The anon repo allocates the code from it (M3).
      resolveJurisdictionCode: (geoid) => resolveJurisdictionCode(sql, geoid),
      // Derive an address from the pin when the reporter supplied none (street-level Photon, falling back
      // to the local "City, ST" label). Best-effort: null leaves addr empty and never blocks the submit.
      reverseGeocode: async (lat, lng) =>
        (await container.streetReverseGeocode(lat, lng)) ?? container.geocoder.cityStateLabel(lat, lng),
      // media-intake already enqueues media.checks at finalize (the worker dedupes on the uploadId
      // singletonKey), so anon-create does not re-enqueue. The seam stays available for a future path
      // that attaches not-yet-finalized media; left as the no-op default here.
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
      const body = parse(AnonReportRequestSchema, request.body)

      // Resolve the presented anon token from the body (mobile echoes it as anonToken) OR, when the body
      // does not carry one, from the readable civfix_anon cookie (web). The browser auto-resends that
      // cookie with credentials:include, so the web round-trips without any client change; body wins when
      // both are present (an explicit echo is canonical). Reading the cookie is load-bearing: without it a
      // NEW token was minted every submit, resetting the per-token abuse cap.
      const presentedAnonToken = body.anonToken ?? cookieAnonToken(request)
      const effectiveBody =
        presentedAnonToken !== undefined ? { ...body, anonToken: presentedAnonToken } : body

      // cfGeoTrusted gates the spoofable CF-* geo headers on the request arriving through a trusted
      // proxy/edge (P1-2): request.ips has >1 entry only when Fastify trusted a forwarding hop.
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

      // 202 Accepted: the report is HELD pending review (not yet published), mirroring ABUSE_HELD.
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
      // Validate the (reportId, claimCode) pair against the shared request schema in ONE pass so the
      // contract is the single source of truth (the param + query are folded in here, not re-parsed).
      const { claimCode } = parse(AnonReportStatusRequestSchema, {
        reportId: id,
        claimCode: queryClaimCode(request),
      })

      const payload: AnonReportStatusResponse = await service().anonReportStatus(id, claimCode)
      reply.status(200).send(payload)
    },
  )
}

/** The raw claimCode query value (validated by AnonReportStatusRequestSchema), or undefined when absent. */
function queryClaimCode(request: FastifyRequest): unknown {
  return (request.query as Record<string, unknown> | undefined)?.claimCode
}

/** Read the anon token from the readable civfix_anon cookie (web transport); undefined when absent/empty. */
function cookieAnonToken(request: FastifyRequest): string | undefined {
  const value = request.cookies[ANON_COOKIE]
  return value && value.length > 0 ? value : undefined
}

// NOT httpOnly: the SPA reads this cookie to echo it back as anonToken. SameSite=Lax + Secure-in-prod
// matches the CSRF cookie; the token carries no authority by itself (the server loads + caps the row).
function setAnonCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(ANON_COOKIE, token, {
    httpOnly: false,
    sameSite: "lax",
    secure: isProd(),
    path: "/",
    maxAge: ANON_TOKEN_TTL_SECONDS,
  })
}
