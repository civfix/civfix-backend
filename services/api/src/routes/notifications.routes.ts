
import {
  PaginationQuerySchema,
  MarkReadRequestSchema,
  UpdateNotificationPrefsRequestSchema,
  RegisterPushTokenRequestSchema,
  type ListNotificationsResponse,
  type MarkReadResponse,
  type GetNotificationPrefsResponse,
  type NotificationPrefsDTO,
  type RegisterPushTokenResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { csrfProtect } from "../auth/csrf.js"
import {
  makeNotificationService,
  type NotificationRepository,
  type NotificationService,
} from "../services/notification-service.js"
import { makeDrizzleNotificationRepository } from "../services/notification-repository.drizzle.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"

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
            enum: [
              "report_update",
              "cleanup_chat",
              "cleanup_reminder",
              "cleanup_cancelled",
              "new_follower",
              "claim_available",
              "dm",
              "system",
              "report_chat",
            ],
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
  function repo(): NotificationRepository {
    const overrides = app.notificationOverrides
    if (overrides) return overrides.repo
    return makeDrizzleNotificationRepository(container.getDb().sql)
  }

  function service(): NotificationService {
    return makeNotificationService({
      repo: repo(),
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
    const body = parse(MarkReadRequestSchema, request.body)
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

  route(app, "registerPush", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const body = parse(RegisterPushTokenRequestSchema, request.body)
    const payload: RegisterPushTokenResponse = await service().registerPushToken(userId, body)
    reply.status(200).send(payload)
  })
}
