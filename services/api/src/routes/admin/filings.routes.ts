import {
  CancelFilingRequestSchema,
  FileReportRequestSchema,
  GetFilingRequestSchema,
  GetFilingSettingsRequestSchema,
  ListFilingRoutesRequestSchema,
  ListFilingsRequestSchema,
  RecordManualFilingRequestSchema,
  RetryFilingRequestSchema,
  SaveFilingRoutesRequestSchema,
  SetFilingSettingsRequestSchema,
  type CancelFilingResponse,
  type FileReportResponse,
  type GetFilingResponse,
  type GetFilingSettingsResponse,
  type ListFilingRoutesResponse,
  type ListFilingsResponse,
  type RecordManualFilingResponse,
  type RetryFilingResponse,
  type SaveFilingRoutesResponse,
  type SetFilingSettingsResponse,
} from "@civfix/contract"
import type { Storage } from "@civfix/seams"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireOperator } from "../../auth/admin-guard.js"
import { firstNonEmpty } from "../../lib/text.js"
import { route } from "../../versioning/route.js"
import type { AdminReportRepository } from "../../services/admin/admin-report-repository.js"
import { makeDrizzleAdminReportRepository } from "../../services/admin/admin-report-repository.drizzle.js"
import type { JurisdictionContactsRepository } from "../../services/admin/jurisdiction-contacts-repository.js"
import { makeDrizzleJurisdictionContactsRepository } from "../../services/admin/jurisdiction-contacts-repository.drizzle.js"
import { makeFilingAdminService } from "../../services/filings/filing-admin-service.js"
import type { FilingRepository } from "../../services/filings/filing-repository.js"
import { makeDrizzleFilingRepository } from "../../services/filings/filing-repository.drizzle.js"
import type { FilingService } from "../../services/filings/filing-service.js"
import { makeContainerFilingService } from "../../services/filings/filing-wiring.js"
import { makeFilingEvidencePresigner } from "../../services/media-presign.js"
import { geoidParam, idParam, overridableService, parse, parseBodyWithId } from "./_route-utils.js"
import { ADMIN_REPORT_MUTATION_RATE_LIMIT, ROUTE_REPORT_RATE_LIMIT } from "./reports.routes.js"

export interface FilingRouteOverrides {
  filings: FilingRepository
  reports: Pick<AdminReportRepository, "getReport" | "getRouting">
  jurisdictions: Pick<JurisdictionContactsRepository, "jurisdictionExists">
  service: FilingService
  storage: Pick<Storage, "presignGet">
  automaticFiling: boolean
}

declare module "fastify" {
  interface FastifyInstance {
    filingOverrides?: FilingRouteOverrides
  }
}

const RATE_LIMITED = { rateLimit: ADMIN_REPORT_MUTATION_RATE_LIMIT }

export async function registerAdminFilingRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  const service = overridableService(
    app,
    "filingOverrides",
    (overrides) =>
      makeFilingAdminService({
        filings: overrides.filings,
        reports: overrides.reports,
        jurisdictions: overrides.jurisdictions,
        filingService: overrides.service,
        presignEvidence: makeFilingEvidencePresigner(overrides.storage),
        automaticFiling: overrides.automaticFiling,
      }),
    () => {
      const sql = container.getDb().sql
      return makeFilingAdminService({
        filings: makeDrizzleFilingRepository(sql),
        reports: makeDrizzleAdminReportRepository(sql, { logger: app.log }),
        jurisdictions: makeDrizzleJurisdictionContactsRepository(sql),
        filingService: makeContainerFilingService(container, app.log),
        presignEvidence: makeFilingEvidencePresigner(container.storage),
        automaticFiling: container.env.FILING_AUTOMATIC_ENABLED,
      })
    },
  )

  route(
    app,
    "fileReport",
    { preHandler: csrfProtect, config: { rateLimit: ROUTE_REPORT_RATE_LIMIT } },
    async (request, reply) => {
      const operatorId = requireOperator(request)
      const { id, body } = parseBodyWithId(FileReportRequestSchema, request)
      const filing = await service().file(id, { actorId: operatorId, note: body.note ?? null })
      const payload: FileReportResponse = { filing }
      return reply.status(200).send(payload)
    },
  )

  route(app, "listFilings", { config: RATE_LIMITED }, async (request, reply) => {
    requireOperator(request)
    const query = parse(ListFilingsRequestSchema, request.query)
    const payload: ListFilingsResponse = await service().list(query)
    return reply.status(200).send(payload)
  })

  route(app, "getFiling", { config: RATE_LIMITED }, async (request, reply) => {
    requireOperator(request)
    const { id } = parse(GetFilingRequestSchema, idParam(request))
    const payload: GetFilingResponse = { filing: await service().get(id) }
    return reply.status(200).send(payload)
  })

  route(
    app,
    "retryFiling",
    { preHandler: csrfProtect, config: RATE_LIMITED },
    async (request, reply) => {
      const operatorId = requireOperator(request)
      const { id } = parseBodyWithId(RetryFilingRequestSchema, request)
      const payload: RetryFilingResponse = { filing: await service().retry(id, operatorId) }
      return reply.status(200).send(payload)
    },
  )

  route(
    app,
    "cancelFiling",
    { preHandler: csrfProtect, config: RATE_LIMITED },
    async (request, reply) => {
      const operatorId = requireOperator(request)
      const { id, body } = parseBodyWithId(CancelFilingRequestSchema, request)
      const filing = await service().cancel(id, {
        actorId: operatorId,
        note: firstNonEmpty(body.note?.trim()) ?? null,
      })
      const payload: CancelFilingResponse = { filing }
      return reply.status(200).send(payload)
    },
  )

  route(
    app,
    "recordManualFiling",
    { preHandler: csrfProtect, config: RATE_LIMITED },
    async (request, reply) => {
      const operatorId = requireOperator(request)
      const { id, body } = parseBodyWithId(RecordManualFilingRequestSchema, request)
      const filing = await service().recordManual(id, {
        actorId: operatorId,
        caseId: body.caseId,
        caseUrl: body.caseUrl ?? null,
        note: firstNonEmpty(body.note?.trim()) ?? null,
      })
      const payload: RecordManualFilingResponse = { filing }
      return reply.status(200).send(payload)
    },
  )

  route(app, "getFilingSettings", { config: RATE_LIMITED }, async (request, reply) => {
    requireOperator(request)
    parse(GetFilingSettingsRequestSchema, request.query)
    const payload: GetFilingSettingsResponse = await service().getSettings()
    return reply.status(200).send(payload)
  })

  route(
    app,
    "setFilingSettings",
    { preHandler: csrfProtect, config: RATE_LIMITED },
    async (request, reply) => {
      const operatorId = requireOperator(request)
      const body = parse(SetFilingSettingsRequestSchema, request.body)
      const payload: SetFilingSettingsResponse = await service().setSettings(
        body.paused,
        operatorId,
      )
      return reply.status(200).send(payload)
    },
  )

  route(app, "listFilingRoutes", { config: RATE_LIMITED }, async (request, reply) => {
    requireOperator(request)
    const { geoid } = parse(ListFilingRoutesRequestSchema, { geoid: geoidParam(request) })
    const payload: ListFilingRoutesResponse = { routes: await service().listRoutes(geoid) }
    return reply.status(200).send(payload)
  })

  route(
    app,
    "saveFilingRoutes",
    { preHandler: csrfProtect, config: RATE_LIMITED },
    async (request, reply) => {
      const operatorId = requireOperator(request)
      const geoid = geoidParam(request)
      const body = parse(SaveFilingRoutesRequestSchema, { ...(request.body as object), geoid })
      const routes = await service().saveRoutes(geoid, body.routes, operatorId)
      const payload: SaveFilingRoutesResponse = { routes }
      return reply.status(200).send(payload)
    },
  )
}
