
import {
  AdminReportListQuerySchema,
  FlagReportRequestSchema,
  RemoveReportRequestSchema,
  RouteReportRequestSchema,
  SendFollowupRequestSchema,
  SetReportStatusRequestSchema,
  SetReportVerdictRequestSchema,
  type AdminReportDTO,
  type AdminReportListResponse,
  type RouteReportResponse,
  type SetReportVerdictResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import { perIdentity } from "../../plugins/rate-limit.js"
import type { Container } from "../../di.js"
import { route } from "../../versioning/route.js"
import {
  idParam,
  overridableService,
  parse,
  parseBodyWithId,
  sendOk,
  spreadNow,
} from "./_route-utils.js"
import { requireOperator } from "../../auth/admin-guard.js"
import {
  makeAdminReportService,
  type AdminReportRepository,
} from "../../services/admin/admin-report-service.js"
import { makeDrizzleAdminReportRepository } from "../../services/admin/admin-report-repository.drizzle.js"
import {
  makeContainerOutboundMailService,
  type OutboundMailService,
} from "../../services/admin/outbound-mail-service.js"
import { makeDrizzleCleanupRepository } from "../../services/cleanup-repository.drizzle.js"
import { makePrivateMediaPresigner } from "../../services/media-presign.js"
import { ADMIN_OUTBOUND_MAIL_RATE_LIMIT } from "./mail.routes.js"
import { makeContainerReportChatEmitter } from "../../services/report-chat-emitter.js"
import type { ReportChatSystemEmitter } from "../../services/report-timeline-event.js"

export interface AdminReportRouteOverrides {
  repo: AdminReportRepository
  outboundMail: OutboundMailService
  presignMedia?: (
    r2Key: string,
    thumbKey: string | null,
  ) => Promise<{ url: string; thumbUrl?: string }>
  loadLinkedEventsForReports?: (
    reportIds: string[],
  ) => Promise<Map<string, import("../../services/cleanup-service.js").LinkedEventView[]>>
  now?: () => Date
  reportChatEmitter?: ReportChatSystemEmitter
}

declare module "fastify" {
  interface FastifyInstance {
    adminReportOverrides?: AdminReportRouteOverrides
  }
}

export async function registerAdminReportsRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  const service = overridableService(
    app,
    "adminReportOverrides",
    (overrides) =>
      makeAdminReportService({
        repo: overrides.repo,
        outboundMail: overrides.outboundMail,
        ...(overrides.presignMedia !== undefined ? { presignMedia: overrides.presignMedia } : {}),
        ...(overrides.loadLinkedEventsForReports !== undefined
          ? { loadLinkedEventsForReports: overrides.loadLinkedEventsForReports }
          : {}),
        ...spreadNow(overrides),
        ...(overrides.reportChatEmitter !== undefined
          ? { reportChatEmitter: overrides.reportChatEmitter }
          : {}),
      }),
    () => {
      const sql = container.getDb().sql
      const repo: AdminReportRepository = makeDrizzleAdminReportRepository(sql)
      const outboundMail = makeContainerOutboundMailService(container, { logger: app.log })
      const cleanupRepo = makeDrizzleCleanupRepository(sql)
      return makeAdminReportService({
        repo,
        outboundMail,
        presignMedia: makePrivateMediaPresigner(container.storage),
        loadLinkedEventsForReports: (reportIds) =>
          cleanupRepo.loadLinkedEventsForReports(reportIds),
        loadMediaBytes: (k) => container.storage.getObject(k),
        reportChatEmitter: makeContainerReportChatEmitter(container, app.log),
      })
    },
  )

  route(app, "listAdminReports", async (request, reply) => {
    const query = parse(AdminReportListQuerySchema, request.query)
    const payload: AdminReportListResponse = await service().list(query)
    reply.status(200).send(payload)
  })

  route(app, "getAdminReport", async (request, reply) => {
    const { id } = idParam(request)
    const payload: AdminReportDTO = await service().get(id)
    reply.status(200).send(payload)
  })

  route(app, "setReportStatus", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id, body } = parseBodyWithId(SetReportStatusRequestSchema, request)
    await service().setStatus(id, { status: body.status, actorId: operatorId })
    sendOk(reply)
  })

  route(app, "flagReport", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id, body } = parseBodyWithId(FlagReportRequestSchema, request)
    await service().flag(id, { reason: body.reason ?? null, actorId: operatorId })
    sendOk(reply)
  })

  route(app, "removeReport", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id, body } = parseBodyWithId(RemoveReportRequestSchema, request)
    await service().remove(id, { reason: body.reason ?? null, actorId: operatorId })
    sendOk(reply)
  })

  route(
    app,
    "sendReportFollowup",
    { preHandler: csrfProtect, config: { rateLimit: ADMIN_OUTBOUND_MAIL_RATE_LIMIT } },
    async (request, reply) => {
      const operatorId = requireOperator(request)
      const { id, body } = parseBodyWithId(SendFollowupRequestSchema, request)
      await service().sendFollowup(id, { to: body.to, body: body.body, actorId: operatorId })
      sendOk(reply)
    },
  )

  route(app, "setReportVerdict", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id, body } = parseBodyWithId(SetReportVerdictRequestSchema, request)
    await service().setVerdict({ id, verdict: body.verdict, actorId: operatorId })
    const payload: SetReportVerdictResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(
    app,
    "routeReport",
    { preHandler: csrfProtect, config: { rateLimit: ROUTE_REPORT_RATE_LIMIT } },
    async (request, reply) => {
      const operatorId = requireOperator(request)
      const { id, body } = parseBodyWithId(RouteReportRequestSchema, request)
      const { threadId, routedTo } = await service().routeToJurisdiction(id, {
        contactEmailOverride: body.contactEmailOverride ?? null,
        note: body.note ?? null,
        actorId: operatorId,
      })
      const payload: RouteReportResponse = { ok: true, threadId, routedTo }
      reply.status(200).send(payload)
    },
  )
}

export const ROUTE_REPORT_RATE_LIMIT = perIdentity({
  max: 10,
  timeWindow: "1 minute",
  skipOnError: false,
})

