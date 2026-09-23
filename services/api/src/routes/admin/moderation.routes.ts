import {
  ApproveModerationRequestSchema,
  AppealModerationRequestSchema,
  HoldModerationRequestSchema,
  ModerationListQuerySchema,
  RemoveModerationRequestSchema,
  type GetModerationItemResponse,
  type ModerationListResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireOperator } from "../../auth/admin-guard.js"
import { route } from "../../versioning/route.js"
import {
  idParam,
  makeContainerMessageUpdateAnnouncer,
  overridableService,
  parse,
  parseBodyWithId,
  sendOk,
  spreadNow,
} from "./_route-utils.js"
import {
  makeModerationService,
  type ModerationRepository,
  type ModerationSessionControl,
} from "../../services/admin/moderation-service.js"
import { makeDrizzleModerationRepository } from "../../services/admin/moderation-repository.drizzle.js"
import { makeContainerReportChatEmitter } from "../../services/report-chat-emitter.js"
import { makePrivateMediaPresigner, type PresignMedia } from "../../services/media-presign.js"
import type { ReportChatSystemEmitter } from "../../services/report-timeline-event.js"

export interface ModerationRouteOverrides {
  repo: ModerationRepository
  presignMedia?: PresignMedia
  now?: () => Date
  reportChatEmitter?: ReportChatSystemEmitter
  sessions?: ModerationSessionControl
}

declare module "fastify" {
  interface FastifyInstance {
    moderationOverrides?: ModerationRouteOverrides
  }
}

export async function registerAdminModerationRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  const service = overridableService(
    app,
    "moderationOverrides",
    (overrides) =>
      makeModerationService({
        repo: overrides.repo,
        ...(overrides.presignMedia !== undefined ? { presignMedia: overrides.presignMedia } : {}),
        ...spreadNow(overrides),
        ...(overrides.reportChatEmitter !== undefined
          ? { reportChatEmitter: overrides.reportChatEmitter }
          : {}),
        ...(overrides.sessions !== undefined ? { sessions: overrides.sessions } : {}),
      }),
    () => {
      const repo: ModerationRepository = makeDrizzleModerationRepository(container.getDb().sql)
      return makeModerationService({
        repo,
        presignMedia: makePrivateMediaPresigner(container.storage),
        reportChatEmitter: makeContainerReportChatEmitter(container, app.log),
        sessions: {
          applyStatus: (userId, status) =>
            app.authServices.sessions.applyAccountStatus(userId, status),
        },
        announceMessageUpdate: makeContainerMessageUpdateAnnouncer(container, app.log),
      })
    },
  )

  route(app, "listModeration", async (request, reply) => {
    const query = parse(ModerationListQuerySchema, request.query)
    const payload: ModerationListResponse = await service().list(query)
    reply.status(200).send(payload)
  })

  route(app, "getModerationItem", async (request, reply) => {
    const { id } = idParam(request)
    const payload: GetModerationItemResponse = await service().getItem(id)
    reply.status(200).send(payload)
  })

  route(app, "approveModeration", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(ApproveModerationRequestSchema, request)
    await service().approve(id, { actorId, note: body.note ?? null })
    sendOk(reply)
  })

  route(app, "removeModeration", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(RemoveModerationRequestSchema, request)
    await service().remove(id, { actorId, reason: body.reason ?? null })
    sendOk(reply)
  })

  route(app, "holdModeration", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(HoldModerationRequestSchema, request)
    await service().hold(id, { actorId, note: body.note ?? null })
    sendOk(reply)
  })

  route(app, "appealModeration", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireOperator(request)
    const { id, body } = parseBodyWithId(AppealModerationRequestSchema, request)
    await service().appeal(id, { decision: body.decision, actorId, note: body.note ?? null })
    sendOk(reply)
  })
}
