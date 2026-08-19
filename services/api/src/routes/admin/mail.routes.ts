
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
import type { Storage } from "@civfix/shared/interfaces"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { route } from "../../versioning/route.js"
import { idParam, overridableService, parse, parseBodyWithId, sendOk } from "./_route-utils.js"
import { auditRead } from "./_audit-read.js"
import { requireOperator } from "../../auth/admin-guard.js"
import { perIdentity } from "../../plugins/rate-limit.js"
import { MEDIA_GET_URL_TTL_SEC } from "../../services/media-intake-service.js"
import { mapWithLimit, PRESIGN_CONCURRENCY } from "../../services/media-presign.js"
import { makeMailService } from "../../services/admin/mail-service.js"
import {
  makeContainerOutboundMailService,
  type OutboundMailService,
} from "../../services/admin/outbound-mail-service.js"
import {
  makeDrizzleMailRepository,
  type MailRepository,
} from "../../services/admin/mail-repository.drizzle.js"

export const ADMIN_OUTBOUND_MAIL_RATE_LIMIT = perIdentity({
  max: 20,
  timeWindow: "1 minute",
  skipOnError: false,
})

const MAX_MAIL_THREAD_ATTACHMENTS = 50

export interface AdminMailRouteOverrides {
  repo: MailRepository
  outboundMail: OutboundMailService
  fromOutreach: string
  storage?: Storage
}

declare module "fastify" {
  interface FastifyInstance {
    adminMailOverrides?: AdminMailRouteOverrides
  }
}

export async function registerAdminMailRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

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

  function storage(): Storage {
    return app.adminMailOverrides?.storage ?? container.inboundStorage
  }

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
    const dto: MailThreadDTO = await service().getThread(id)
    await auditRead(request, container, requireOperator(request), {
      action: "mail.thread_viewed",
      target: `mail:${id}`,
    })
    const store = storage()
    const payload: MailThreadDTO = {
      ...dto,
      messages: await mapWithLimit(dto.messages, PRESIGN_CONCURRENCY, async (msg) => ({
        ...msg,
        attachments: await mapWithLimit(
          msg.attachments.slice(0, MAX_MAIL_THREAD_ATTACHMENTS),
          PRESIGN_CONCURRENCY,
          async (att) => ({ ...att, key: await store.presignGet(att.key, MEDIA_GET_URL_TTL_SEC) }),
        ),
      })),
    }
    reply.status(200).send(payload)
  })

  route(app, "composeMail", { preHandler: csrfProtect, config: { rateLimit: ADMIN_OUTBOUND_MAIL_RATE_LIMIT } }, async (request, reply) => {
    const actorId = requireOperator(request)
    const body = parse(ComposeRequestSchema, request.body)
    await service().compose({ to: body.to, subject: body.subject, body: body.body }, actorId)
    sendOk(reply)
  })

  route(app, "replyMail", { preHandler: csrfProtect, config: { rateLimit: ADMIN_OUTBOUND_MAIL_RATE_LIMIT } }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(ReplyRequestSchema, request)
    await service().reply(id, { body: body.body }, actorId)
    sendOk(reply)
  })

  route(app, "markMailRead", { preHandler: csrfProtect }, async (request, reply) => {
    const { id } = parseBodyWithId(MarkMailReadRequestSchema, request)
    await service().markRead(id)
    sendOk(reply)
  })

  route(app, "setMailStatus", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(SetMailStatusRequestSchema, request)
    await service().setStatus(id, body.status, actorId)
    sendOk(reply)
  })

  route(app, "resendMail", { preHandler: csrfProtect, config: { rateLimit: ADMIN_OUTBOUND_MAIL_RATE_LIMIT } }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id } = parseBodyWithId(ResendRequestSchema, request)
    await service().resend(id, actorId)
    sendOk(reply)
  })
}

