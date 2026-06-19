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
  AppError,
  DiscussionHistoryQuerySchema,
  FlagReportRequestSchema,
  IdSchema,
  RemoveDiscussionMessageRequestSchema,
  RemoveReportRequestSchema,
  RouteReportRequestSchema,
  SendFollowupRequestSchema,
  SetReportStatusRequestSchema,
  type AdminOkResponse,
  type AdminReportDTO,
  type AdminReportListResponse,
  type DiscussionMessageDTO,
  type DiscussionPageResponse,
  type RouteReportResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
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
import { MEDIA_GET_URL_TTL_SEC } from "../../services/media-intake-service.js"
import {
  makeDiscussionService,
  type DiscussionRepository,
  type DiscussionService,
} from "../../services/discussion-service.js"
import { makeDrizzleDiscussionRepository } from "../../services/discussion-repository.drizzle.js"
import { roomKeyFor } from "../../ws/gateway.js"
import { writeAudit } from "../../services/admin/audit.js"

/** Build the default media presigner over the container's Storage seam (mirrors the citizen report path). */
function defaultPresign(
  container: Container,
): (r2Key: string, thumbKey: string | null) => Promise<{ url: string; thumbUrl?: string }> {
  return async (r2Key: string, thumbKey: string | null) => {
    const url = await container.storage.presignGet(r2Key, MEDIA_GET_URL_TTL_SEC)
    if (thumbKey === null) return { url }
    const thumbUrl = await container.storage.presignGet(thumbKey, MEDIA_GET_URL_TTL_SEC)
    return { url, thumbUrl }
  }
}

/**
 * Optional injected admin-report dependencies (tests). When present the routes build the service from
 * these (an in-memory repo + a stub/real OutboundMailService) instead of the container, so the whole
 * HTTP flow runs offline.
 */
export interface AdminReportRouteOverrides {
  repo: AdminReportRepository
  outboundMail: OutboundMailService
  /** Optional media presigner (tests); defaults to the service's identity pass-through when omitted. */
  presignMedia?: (
    r2Key: string,
    thumbKey: string | null,
  ) => Promise<{ url: string; thumbUrl?: string }>
  /** Optional linked-events loader (tests); when omitted the detail's linkedEvents is []. */
  loadLinkedEventsForReports?: (
    reportIds: string[],
  ) => Promise<Map<string, import("../../services/cleanup-service.js").LinkedEventView[]>>
  /**
   * Optional injected discussion repo (tests): backs the operator discussion read (incl. soft-removed) +
   * the operator remove (soft-delete). When omitted in production the route builds the Drizzle-backed repo.
   */
  discussionRepo?: DiscussionRepository
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
    // The cleanup repo backs the report detail's "linked events" section (loadLinkedEventsForReports).
    const cleanupRepo = makeDrizzleCleanupRepository(sql)
    return makeAdminReportService({
      repo,
      outboundMail,
      presignMedia: defaultPresign(container),
      loadLinkedEventsForReports: (reportIds) => cleanupRepo.loadLinkedEventsForReports(reportIds),
      // Approve & send loads the report's media bytes (for binary photo attachments) over the Storage seam.
      loadMediaBytes: (k) => container.storage.getObject(k),
    })
  }

  /**
   * Build the discussion service for the operator read + remove (incl. soft-removed). Injected repo in
   * tests, else the Drizzle repo. The operator paths exercise only listForOperator + deleteMessage (with
   * isOperator=true), so the @city-forward seam is never reached here; we still supply a real
   * OutboundMailService for completeness, and the broadcast so an operator removal fans out a live
   * {type:"discussion",event:"remove"} signal to the report-discussion room (best-effort, fire-and-forget).
   */
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
      presignMedia: defaultPresign(container),
      // Live fan-out of the operator removal over the report-discussion WS room (best-effort). roomKeyFor
      // is the single source of truth for the "rd:" prefix; a fan-out failure must NEVER affect the response.
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

  // -------------------------------------------------------------------------
  // GET /admin/reports
  // -------------------------------------------------------------------------
  route(app, "listAdminReports", async (request, reply) => {
    const query = parse(AdminReportListQuerySchema, request.query)
    const payload: AdminReportListResponse = await service().list(query)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /admin/reports/:id
  // -------------------------------------------------------------------------
  route(app, "getAdminReport", async (request, reply) => {
    const { id } = idParam(request)
    const payload: AdminReportDTO = await service().get(id)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/reports/:id/status  [csrf]
  // -------------------------------------------------------------------------
  // Each mutation is audited inside the service's repo transaction (atomic with the effect + timeline),
  // using the operator userId resolved here from request.auth.userId. See admin-report-repository.drizzle.
  route(app, "setReportStatus", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(SetReportStatusRequestSchema, { ...(request.body as object), id })
    await service().setStatus(id, { status: body.status, actorId: request.auth.userId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/reports/:id/flag  [csrf]
  // -------------------------------------------------------------------------
  route(app, "flagReport", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(FlagReportRequestSchema, { ...(request.body as object), id })
    await service().flag(id, { reason: body.reason ?? null, actorId: request.auth.userId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/reports/:id/remove  [csrf]
  // -------------------------------------------------------------------------
  route(app, "removeReport", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(RemoveReportRequestSchema, { ...(request.body as object), id })
    await service().remove(id, { reason: body.reason ?? null, actorId: request.auth.userId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/reports/:id/message  [csrf]
  // -------------------------------------------------------------------------
  route(app, "sendReportFollowup", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(SendFollowupRequestSchema, { ...(request.body as object), id })
    await service().sendFollowup(id, { to: body.to, body: body.body, actorId: request.auth.userId })
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/reports/:id/route  [csrf]  (Approve & send to jurisdiction)
  // -------------------------------------------------------------------------
  // Email THIS report's full packet (photos attached + signed links) to its jurisdiction contact (or a
  // per-send override) on a per-report mail thread, advancing the report toward `acknowledged`. The
  // service throws AppError.notRoutable (422) when neither a resolved contact nor an override is on file.
  // Audited with `report.routed` (best-effort AFTER the send, since SMTP cannot join the DB tx) recording
  // the address + the thread the city's reply will land in.
  route(app, "routeReport", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(RouteReportRequestSchema, { ...(request.body as object), id })
    const { threadId, routedTo } = await service().routeToJurisdiction(id, {
      contactEmailOverride: body.contactEmailOverride ?? null,
      note: body.note ?? null,
      actorId: request.auth.userId,
    })
    // Audit the route (the send already happened; a routed report is loud, never silent). Best-effort: a
    // post-send audit blip must not fail the ack of a successful send. Skipped under test overrides (no DB).
    if (!app.adminReportOverrides) {
      try {
        await writeAudit(container.getDb().sql, {
          actorId: request.auth.userId,
          action: "report.routed",
          target: `report:${id}`,
          meta: { to: routedTo, threadId },
        })
      } catch {
        // The send + status advance already committed; a missing audit row is logged elsewhere, not fatal.
      }
    }
    const payload: RouteReportResponse = { ok: true, threadId, routedTo }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /admin/reports/:id/discussion  (operator)
  // -------------------------------------------------------------------------
  // The operator view of a report's public discussion. Same DTO + paging as the citizen read, but it
  // INCLUDES soft-removed (tombstoned) messages so moderation can see what was removed (the service still
  // tombstones a removed row's body/author when projecting, so removed content never leaks). No
  // report-visibility gate (the requireOperator scope already gated this route).
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

  // -------------------------------------------------------------------------
  // POST /admin/reports/:id/discussion/:messageId/remove  [csrf]  (operator soft-delete moderation)
  // -------------------------------------------------------------------------
  // Operator soft-delete of a discussion message (moderation). Audited like the other admin report
  // mutations: a `moderation.removed` audit_log row recording the acting operator + the target message +
  // the optional reason. The service tombstones the message (body blanked, author nulled) so the subtree +
  // reaction counts survive; deleteMessage with isOperator=true bypasses the author-ownership check.
  route(app, "removeDiscussionMessage", { preHandler: csrfProtect }, async (request, reply) => {
    // requireOperator returns the operator's non-null userId (the scope hook already gated this route);
    // the discussion actor needs a non-null userId, so resolve it here rather than reading the nullable
    // request.auth.userId.
    const operatorId = requireOperator(request)
    const params = request.params as { id?: unknown; messageId?: unknown }
    const { id } = idParam(request)
    // messageId is a sibling UUID path param; validate it the same way idParam validates :id.
    const messageId = idParamValue(params.messageId)
    const body = parse(RemoveDiscussionMessageRequestSchema, {
      ...(request.body as object),
      id,
      messageId,
    })
    const dto: DiscussionMessageDTO = await discussionService().deleteMessage(id, messageId, {
      userId: operatorId,
      isOperator: true,
    })
    // Audit the moderation removal (mirrors the other admin report mutations' audit). The audit write is a
    // best-effort record AFTER the soft-delete; a moderation action is loud, never silent.
    await writeAudit(container.getDb().sql, {
      actorId: operatorId,
      action: "moderation.removed",
      target: `report_discussion_message:${messageId}`,
      meta: {
        reportId: id,
        ...(body.reason !== undefined && body.reason !== "" ? { reason: body.reason } : {}),
      },
    })
    reply.status(200).send(dto)
  })
}

/**
 * Validate a sibling UUID path param (e.g. `:messageId`) the same way `idParam` validates `:id`: a missing
 * or malformed value throws AppError.validation (400) so a bad id never reaches the SQL layer. Kept local
 * (the shared _route-utils.idParam only reads `:id`).
 */
function idParamValue(raw: unknown): string {
  const value = typeof raw === "string" ? raw : ""
  const parsed = IdSchema.safeParse(value)
  if (!parsed.success) {
    throw AppError.validation({ messageId: value === "" ? "required" : "must be a valid id" })
  }
  return parsed.data
}

