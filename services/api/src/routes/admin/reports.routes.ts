/**
 * Admin reports routes (Phase 2).
 *
 *   GET  /admin/reports             the reports list (filter/search/paginate) (AdminReportListResponse).
 *   GET  /admin/reports/:id         a report detail (GetAdminReportResponse).
 *   POST /admin/reports/:id/status  set status (SetReportStatusRequest). [csrf]
 *   POST /admin/reports/:id/flag    flag/unflag (FlagReportRequest). [csrf]
 *   POST /admin/reports/:id/remove  remove (soft-delete / rejected) (RemoveReportRequest). [csrf]
 *   POST /admin/reports/:id/message follow-up to reporter|city (SendFollowupRequest). [csrf]
 *
 * Every body/query is validated against the shared Zod schema via parse(). The requireOperator guard is
 * applied by routes/admin/index.ts (this whole router runs inside the guarded child context); mutations
 * additionally carry csrfProtect. The acting operator's userId comes from request.auth.userId and is
 * recorded on every audit write (status/flag/remove/message). The service is built lazily from the
 * container (Drizzle report repo + the OutboundMailService over the Drizzle mail repo + container.mailer)
 * or from a per-instance test override (in-memory repos), mirroring the Phase 1 lazy-construct pattern.
 */

import {
  AdminReportListQuerySchema,
  FlagReportRequestSchema,
  RemoveReportRequestSchema,
  SendFollowupRequestSchema,
  SetReportStatusRequestSchema,
  type AdminOkResponse,
  type AdminReportDTO,
  type AdminReportListResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { csrfProtect } from "../../auth/csrf.js"
import { idParam, parse } from "./_route-utils.js"
import {
  makeAdminReportService,
  type AdminReportRepository,
  type AdminReportService,
} from "../../services/admin/admin-report-service.js"
import { makeDrizzleAdminReportRepository } from "../../services/admin/admin-report-repository.drizzle.js"
import {
  makeOutboundMailService,
  type OutboundMailService,
} from "../../services/admin/outbound-mail-service.js"
import { makeDrizzleMailRepository } from "../../services/admin/mail-repository.drizzle.js"

/**
 * Optional injected admin-report dependencies (tests). When present the routes build the service from
 * these (an in-memory repo + a stub/real OutboundMailService) instead of the container, so the whole
 * HTTP flow runs offline.
 */
export interface AdminReportRouteOverrides {
  repo: AdminReportRepository
  outboundMail: OutboundMailService
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected admin-report route overrides (tests). See AdminReportRouteOverrides. */
    adminReportOverrides?: AdminReportRouteOverrides
  }
}

export async function registerAdminReportsRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the admin-report service from injected overrides (tests) or the container (production). */
  function service(): AdminReportService {
    const overrides = app.adminReportOverrides
    if (overrides) {
      return makeAdminReportService({
        repo: overrides.repo,
        outboundMail: overrides.outboundMail,
        ...(overrides.now !== undefined ? { now: overrides.now } : {}),
      })
    }
    const sql = container.getDb().sql
    const repo: AdminReportRepository = makeDrizzleAdminReportRepository(sql)
    const outboundMail = makeOutboundMailService({
      repo: makeDrizzleMailRepository(sql),
      mailer: container.mailer,
      env: {
        MAIL_FROM_OUTREACH: container.env.MAIL_FROM_OUTREACH,
        MAIL_REPLY_DOMAIN: container.env.MAIL_REPLY_DOMAIN,
      },
    })
    return makeAdminReportService({ repo, outboundMail })
  }

  // -------------------------------------------------------------------------
  // GET /admin/reports
  // -------------------------------------------------------------------------
  app.get("/admin/reports", async (request, reply) => {
    const query = parse(AdminReportListQuerySchema, request.query)
    const payload: AdminReportListResponse = await service().list(query)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /admin/reports/:id
  // -------------------------------------------------------------------------
  app.get("/admin/reports/:id", async (request, reply) => {
    const { id } = idParam(request)
    const payload: AdminReportDTO = await service().get(id)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/reports/:id/status  [csrf]
  // -------------------------------------------------------------------------
  // Each mutation is audited inside the service's repo transaction (atomic with the effect + timeline),
  // using the operator userId resolved here from request.auth.userId. See admin-report-repository.drizzle.
  app.post("/admin/reports/:id/status", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(SetReportStatusRequestSchema, { ...(request.body as object), id })
    await service().setStatus(id, { status: body.status, actorId: request.auth.userId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/reports/:id/flag  [csrf]
  // -------------------------------------------------------------------------
  app.post("/admin/reports/:id/flag", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(FlagReportRequestSchema, { ...(request.body as object), id })
    await service().flag(id, { reason: body.reason ?? null, actorId: request.auth.userId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/reports/:id/remove  [csrf]
  // -------------------------------------------------------------------------
  app.post("/admin/reports/:id/remove", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(RemoveReportRequestSchema, { ...(request.body as object), id })
    await service().remove(id, { reason: body.reason ?? null, actorId: request.auth.userId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/reports/:id/message  [csrf]
  // -------------------------------------------------------------------------
  app.post("/admin/reports/:id/message", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(SendFollowupRequestSchema, { ...(request.body as object), id })
    await service().sendFollowup(id, { to: body.to, body: body.body, actorId: request.auth.userId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })
}

