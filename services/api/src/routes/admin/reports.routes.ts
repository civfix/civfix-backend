
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
import { makeMediaPresigner } from "../../services/media-presign.js"
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
  /** D-D1: inject a fake timeline emitter in tests; the real path builds one from container primitives. */
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
        presignMedia: makeMediaPresigner(container.storage),
        loadLinkedEventsForReports: (reportIds) =>
          cleanupRepo.loadLinkedEventsForReports(reportIds),
        loadMediaBytes: (k) => container.storage.getObject(k),
        // D-D1: mirror every timeline event this service writes into the report chat (best-effort, no-op
        // under fake-chat). Built from container primitives so it needs no chat-gateway wiring instances.
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

  route(app, "sendReportFollowup", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id, body } = parseBodyWithId(SendFollowupRequestSchema, request)
    await service().sendFollowup(id, { to: body.to, body: body.body, actorId: operatorId })
    sendOk(reply)
  })

  route(app, "setReportVerdict", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id, body } = parseBodyWithId(SetReportVerdictRequestSchema, request)
    await service().setVerdict({ id, verdict: body.verdict, actorId: operatorId })
    // Its own response type, structurally { ok: true } — not the shared AdminOkResponse sendOk writes.
    const payload: SetReportVerdictResponse = { ok: true }
    reply.status(200).send(payload)
  })

  /**
   * M5: route a report's full packet (reporter name, exact coords, address, photos) to its jurisdiction.
   *
   * Three controls, all added by the 2026-07-24 review:
   *  (a) the `report.routed` audit is now written INSIDE the outbound message insert's transaction (the
   *      service passes it down as MailRepository.insertMessage's `audit` param, exactly like the other
   *      mail paths). It used to be written here afterwards on a separate connection, in a try/catch that
   *      downgraded a failure to a warn — so a packet could be emailed with no audit row at all. An audit
   *      failure now rolls the message insert back and fails the request BEFORE delivery.
   *  (b) `contactEmailOverride` is constrained to the jurisdiction's own mail domain by the service
   *      (assertOverrideDomainAllowed); it used to accept any well-formed address.
   *  (c) the per-OPERATOR rate limit below. The global limiter keys on IP only, so a single stolen operator
   *      session could walk the report table and mail every packet out. Keyed on the session userId (with
   *      the IP as the fallback for a caller that somehow reached here unauthenticated) this caps bulk
   *      exfiltration at ROUTE_REPORT_RATE_LIMIT while leaving normal triage (a handful of routes a minute)
   *      untouched.
   */
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

/**
 * M5(c): per-OPERATOR bucket for routeReport. Every request here emails a citizen's identity + exact home
 * location off-platform, so it is rate-limited by ACTOR, not by IP (the global limiter's IP key is escaped
 * by simply rotating egress). 10/minute is far above real triage throughput and far below "drain the table".
 *
 * FAIL-CLOSED: a route bucket otherwise inherits the global limiter's `skipOnError: true`, and
 * `/v1/admin/reports` is not under a SENSITIVE_RATE_LIMIT_PREFIXES path, so a Redis store error would
 * silently remove this cap — exactly the anti-exfiltration control it exists to be. `skipOnError: false`
 * makes an uncountable request a 429 instead of an unmetered mail-out.
 */
export const ROUTE_REPORT_RATE_LIMIT = perIdentity({
  max: 10,
  timeWindow: "1 minute",
  skipOnError: false,
})

