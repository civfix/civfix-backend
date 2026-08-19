
import {
  PaginationQuerySchema,
  MarkReadRequestSchema,
  UpdateNotificationPrefsRequestSchema,
  RegisterPushTokenRequestSchema,
  UnregisterPushTokenRequestSchema,
  NotificationTypeSchema,
  type ListNotificationsResponse,
  type MarkReadResponse,
  type GetNotificationPrefsResponse,
  type NotificationPrefsDTO,
  type RegisterPushTokenResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import {
  makeNotificationService,
  type NotificationRepository,
  type NotificationService,
} from "../services/notification-service.js"
import { makeRouteNotificationService } from "../services/route-notifier.js"
import { perIdentity } from "../plugins/rate-limit.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"

export const MARK_NOTIFICATIONS_READ_MAX_IDS = 200

export const PUSH_TOKEN_RATE_LIMIT = perIdentity({ max: 10, timeWindow: "1 minute" })

export const MarkNotificationsReadBodySchema = MarkReadRequestSchema.extend({
  ids: MarkReadRequestSchema.shape.ids.max(MARK_NOTIFICATIONS_READ_MAX_IDS),
})

const ListNotificationsResponseJsonSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          type: {
            type: "string",
            enum: [...NotificationTypeSchema.options],
          },
          title: { type: "string" },
          body: { type: "string", nullable: true },
          read: { type: "boolean" },
          createdAt: { type: "string" },
          link: { type: "string", nullable: true },
        },
        required: ["id", "type", "title", "read", "createdAt"],
      },
    },
    nextCursor: { type: "string", nullable: true },
  },
  required: ["items", "nextCursor"],
} as const

export interface NotificationServiceOverrides {
  repo: NotificationRepository
}

declare module "fastify" {
  interface FastifyInstance {
    notificationOverrides?: NotificationServiceOverrides
  }
}

export async function registerNotificationRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  function service(): NotificationService {
    const overrides = app.notificationOverrides
    if (!overrides) return makeRouteNotificationService(container, app.log)
    return makeNotificationService({
      repo: overrides.repo,
      pushSender: container.pushSender,
      userChannel: container.userChannel,
      logger: app.log,
    })
  }

  route(
    app,
    "listNotifications",
    { schema: { response: { 200: ListNotificationsResponseJsonSchema } } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const pagination = parse(PaginationQuerySchema, request.query)
      const payload: ListNotificationsResponse = await service().listNotifications(userId, pagination)
      reply.status(200).send(payload)
    },
  )

  route(app, "markNotificationsRead", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const body = parse(MarkNotificationsReadBodySchema, request.body)
    const payload: MarkReadResponse = await service().markRead(userId, body.ids)
    reply.status(200).send(payload)
  })

  route(app, "getNotificationPrefs", async (request, reply) => {
    const userId = requireAuth(request)
    const payload: GetNotificationPrefsResponse = await service().getPrefs(userId)
    reply.status(200).send(payload)
  })

  route(app, "updateNotificationPrefs", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const body = parse(UpdateNotificationPrefsRequestSchema, request.body)
    const payload: NotificationPrefsDTO = await service().updatePrefs(userId, body)
    reply.status(200).send(payload)
  })

  route(
    app,
    "registerPush",
    { preHandler: csrfProtect, config: { rateLimit: PUSH_TOKEN_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(RegisterPushTokenRequestSchema, request.body)
      const deviceId = normalizeDeviceId(body.deviceId)
      if (body.deviceId !== undefined && deviceId === undefined) {
        request.log.warn({ userId }, "registerPush: malformed deviceId dropped (device-claim skipped)")
      }
      const { deviceId: _raw, ...rest } = body
      const payload: RegisterPushTokenResponse = await service().registerPushToken(userId, {
        ...rest,
        ...(deviceId !== undefined ? { deviceId } : {}),
      })
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "pushUnregister",
    { preHandler: csrfProtect, config: { rateLimit: PUSH_TOKEN_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(UnregisterPushTokenRequestSchema, request.body)
      const payload: RegisterPushTokenResponse = await service().unregisterPushToken(userId, body)
      reply.status(200).send(payload)
    },
  )
}

export function normalizeDeviceId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const parsed = DeviceIdSchema.safeParse(raw.trim().toLowerCase())
  return parsed.success ? parsed.data : undefined
}

const DeviceIdSchema = z.string().uuid()
