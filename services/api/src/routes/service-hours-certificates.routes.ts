/**
 * Service-hours transcript routes (P5 / DP §9.3): three holder endpoints plus ONE public verification
 * read.
 *
 * Shape copied from `volunteer-hours.routes.ts`: an overrides interface + `declare module "fastify"`, a
 * LAZY `service()` closure, then the `route()` calls. The laziness is load-bearing — `container.getDb()`
 * / `getRedis()` at MOUNT time has produced 500s in this repo before, and the offline route-coverage
 * harness boots this router with no database at all.
 */

import {
  IssueServiceHoursCertificateRequestSchema,
  RevokeCertificateRequestSchema,
  VerifyCertificateRequestSchema,
  type IssueServiceHoursCertificateResponse,
  type ListMyCertificatesResponse,
  type RevokeCertificateResponse,
  type VerifyCertificateResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import { perHost, perIdentity } from "../plugins/rate-limit.js"
import type { Container } from "../di.js"
import { webBaseUrlOf } from "../lib/base-url.js"
import { requireAuth } from "../auth/context.js"
import { CERTIFICATE_VERIFY_PATH } from "../services/certificate-pdf.js"
import {
  makeCertificateService,
  type CertificateRepository,
  type CertificateService,
  type CertificateStorage,
} from "../services/certificate-service.js"
import type { VolunteerHoursRepository } from "../services/volunteer-hours-service.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"

export interface CertificateOverrides {
  repo: CertificateRepository
  /** Only `entriesForCertificate` is used; a test may pass the full in-memory volunteer-hours twin. */
  hours?: Pick<VolunteerHoursRepository, "entriesForCertificate">
  /**
   * Injected so a test can wrap the storage adapter and ASSERT the presign arguments. `FakeStorage`
   * ignores its third parameter and always returns `memory://<key>`, so asserting on the returned string
   * proves nothing about `forceSigned` — and getting `forceSigned` wrong publishes every transcript
   * permanently (H9).
   */
  storage?: CertificateStorage
}

declare module "fastify" {
  interface FastifyInstance {
    certificateOverrides?: CertificateOverrides
  }
}

/** The path param, before the shared schema's normalizing transform runs over it. */
const CodeParamsSchema = z.object({ code: z.string().min(1).max(32) }).strict()

/**
 * C3 rate limits.
 *
 * ISSUE renders a PDF synchronously and mints a durable public artifact from personal data; 6/hour caps
 * the worst case (1000 rows, ~500 ms) at ~3 s of event-loop blocking per user per hour.
 *
 * VERIFY is 60/min, RAISED from the design's 20/min: the limit is keyed per IP and a school office behind
 * one NAT address would 429 after twenty checks. Enumeration is not the threat model — the code space is
 * 2^60.
 */
export const CERTIFICATE_ISSUE_RATE_LIMIT = perIdentity({
  max: 6,
  timeWindow: "1 hour",
  hostMax: 6,
})
export const CERTIFICATE_REVOKE_RATE_LIMIT = perIdentity({ max: 20, timeWindow: "1 hour" })
export const CERTIFICATE_VERIFY_RATE_LIMIT = perHost({ max: 60, timeWindow: "1 minute" })

export async function registerServiceHoursCertificateRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  function service(): CertificateService {
    const overrides = app.certificateOverrides
    return makeCertificateService({
      repo: overrides ? overrides.repo : container.getCertificateRepo(),
      hours:
        overrides?.hours ??
        (overrides
          ? // An overrides object with no ledger twin means "no hours": every issue then 409s, which is
            // exactly what an offline harness wants, and it is never a silent reach for the database.
            {
              entriesForCertificate: () =>
                Promise.resolve({ items: [], totalHours: 0, entryCount: 0 }),
            }
          : container.getVolunteerHoursRepo()),
      storage: overrides?.storage ?? container.storage,
      verifyBaseUrl: `${webBaseUrlOf(container.env)}${CERTIFICATE_VERIFY_PATH}`,
      logger: app.log,
    })
  }

  route(
    app,
    "issueServiceHoursCertificate",
    { preHandler: csrfProtect, config: { rateLimit: CERTIFICATE_ISSUE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(IssueServiceHoursCertificateRequestSchema, request.body ?? {})
      const payload: IssueServiceHoursCertificateResponse = await service().issue(
        userId,
        body.locale,
      )
      reply.status(200).send(payload)
    },
  )

  route(app, "listMyServiceHoursCertificates", async (request, reply) => {
    const userId = requireAuth(request)
    const payload: ListMyCertificatesResponse = await service().list(userId)
    reply.status(200).send(payload)
  })

  route(
    app,
    "revokeServiceHoursCertificate",
    { preHandler: csrfProtect, config: { rateLimit: CERTIFICATE_REVOKE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { code } = parse(CodeParamsSchema, request.params)
      // `:code` is followed by a static segment, so the typed client cannot extract it — the contract
      // schema carries it and the path param is folded back in here (the documented logEventHours merge
      // pattern), which also runs the shared normalizing transform over a hand-typed dashed code.
      const body = parse(RevokeCertificateRequestSchema, {
        ...((request.body as object | undefined) ?? {}),
        code,
      })
      const payload: RevokeCertificateResponse = await service().revoke(userId, body.code)
      reply.status(200).send(payload)
    },
  )

  /**
   * PUBLIC. No auth, no CSRF, and no `showVolunteerHours` gate (C2/DB B32c): the profile privacy flag
   * governs the profile projection, while a certificate is a document the holder deliberately handed to a
   * verifier. Revocation is the control here.
   *
   * The response is never cacheable by a shared cache in a way that matters — it is keyed by a secret
   * capability — but it is also never personalized by session, so no `Vary` juggling is required.
   */
  route(
    app,
    "verifyServiceHoursCertificate",
    { config: { rateLimit: CERTIFICATE_VERIFY_RATE_LIMIT } },
    async (request, reply) => {
      // A malformed code is a 422 from the schema (the "you mistyped it" signal); a well-formed but
      // unknown one is a 404 from the service.
      const { code } = parse(VerifyCertificateRequestSchema, {
        code: (request.params as { code?: unknown }).code,
      })
      const payload: VerifyCertificateResponse = await service().verify(code)
      reply.status(200).send(payload)
    },
  )
}
