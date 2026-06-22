/**
 * Admin jurisdictions (routing contacts + directory) routes (Phase 2).
 *
 *   POST  /admin/jurisdictions/:geoid/contacts  "Save & route": persist per-category routing contacts,
 *                                               set contact_updated_at, route pending pins, enqueue
 *                                               (throttled) outreach (SaveContactsRequest). [csrf]
 *   GET   /admin/jurisdictions                  the jurisdiction directory (JurisdictionDirectoryResponse).
 *   PATCH /admin/jurisdictions/:geoid           patch contacts / form / notes (PatchJurisdictionRequest). [csrf]
 *
 * Every body/query is validated against the shared Zod schema via parse(). The requireOperator guard is
 * applied by routes/admin/index.ts; mutations additionally carry csrfProtect. The acting operator's
 * userId comes from request.auth.userId and is passed INTO the service so the audit is written inside the
 * repo transaction (H4: discovery.contacts_saved on save, jurisdiction.patched on patch are atomic with
 * their effect and covered by the in-memory repo's audit sink in tests - the route no longer writes a
 * separate, skip-under-test audit). The service is built lazily from the container (Drizzle repo + the
 * Jobs seam) or a test override (in-memory repo + fake jobs).
 */

import {
  JurisdictionListQuerySchema,
  PatchJurisdictionRequestSchema,
  SaveContactsRequestSchema,
  type AdminOkResponse,
  type JurisdictionDirectoryResponse,
  type ReportCategory,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { csrfProtect } from "../../auth/csrf.js"
import { route } from "../../versioning/route.js"
import { geoidParam, parse } from "./_route-utils.js"
import {
  makeJurisdictionContactsService,
  type JurisdictionContactsRepository,
  type JurisdictionContactsService,
  type OutreachEnqueuer,
} from "../../services/admin/jurisdiction-contacts-service.js"
import { makeDrizzleJurisdictionContactsRepository } from "../../services/admin/jurisdiction-contacts-repository.drizzle.js"

/**
 * Optional injected contacts-service dependencies (tests). When present the routes build the service
 * from these (an in-memory repo + a fake jobs enqueuer) so the whole HTTP flow runs offline.
 */
export interface JurisdictionRouteOverrides {
  repo: JurisdictionContactsRepository
  jobs?: OutreachEnqueuer
  throttleDays?: number
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected jurisdiction-route overrides (tests). See JurisdictionRouteOverrides. */
    jurisdictionOverrides?: JurisdictionRouteOverrides
  }
}

export async function registerAdminJurisdictionsRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the contacts service from injected overrides (tests) or the container (production). */
  function service(): JurisdictionContactsService {
    const overrides = app.jurisdictionOverrides
    if (overrides) {
      return makeJurisdictionContactsService({
        repo: overrides.repo,
        jobs: overrides.jobs ?? container.jobs,
        throttleDays: overrides.throttleDays ?? container.env.OUTREACH_THROTTLE_DAYS,
        ...(overrides.now !== undefined ? { now: overrides.now } : {}),
      })
    }
    const repo: JurisdictionContactsRepository = makeDrizzleJurisdictionContactsRepository(
      container.getDb().sql,
    )
    return makeJurisdictionContactsService({
      repo,
      jobs: container.jobs,
      throttleDays: container.env.OUTREACH_THROTTLE_DAYS,
    })
  }

  // -------------------------------------------------------------------------
  // POST /admin/jurisdictions/:geoid/contacts  [csrf]  "Save & route"
  // -------------------------------------------------------------------------
  route(
    app,
    "saveJurisdictionContacts",
    { preHandler: csrfProtect },
    async (request, reply) => {
      const geoid = geoidParam(request)
      const body = parse(SaveContactsRequestSchema, { ...(request.body as object), geoid })
      // The save + route + audit (discovery.contacts_saved) run atomically inside the repo transaction
      // (H4); the operator userId is threaded in for the in-tx audit.
      await service().saveAndRoute(
        geoid,
        {
          contacts: (body.contacts ?? {}) as Partial<Record<ReportCategory, string | null>>,
          defaultEmails: body.defaultEmails ?? [],
          formUrl: body.formUrl ?? null,
        },
        request.auth.userId,
      )
      const payload: AdminOkResponse = { ok: true }
      reply.status(200).send(payload)
    },
  )

  // -------------------------------------------------------------------------
  // GET /admin/jurisdictions  (directory)
  // -------------------------------------------------------------------------
  route(app, "listJurisdictions", async (request, reply) => {
    const query = parse(JurisdictionListQuerySchema, request.query)
    const payload: JurisdictionDirectoryResponse = await service().listDirectory(query)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // PATCH /admin/jurisdictions/:geoid  [csrf]
  // -------------------------------------------------------------------------
  route(app, "patchJurisdiction", { preHandler: csrfProtect }, async (request, reply) => {
    const geoid = geoidParam(request)
    const body = parse(PatchJurisdictionRequestSchema, { ...(request.body as object), geoid })
    // Patch + audit (jurisdiction.patched) run atomically inside the repo transaction (H4).
    await service().patch(
      geoid,
      {
        ...(body.contacts !== undefined
          ? { contacts: body.contacts as Partial<Record<ReportCategory, string | null>> }
          : {}),
        ...(body.defaultEmails !== undefined ? { defaultEmails: body.defaultEmails } : {}),
        ...(body.formUrl !== undefined ? { formUrl: body.formUrl ?? null } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.flagged !== undefined ? { flagged: body.flagged } : {}),
        ...(body.flagReason !== undefined ? { flagReason: body.flagReason } : {}),
        ...(body.handle !== undefined ? { handle: body.handle } : {}),
      },
      request.auth.userId,
    )
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })
}

