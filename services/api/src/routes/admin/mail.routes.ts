/**
 * Admin mail / outreach routes: stats, thread list/read, compose/reply/read/status/resend. The
 * requireOperator guard is applied by routes/admin/index.ts (this whole router runs inside the guarded
 * child context); mutations additionally carry csrfProtect. The service is built lazily from the container
 * (Drizzle mail repo + the OutboundMailService over container.mailer) or from a per-instance test override
 * (in-memory repo + a FakeMailer-backed outbound). See the in-handler comments for the in-tx-audit (H4)
 * invariant.
 */

import {
  ComposeRequestSchema,
  MailListQuerySchema,
  MarkMailReadRequestSchema,
  ReplyRequestSchema,
  ResendRequestSchema,
  SetMailStatusRequestSchema,
  type MailListResponse,
  type MailStatsResponse,
  type MailThreadDTO,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { route } from "../../versioning/route.js"
import { idParam, overridableService, parse, parseBodyWithId, sendOk } from "./_route-utils.js"
import { auditRead } from "./_audit-read.js"
import { requireOperator } from "../../auth/admin-guard.js"
import { makeMailService } from "../../services/admin/mail-service.js"
import {
  makeContainerOutboundMailService,
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
  const csrfProtect = container.csrf.protect

  /** Build the admin mail service from injected overrides (tests) or the container (production). */
  const service = overridableService(
    app,
    "adminMailOverrides",
    (overrides) =>
      makeMailService({
        repo: overrides.repo,
        outboundMail: overrides.outboundMail,
        fromOutreach: overrides.fromOutreach,
      }),
    () => {
      const sql = container.getDb().sql
      const repo: MailRepository = makeDrizzleMailRepository(sql)
      const outboundMail = makeContainerOutboundMailService(container, { repo, logger: app.log })
      return makeMailService({
        repo,
        outboundMail,
        fromOutreach: container.env.MAIL_FROM_OUTREACH,
      })
    },
  )

  // `stats` is a static segment, so find-my-way prefers it over getMailThread's `:id` regardless of
  // registration order — the ordering here is stylistic, not load-bearing.
  route(app, "getMailStats", async (_request, reply) => {
    const payload: MailStatsResponse = await service().stats()
    reply.status(200).send(payload)
  })

  route(app, "listMail", async (request, reply) => {
    const query = parse(MailListQuerySchema, request.query)
    const payload: MailListResponse = await service().list(query)
    reply.status(200).send(payload)
  })

  // L4: a per-subject read — the full correspondence of one thread. Audited (best-effort) so reading a
  // citizen<->city conversation is attributable, like every write on this router already is.
  route(app, "getMailThread", async (request, reply) => {
    const { id } = idParam(request)
    const payload: MailThreadDTO = await service().getThread(id)
    await auditRead(request, container, requireOperator(request), {
      action: "mail.thread_viewed",
      target: `mail:${id}`,
    })
    reply.status(200).send(payload)
  })

  // H4: the compose/reply/status/resend mutations each pass the resolved operator id into the service so
  // the audit (mail.sent / mail.replied / mail.status_changed / mail.resent) is written in the SAME tx as
  // its effect. Mark-read is a benign lifecycle toggle with no audit action.
  route(app, "composeMail", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const body = parse(ComposeRequestSchema, request.body)
    await service().compose({ to: body.to, subject: body.subject, body: body.body }, actorId)
    sendOk(reply)
  })

  route(app, "replyMail", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(ReplyRequestSchema, request)
    await service().reply(id, { body: body.body }, actorId)
    sendOk(reply)
  })

  route(app, "markMailRead", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = parseBodyWithId(MarkMailReadRequestSchema, request) // body is validate-only
    await service().markRead(id)
    sendOk(reply)
  })

  route(app, "setMailStatus", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(SetMailStatusRequestSchema, request)
    await service().setStatus(id, body.status, actorId)
    sendOk(reply)
  })

  route(app, "resendMail", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id } = parseBodyWithId(ResendRequestSchema, request) // body is validate-only
    await service().resend(id, actorId)
    sendOk(reply)
  })
}

