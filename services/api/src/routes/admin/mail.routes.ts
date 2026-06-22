/**
 * Admin mail / outreach routes: stats, thread list/read, compose/reply/read/status/resend. The
 * requireOperator guard is applied by routes/admin/index.ts (this whole router runs inside the guarded
 * child context); mutations additionally carry csrfProtect. The service is built lazily from the container
 * (Drizzle mail repo + the OutboundMailService over container.mailer) or from a per-instance test override
 * (in-memory repo + a FakeMailer-backed outbound). See the in-handler comments for the route-order +
 * in-tx-audit (H4) invariants.
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

  // getMailStats is registered BEFORE getMailThread so the literal `stats` segment is not captured by :id.
  route(app, "getMailStats", async (_request, reply) => {
    const payload: MailStatsResponse = await service().stats()
    reply.status(200).send(payload)
  })

  route(app, "listMail", async (request, reply) => {
    const query = parse(MailListQuerySchema, request.query)
    const payload: MailListResponse = await service().list(query)
    reply.status(200).send(payload)
  })

  route(app, "getMailThread", async (request, reply) => {
    const { id } = idParam(request)
    const payload: MailThreadDTO = await service().getThread(id)
    reply.status(200).send(payload)
  })

  // H4: the compose/reply/status/resend mutations each pass request.auth.userId into the service so the
  // operator audit (mail.sent / mail.replied / mail.status_changed / mail.resent) is written in the SAME
  // tx as its effect. Mark-read is a benign lifecycle toggle with no audit action.
  route(app, "composeMail", { preHandler: csrfProtect }, async (request, reply) => {
    const body = parse(ComposeRequestSchema, request.body)
    await service().compose(
      { to: body.to, subject: body.subject, body: body.body },
      request.auth.userId,
    )
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(app, "replyMail", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(ReplyRequestSchema, { ...(request.body as object), id })
    await service().reply(id, { body: body.body }, request.auth.userId)
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(app, "markMailRead", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    parse(MarkMailReadRequestSchema, { ...(request.body as object), id }) // validate-only
    await service().markRead(id)
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(app, "setMailStatus", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    const body = parse(SetMailStatusRequestSchema, { ...(request.body as object), id })
    await service().setStatus(id, body.status, request.auth.userId)
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })

  route(app, "resendMail", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = idParam(request)
    parse(ResendRequestSchema, { ...(request.body as object), id }) // validate-only
    await service().resend(id, request.auth.userId)
    const payload: AdminOkResponse = { ok: true }
    reply.status(200).send(payload)
  })
}

