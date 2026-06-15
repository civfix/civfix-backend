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
  AppError,
  type AnonReportResponse,
  type AnonReportStatusResponse,
} from "@civfix/shared"
import { ZodError, z, type ZodTypeAny } from "zod"
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
import { makePhotonReverseGeocode } from "../adapters/reverse-geocode.photon.js"
import { route } from "../versioning/route.js"

/** Response header carrying a freshly-issued anon token (mobile reads + re-sends it as anonToken). */
export const ANON_TOKEN_HEADER = "x-anon-token"

/** Shared street-level reverse geocoder (Photon); falls back to the local "City, ST" label per call. */
const photonReverseGeocode = makePhotonReverseGeocode()

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
      // Derive an address from the pin when the reporter supplied none (street-level Photon, falling back
      // to the local "City, ST" label). Best-effort: null leaves addr empty and never blocks the submit.
      reverseGeocode: async (lat, lng) =>
        (await photonReverseGeocode(lat, lng)) ?? container.geocoder.cityStateLabel(lat, lng),
      // media-intake already enqueues media.checks at finalize (the worker dedupes on the uploadId
      // singletonKey), so anon-create does not re-enqueue. The seam stays available for a future path
      // that attaches not-yet-finalized media; left as the no-op default here.
    })
  }

  // -------------------------------------------------------------------------
  // POST /anon/reports  [public, full abuse stack]
  // -------------------------------------------------------------------------
  route(app, "anonCreateReport", async (request, reply) => {
    const body = parse(AnonReportRequestSchema, request.body)

    // Resolve the presented anon token from the body (mobile echoes it as anonToken) OR, when the body
    // does not carry one, from the readable civfix_anon cookie (web). The browser auto-resends that
    // cookie with credentials:include, so the web round-trips WITHOUT any client change; previously only
    // body.anonToken was read, so the cookie was ignored and a NEW token was minted every submit,
    // resetting the per-token abuse cap. Body wins when both are present (an explicit echo is canonical).
    const presentedAnonToken = body.anonToken ?? cookieAnonToken(request)
    const effectiveBody =
      presentedAnonToken !== undefined ? { ...body, anonToken: presentedAnonToken } : body

    // The presented anon token travels in the body (effectiveBody.anonToken); the context carries only
    // the transport signals the abuse stack reads (IP + CF geo headers + UA). cfGeoTrusted gates the
    // CF-* geo headers on the request actually arriving through a trusted proxy/edge (P1-2): request.ips
    // has more than one entry only when Fastify trusted a forwarding hop (see cfGeoFromTrustedEdge).
    const result = await service().submitAnonReport(effectiveBody, {
      ip: request.ip || null,
      cfGeo: request.headers,
      cfGeoTrusted: cfGeoFromTrustedEdge(request),
      ...(request.headers["user-agent"] !== undefined
        ? { userAgent: String(request.headers["user-agent"]) }
        : {}),
    })

    // Hand back a freshly-minted anon token (when one was issued) via cookie (web) + header (mobile).
    if (result.issuedAnonToken !== undefined) {
      setAnonCookie(reply, result.issuedAnonToken)
      reply.header(ANON_TOKEN_HEADER, result.issuedAnonToken)
    }

    // 202 Accepted: the report was accepted but is HELD pending review (not yet published). This mirrors
    // the ABUSE_HELD status semantics; the body is the AnonReportResponse with status "held".
    const payload: AnonReportResponse = result.response
    reply.status(202).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /anon/reports/:id/status  [public, claimCode-gated]  (dedicated tighter per-IP limit, P2-7)
  // -------------------------------------------------------------------------
  route(
    app,
    "anonReportStatus",
    { config: { rateLimit: ANON_STATUS_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = parse(AnonReportIdParamsSchema, request.params)
      // The claim code arrives as a query param; validate the (reportId, claimCode) pair against the
      // shared request schema so the contract is the single source of truth.
      const q = parse(AnonReportStatusQuerySchema, request.query)
      parse(AnonReportStatusRequestSchema, { reportId: id, claimCode: q.claimCode })

      const payload: AnonReportStatusResponse = await service().anonReportStatus(id, q.claimCode)
      reply.status(200).send(payload)
    },
  )
}

/** Query schema for the status route: the claim code echoed by the client. */
const AnonReportStatusQuerySchema = z.object({ claimCode: z.string().min(1) }).strict()

/**
 * Dedicated tighter per-IP limit for the public claim-code status surface (P2-7). The 256-bit claim
 * code is not brute-forcible and a wrong code already 404s with a constant-time compare, so this is
 * defense-in-depth on top of the global limiter. 30/min/IP comfortably covers a client polling its own
 * held report's status while bounding automated probing.
 */
const ANON_STATUS_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const

/**
 * Read the anon token from the readable civfix_anon cookie (web transport). Returns undefined when the
 * cookie is absent or empty. The browser auto-resends this cookie (set on a prior submit) with
 * credentials:include, so the web client round-trips the SAME token without echoing it in the body.
 */
function cookieAnonToken(request: FastifyRequest): string | undefined {
  const value = request.cookies[ANON_COOKIE]
  return value && value.length > 0 ? value : undefined
}

/**
 * Set the readable anon-token cookie (web transport). NOT httpOnly (the SPA reads it to echo as
 * anonToken) but SameSite=Lax + Secure-in-prod, matching the CSRF cookie. Lifetime tracks the token.
 */
function setAnonCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(ANON_COOKIE, token, {
    httpOnly: false,
    sameSite: "lax",
    secure: isProd(),
    path: "/",
    maxAge: ANON_TOKEN_TTL_SECONDS,
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
