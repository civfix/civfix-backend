/**
 * Admin mail / outreach routes (Phase 2).
 *
 *   GET  /admin/mail/stats     deliverability stats over 7d (MailStatsResponse).
 *   GET  /admin/mail           the thread list (filter dir / needs-attention / geoid) (MailListResponse).
 *   GET  /admin/mail/:id       a thread with messages (GetMailThreadResponse).
 *   POST /admin/mail           compose a new outbound thread (ComposeRequest). [csrf]
 *   POST /admin/mail/:id/reply reply to a thread (ReplyRequest). [csrf]
 *   POST /admin/mail/:id/read  mark a thread read (MarkMailReadRequest). [csrf]
 *   POST /admin/mail/:id/status set thread status (SetMailStatusRequest). [csrf]
 *   POST /admin/mail/:id/resend resend an outbound message (ResendRequest). [csrf]
 *
 * ROUTE ORDER: GET /admin/mail/stats is registered BEFORE GET /admin/mail/:id so the literal `stats`
 * segment is not captured by the `:id` param.
 *
 * Every body/query is validated against the shared Zod schema via parse(). The requireOperator guard is
 * applied by routes/admin/index.ts (this whole router runs inside the guarded child context); mutations
 * additionally carry csrfProtect. The acting operator's userId comes from request.auth.userId and is
 * passed INTO the service so the audit is written inside the repo transaction (H4: mail.sent on compose,
 * mail.replied on reply, mail.resent on resend, mail.status_changed on status - each atomic with its
 * effect and covered by the in-memory repo's audit sink in tests, instead of a separate skip-under-test
 * route audit). Marking a thread read is a benign lifecycle toggle with no dedicated audit action, so it
 * is not audited. The service is built lazily from the container (Drizzle mail repo + the
 * OutboundMailService over container.mailer) or from a per-instance test override (in-memory repo + a
 * FakeMailer-backed outbound), mirroring the Phase 1 lazy-construct pattern.
 */

import {
  ComposeRequestSchema,
  MailListQuerySchema,
  MarkMailReadRequestSchema,
  ReplyRequestSchema,
  ResendRequestSchema,
  SetMailStatusRequestSchema,
  type AdminOkResponse,
  type MailListResponse,
  type MailStatsResponse,
  type MailThreadDTO,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { csrfProtect } from "../../auth/csrf.js"
import { route } from "../../versioning/route.js"
import { idParam, parse } from "./_route-utils.js"
import {
  makeMailService,
  type MailService,
} from "../../services/admin/mail-service.js"
import {
  makeOutboundMailService,
  type OutboundMailService,
} from "../../services/admin/outbound-mail-service.js"
import {
  makeDrizzleMailRepository,
  type MailRepository,
} from "../../services/admin/mail-repository.drizzle.js"

/**
 * Optional injected mail dependencies (tests). When present the routes build the service from these (an
 * in-memory mail repo + a FakeMailer-backed OutboundMailService) instead of the container, so the whole
 * HTTP flow runs offline with no DB and no SMTP.
 */
export interface AdminMailRouteOverrides {
  repo: MailRepository
  outboundMail: OutboundMailService
  /** The outbound From address (MAIL_FROM_OUTREACH); used to resolve a thread's reply recipient. */
  fromOutreach: string
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected admin-mail route overrides (tests). See AdminMailRouteOverrides. */
    adminMailOverrides?: AdminMailRouteOverrides
  }
}

export async function registerAdminMailRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the admin mail service from injected overrides (tests) or the container (production). */
  function service(): MailService {
    const overrides = app.adminMailOverrides
    if (overrides) {
      return makeMailService({
        repo: overrides.repo,
        outboundMail: overrides.outboundMail,
        fromOutreach: overrides.fromOutreach,
      })
    }
    const sql = container.getDb().sql
    const repo: MailRepository = makeDrizzleMailRepository(sql)
    const outboundMail = makeOutboundMailService({
      repo,
      mailer: container.mailer,
      env: {
        MAIL_FROM_OUTREACH: container.env.MAIL_FROM_OUTREACH,
        MAIL_REPLY_DOMAIN: container.env.MAIL_REPLY_DOMAIN,
      },
    })
    return makeMailService({
      repo,
      outboundMail,
      fromOutreach: container.env.MAIL_FROM_OUTREACH,
    })
  }

  // -------------------------------------------------------------------------
  // GET /admin/mail/stats  (static segment BEFORE /:id)
  // -------------------------------------------------------------------------
  route(app, "getMailStats", async (_request, reply) => {
    const payload: MailStatsResponse = await service().stats()
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /admin/mail
  // -------------------------------------------------------------------------
  route(app, "listMail", async (request, reply) => {
    const query = parse(MailListQuerySchema, request.query)
    const payload: MailListResponse = await service().list(query)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /admin/mail/:id
  // -------------------------------------------------------------------------
  route(app, "getMailThread", async (request, reply) => {
    const { id } = idParam(request)
    const payload: MailThreadDTO = await service().getThread(id)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/mail  [csrf]  (compose -> mail.sent)
  // -------------------------------------------------------------------------
  route(app, "composeMail", { preHandler: csrfProtect }, async (request, reply) => {
    const body = parse(ComposeRequestSchema, request.body)
    // The mail.sent audit is written in-tx with the first message insert (H4).
    await service().compose(
      { to: body.to, subject: body.subject, body: body.body },
      request.auth.userId,
    )
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/mail/:id/reply  [csrf]  (reply -> mail.replied)
  // -------------------------------------------------------------------------
  route(app, "replyMail", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(ReplyRequestSchema, { ...(request.body as object), id })
    // The mail.replied audit is written in-tx with the OUT message insert (H4).
    await service().reply(id, { body: body.body }, request.auth.userId)
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/mail/:id/read  [csrf]  (lifecycle toggle; not audited)
  // -------------------------------------------------------------------------
  route(app, "markMailRead", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    parse(MarkMailReadRequestSchema, { ...(request.body as object), id })
    await service().markRead(id)
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/mail/:id/status  [csrf]  (status change -> mail.status_changed)
  // -------------------------------------------------------------------------
  route(app, "setMailStatus", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(SetMailStatusRequestSchema, { ...(request.body as object), id })
    // The mail.status_changed audit is written in-tx with the status UPDATE (H4).
    await service().setStatus(id, body.status, request.auth.userId)
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /admin/mail/:id/resend  [csrf]  (resend -> mail.resent)
  // -------------------------------------------------------------------------
  route(app, "resendMail", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    parse(ResendRequestSchema, { ...(request.body as object), id })
    // The mail.resent audit is written in-tx with the OUT message insert (H4).
    await service().resend(id, request.auth.userId)
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })
}

