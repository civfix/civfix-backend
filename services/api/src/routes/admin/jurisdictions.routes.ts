/**
 * Admin jurisdictions (routing contacts + directory) routes: "Save & route", the directory list, and the
 * no-route PATCH. The operator userId is threaded INTO the service so the audit (discovery.contacts_saved
 * on save, jurisdiction.patched on patch) is written inside the repo transaction (H4: did + recorded is
 * atomic with the effect); the route never writes a separate audit.
 */

import {
  JurisdictionListQuerySchema,
  PatchJurisdictionRequestSchema,
  SaveContactsRequestSchema,
  type AdminOkResponse,
  type JurisdictionDirectoryResponse,
  type JurisdictionGeometryResponse,
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

  route(
    app,
    "saveJurisdictionContacts",
    { preHandler: csrfProtect },
    async (request, reply) => {
      const geoid = geoidParam(request)
      const body = parse(SaveContactsRequestSchema, { ...(request.body as object), geoid })
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

  route(app, "listJurisdictions", async (request, reply) => {
    const query = parse(JurisdictionListQuerySchema, request.query)
    const payload: JurisdictionDirectoryResponse = await service().listDirectory(query)
    reply.status(200).send(payload)
  })

  route(app, "getJurisdictionGeometry", async (request, reply) => {
    const geoid = geoidParam(request)
    const payload: JurisdictionGeometryResponse = await service().getGeometry(geoid)
    reply.status(200).send(payload)
  })

  route(app, "patchJurisdiction", { preHandler: csrfProtect }, async (request, reply) => {
    const geoid = geoidParam(request)
    const body = parse(PatchJurisdictionRequestSchema, { ...(request.body as object), geoid })
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

