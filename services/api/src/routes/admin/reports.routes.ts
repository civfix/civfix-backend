
import {
  AdminReportListQuerySchema,
  DiscussionHistoryQuerySchema,
  FlagReportRequestSchema,
  IdSchema,
  RemoveDiscussionMessageRequestSchema,
  RemoveReportRequestSchema,
  RouteReportRequestSchema,
  SendFollowupRequestSchema,
  SetReportStatusRequestSchema,
  SetReportVerdictRequestSchema,
  type AdminOkResponse,
  type AdminReportDTO,
  type AdminReportListResponse,
  type DiscussionMessageDTO,
  type DiscussionPageResponse,
  type RouteReportResponse,
  type SetReportVerdictResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { Container } from "../../di.js"
import { csrfProtect } from "../../auth/csrf.js"
import { route } from "../../versioning/route.js"
import { idParam, parse } from "./_route-utils.js"
import { requireOperator } from "../../auth/admin-guard.js"
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
import { makeDrizzleCleanupRepository } from "../../services/cleanup-repository.drizzle.js"
import { makeMediaPresigner } from "../../services/media-presign.js"
import {
  makeDiscussionService,
  type DiscussionRepository,
  type DiscussionService,
} from "../../services/discussion-service.js"
import { makeDrizzleDiscussionRepository } from "../../services/discussion-repository.drizzle.js"
import { roomKeyFor } from "../../ws/gateway.js"
import { writeAudit } from "../../services/admin/audit.js"

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
  discussionRepo?: DiscussionRepository
  now?: () => Date
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
  function service(): AdminReportService {
    const overrides = app.adminReportOverrides
    if (overrides) {
      return makeAdminReportService({
        repo: overrides.repo,
        outboundMail: overrides.outboundMail,
        ...(overrides.presignMedia !== undefined ? { presignMedia: overrides.presignMedia } : {}),
        ...(overrides.loadLinkedEventsForReports !== undefined
          ? { loadLinkedEventsForReports: overrides.loadLinkedEventsForReports }
          : {}),
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
    const cleanupRepo = makeDrizzleCleanupRepository(sql)
    return makeAdminReportService({
      repo,
      outboundMail,
      presignMedia: makeMediaPresigner(container.storage),
      loadLinkedEventsForReports: (reportIds) => cleanupRepo.loadLinkedEventsForReports(reportIds),
      loadMediaBytes: (k) => container.storage.getObject(k),
    })
  }

  function discussionService(): DiscussionService {
    const overrides = app.adminReportOverrides
    const sql = overrides ? undefined : container.getDb().sql
    const repo: DiscussionRepository =
      overrides?.discussionRepo ?? makeDrizzleDiscussionRepository(sql!)
    const outboundMail =
      overrides?.outboundMail ??
      makeOutboundMailService({
        repo: makeDrizzleMailRepository(sql!),
        mailer: container.mailer,
        env: {
          MAIL_FROM_OUTREACH: container.env.MAIL_FROM_OUTREACH,
          MAIL_REPLY_DOMAIN: container.env.MAIL_REPLY_DOMAIN,
        },
      })
    return makeDiscussionService({
      repo,
      outboundMail,
      presignMedia: makeMediaPresigner(container.storage),
      broadcast: (reportId, event) => {
        void Promise.resolve(
          container.chatService.broadcastEvent?.(roomKeyFor("report_discussion", reportId), {
            type: "discussion",
            reportId,
            event,
          }),
        ).catch(() => {})
      },
    })
  }

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
    const { id } = idParam(request)
    const body = parse(SetReportStatusRequestSchema, { ...(request.body as object), id })
    await service().setStatus(id, { status: body.status, actorId: operatorId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(app, "flagReport", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id } = idParam(request)
    const body = parse(FlagReportRequestSchema, { ...(request.body as object), id })
    await service().flag(id, { reason: body.reason ?? null, actorId: operatorId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(app, "removeReport", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id } = idParam(request)
    const body = parse(RemoveReportRequestSchema, { ...(request.body as object), id })
    await service().remove(id, { reason: body.reason ?? null, actorId: operatorId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(app, "sendReportFollowup", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id } = idParam(request)
    const body = parse(SendFollowupRequestSchema, { ...(request.body as object), id })
    await service().sendFollowup(id, { to: body.to, body: body.body, actorId: operatorId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(app, "setReportVerdict", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id } = idParam(request)
    const body = parse(SetReportVerdictRequestSchema, { ...(request.body as object), id })
    await service().setVerdict({ id, verdict: body.verdict, actorId: operatorId })
    const payload: SetReportVerdictResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(app, "routeReport", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id } = idParam(request)
    const body = parse(RouteReportRequestSchema, { ...(request.body as object), id })
    const { threadId, routedTo } = await service().routeToJurisdiction(id, {
      contactEmailOverride: body.contactEmailOverride ?? null,
      note: body.note ?? null,
      actorId: operatorId,
    })
    if (!app.adminReportOverrides) {
      try {
        await writeAudit(container.getDb().sql, {
          actorId: operatorId,
          action: "report.routed",
          target: `report:${id}`,
          meta: { to: routedTo, threadId },
        })
      } catch (err) {
        request.log.warn({ err }, "routeReport: audit write failed")
      }
    }
    const payload: RouteReportResponse = { ok: true, threadId, routedTo }
    reply.status(200).send(payload)
  })

  route(app, "getAdminReportDiscussion", async (request, reply) => {
    const { id } = idParam(request)
    const q = parse(DiscussionHistoryQuerySchema, request.query)
    const payload: DiscussionPageResponse = await discussionService().listForOperator(
      id,
      q.cursor ?? null,
      q.limit ?? 0,
    )
    reply.status(200).send(payload)
  })

  route(app, "removeDiscussionMessage", { preHandler: csrfProtect }, async (request, reply) => {
    const operatorId = requireOperator(request)
    const { id, messageId } = parse(MessageParamsSchema, request.params)
    const body = parse(RemoveDiscussionMessageRequestSchema, {
      ...(request.body as object),
      id,
      messageId,
    })
    const dto: DiscussionMessageDTO = await discussionService().deleteMessage(id, messageId, {
      userId: operatorId,
      isOperator: true,
    })
    if (!app.adminReportOverrides) {
      try {
        await writeAudit(container.getDb().sql, {
          actorId: operatorId,
          action: "moderation.removed",
          target: `report_discussion_message:${messageId}`,
          meta: {
            reportId: id,
            ...(body.reason !== undefined && body.reason !== "" ? { reason: body.reason } : {}),
          },
        })
      } catch (err) {
        request.log.warn({ err }, "removeDiscussionMessage: audit write failed")
      }
    }
    reply.status(200).send(dto)
  })
}

const MessageParamsSchema = z.object({ id: IdSchema, messageId: IdSchema }).strict()

