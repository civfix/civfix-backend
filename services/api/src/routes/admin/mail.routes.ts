import {
  ComposeRequestSchema,
  MailListQuerySchema,
  MarkMailReadRequestSchema,
  PreviewForwardTemplateRequestSchema,
  PublishMailReplyRequestSchema,
  ReplyRequestSchema,
  ResendRequestSchema,
  SetForwardTemplateDefaultRequestSchema,
  SetMailStatusRequestSchema,
  type ForwardTemplateSettingsDTO,
  type MailDirection,
  type MailListResponse,
  type MailStatsResponse,
  type MailThreadDTO,
  type PreviewForwardTemplateResponse,
  type PublishMailReplyResponse,
} from "@civfix/shared"
import type { Storage } from "@civfix/shared/interfaces"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { route } from "../../versioning/route.js"
import {
  idParam,
  overridableService,
  parse,
  parseBodyWithId,
  sendOk,
  twoIdParams,
} from "./_route-utils.js"
import { auditRead } from "./_audit-read.js"
import { requireOperator } from "../../auth/admin-guard.js"
import { perIdentity } from "../../plugins/rate-limit.js"
import { MEDIA_GET_URL_TTL_SEC } from "../../services/media-intake-service.js"
import { PRESIGN_CONCURRENCY } from "../../services/media-presign.js"
import { mapWithLimit } from "../../lib/concurrency.js"
import { makeMailService } from "../../services/admin/mail-service.js"
import {
  makeContainerOutboundMailService,
  type OutboundMailService,
} from "../../services/admin/outbound-mail-service.js"
import {
  makeDrizzleMailRepository,
  type MailRepository,
} from "../../services/admin/mail-repository.drizzle.js"
import { makeDrizzleForwardTemplateRepository } from "../../services/admin/forward-template-repository.drizzle.js"
import {
  makeForwardTemplateService,
  type ForwardTemplateService,
} from "../../services/admin/forward-template-service.js"
import type { ForwardTemplateRepository } from "../../services/admin/forward-template-repository.js"
import {
  applyInboundEffects,
  type InboundEffectDeps,
} from "../../services/admin/inbound-thread-correlation.js"
import {
  makeMailReplyPublishService,
  type MailReplyPublishService,
} from "../../services/admin/mail-reply-publish-service.js"

export const ADMIN_OUTBOUND_MAIL_RATE_LIMIT = perIdentity({
  max: 20,
  timeWindow: "1 minute",
  skipOnError: false,
})

export const ADMIN_MAIL_REPLY_PUBLISH_RATE_LIMIT = perIdentity({
  max: 20,
  timeWindow: "1 minute",
  skipOnError: false,
})

const MAX_MAIL_THREAD_ATTACHMENTS = 50

export async function presignThreadAttachments(
  dto: MailThreadDTO,
  stores: Record<MailDirection, Storage>,
): Promise<MailThreadDTO> {
  return {
    ...dto,
    messages: await mapWithLimit(dto.messages, PRESIGN_CONCURRENCY, async (msg) => ({
      ...msg,
      attachments: await mapWithLimit(
        msg.attachments.slice(0, MAX_MAIL_THREAD_ATTACHMENTS),
        PRESIGN_CONCURRENCY,
        async (att) => ({
          ...att,
          key: await stores[msg.dir].presignGet(att.key, MEDIA_GET_URL_TTL_SEC),
        }),
      ),
    })),
  }
}

export interface AdminMailRouteOverrides {
  repo: MailRepository
  outboundMail: OutboundMailService
  storage?: Storage
  forwardTemplates?: ForwardTemplateRepository
  outboundStorage?: Storage
  inboundEffects?: InboundEffectDeps
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
      }),
    () => {
      const sql = container.getDb().sql
      const repo: MailRepository = makeDrizzleMailRepository(sql)
      const outboundMail = makeContainerOutboundMailService(container, { repo, logger: app.log })
      return makeMailService({
        repo,
        outboundMail,
      })
    },
  )

  const publishService = overridableService(
    app,
    "adminMailOverrides",
    (overrides): MailReplyPublishService =>
      makeMailReplyPublishService({
        repo: overrides.repo,
        applyEffects: (thread, message, publishedBy) => {
          const effects = overrides.inboundEffects ?? {}
          return applyInboundEffects(container, effects, overrides.repo, thread, message, {
            publishedBy,
          })
        },
        logger: app.log,
      }),
    () => {
      const repo = makeDrizzleMailRepository(container.getDb().sql)
      return makeMailReplyPublishService({
        repo,
        applyEffects: (thread, message, publishedBy) =>
          applyInboundEffects(container, { logger: app.log }, repo, thread, message, {
            publishedBy,
          }),
        logger: app.log,
      })
    },
  )

  function templateService(): ForwardTemplateService {
    const overrides = app.adminMailOverrides?.forwardTemplates
    const repo = overrides ?? makeDrizzleForwardTemplateRepository(container.getDb().sql)
    return makeForwardTemplateService({ repo })
  }

  function storage(): Storage {
    return app.adminMailOverrides?.storage ?? container.inboundStorage
  }

  function outboundStorage(): Storage {
    return app.adminMailOverrides?.outboundStorage ?? container.storage
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
    const payload: MailThreadDTO = await presignThreadAttachments(dto, {
      in: storage(),
      out: outboundStorage(),
    })
    reply.status(200).send(payload)
  })

  route(
    app,
    "composeMail",
    { preHandler: csrfProtect, config: { rateLimit: ADMIN_OUTBOUND_MAIL_RATE_LIMIT } },
    async (request, reply) => {
      const actorId = requireOperator(request)
      const body = parse(ComposeRequestSchema, request.body)
      await service().compose({ to: body.to, subject: body.subject, body: body.body }, actorId)
      sendOk(reply)
    },
  )

  route(
    app,
    "replyMail",
    { preHandler: csrfProtect, config: { rateLimit: ADMIN_OUTBOUND_MAIL_RATE_LIMIT } },
    async (request, reply) => {
      const actorId = requireOperator(request)
      const { id, body } = parseBodyWithId(ReplyRequestSchema, request)
      await service().reply(id, { body: body.body }, actorId)
      sendOk(reply)
    },
  )

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

  route(
    app,
    "resendMail",
    { preHandler: csrfProtect, config: { rateLimit: ADMIN_OUTBOUND_MAIL_RATE_LIMIT } },
    async (request, reply) => {
      const actorId = requireOperator(request)
      const { id } = parseBodyWithId(ResendRequestSchema, request)
      await service().resend(id, actorId)
      sendOk(reply)
    },
  )

  route(
    app,
    "publishMailReply",
    { preHandler: csrfProtect, config: { rateLimit: ADMIN_MAIL_REPLY_PUBLISH_RATE_LIMIT } },
    async (request, reply) => {
      const actorId = requireOperator(request)
      const { id, messageId } = twoIdParams(request, "messageId")
      parse(PublishMailReplyRequestSchema, { ...(request.body as object), id, messageId })
      const payload: PublishMailReplyResponse = await publishService().publish({
        threadId: id,
        messageId,
        actorId,
      })
      reply.status(200).send(payload)
    },
  )

  route(app, "getForwardTemplateDefault", async (_request, reply) => {
    const payload: ForwardTemplateSettingsDTO = await templateService().get()
    reply.status(200).send(payload)
  })

  route(
    app,
    "setForwardTemplateDefault",
    { preHandler: csrfProtect, config: { rateLimit: ADMIN_OUTBOUND_MAIL_RATE_LIMIT } },
    async (request, reply) => {
      const actorId = requireOperator(request)
      const body = parse(SetForwardTemplateDefaultRequestSchema, request.body)
      const payload: ForwardTemplateSettingsDTO = await templateService().set(body, actorId)
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "previewForwardTemplate",
    { preHandler: csrfProtect, config: { rateLimit: ADMIN_OUTBOUND_MAIL_RATE_LIMIT } },
    async (request, reply) => {
      const body = parse(PreviewForwardTemplateRequestSchema, request.body)
      const payload: PreviewForwardTemplateResponse = await templateService().preview(body)
      reply.status(200).send(payload)
    },
  )
}
