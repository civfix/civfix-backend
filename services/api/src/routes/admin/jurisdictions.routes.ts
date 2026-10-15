// The operator id is threaded into the service so the audit row (discovery.contacts_saved,
// jurisdiction.patched) commits in the same repo transaction as the change; the route never writes a
// separate audit.

import {
  JurisdictionListQuerySchema,
  PatchJurisdictionRequestSchema,
  SaveContactsRequestSchema,
  type JurisdictionDirectoryResponse,
  type JurisdictionGeometryResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireOperator } from "../../auth/admin-guard.js"
import { route } from "../../versioning/route.js"
import {
  geoidParam,
  httpUrlField,
  overridableService,
  parse,
  sendOk,
  spreadNow,
} from "./_route-utils.js"
import {
  makeJurisdictionContactsService,
  type OutreachEnqueuer,
} from "../../services/admin/jurisdiction-contacts-service.js"
import type { JurisdictionContactsRepository } from "../../services/admin/jurisdiction-contacts-repository.js"
import { makeDrizzleJurisdictionContactsRepository } from "../../services/admin/jurisdiction-contacts-repository.drizzle.js"

/** Test-only: an in-memory repo and a fake jobs enqueuer so the whole HTTP flow runs offline. */
export interface JurisdictionRouteOverrides {
  repo: JurisdictionContactsRepository
  jobs?: OutreachEnqueuer
  throttleDays?: number
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    jurisdictionOverrides?: JurisdictionRouteOverrides
  }
}

export async function registerAdminJurisdictionsRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  const service = overridableService(
    app,
    "jurisdictionOverrides",
    (overrides) =>
      makeJurisdictionContactsService({
        repo: overrides.repo,
        jobs: overrides.jobs ?? container.jobs,
        throttleDays: overrides.throttleDays ?? container.env.OUTREACH_THROTTLE_DAYS,
        outreachDigestEnabled: container.env.OUTREACH_DIGEST_ENABLED,
        ...spreadNow(overrides),
      }),
    () => {
      const repo: JurisdictionContactsRepository = makeDrizzleJurisdictionContactsRepository(
        container.getDb().sql,
      )
      return makeJurisdictionContactsService({
        repo,
        jobs: container.jobs,
        throttleDays: container.env.OUTREACH_THROTTLE_DAYS,
        outreachDigestEnabled: container.env.OUTREACH_DIGEST_ENABLED,
      })
    },
  )

  route(app, "saveJurisdictionContacts", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const geoid = geoidParam(request)
    const body = parse(SaveContactsRequestSchema, { ...(request.body as object), geoid })
    await service().saveAndRoute(
      geoid,
      {
        contacts: body.contacts ?? {},
        defaultEmails: body.defaultEmails ?? [],
        // The shared `.url()` schema lets javascript:/data: URIs through.
        formUrl: httpUrlField(body.formUrl, "formUrl"),
        ...(body.forwardSubjectTemplate !== undefined
          ? { forwardSubjectTemplate: body.forwardSubjectTemplate }
          : {}),
        ...(body.forwardBodyTemplate !== undefined
          ? { forwardBodyTemplate: body.forwardBodyTemplate }
          : {}),
      },
      actorId,
    )
    sendOk(reply)
  })

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
    const actorId = requireOperator(request)
    const geoid = geoidParam(request)
    const body = parse(PatchJurisdictionRequestSchema, { ...(request.body as object), geoid })
    await service().patch(
      geoid,
      {
        ...(body.contacts !== undefined ? { contacts: body.contacts } : {}),
        ...(body.defaultEmails !== undefined ? { defaultEmails: body.defaultEmails } : {}),
        // Same scheme allowlist as save; an absent field still means "leave unchanged".
        ...(body.formUrl !== undefined ? { formUrl: httpUrlField(body.formUrl, "formUrl") } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.flagged !== undefined ? { flagged: body.flagged } : {}),
        ...(body.flagReason !== undefined ? { flagReason: body.flagReason } : {}),
        ...(body.handle !== undefined ? { handle: body.handle } : {}),
        ...(body.forwardSubjectTemplate !== undefined
          ? { forwardSubjectTemplate: body.forwardSubjectTemplate }
          : {}),
        ...(body.forwardBodyTemplate !== undefined
          ? { forwardBodyTemplate: body.forwardBodyTemplate }
          : {}),
      },
      actorId,
    )
    sendOk(reply)
  })
}
