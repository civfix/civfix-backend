// Notifications route plugin.
//
//   GET  /notifications        [auth]       caller's notifications, newest-first -> ListNotificationsResponse
//   POST /notifications/read   [auth][csrf] mark notifications read (own only)   -> MarkReadResponse
//   GET  /notifications/prefs  [auth]       caller's prefs (default-created)      -> GetNotificationPrefsResponse
//   PUT  /notifications/prefs  [auth][csrf] update prefs (partial)               -> NotificationPrefsDTO
//   POST /push/register        [auth][csrf] register a device push token         -> RegisterPushTokenResponse
//
// The DB handle + push seam are reached lazily inside handlers (via container) so merely mounting the
// plugin opens no connection. The service is built per request from either an injected override (tests:
// an in-memory repo + FakePushSender so the whole flow runs offline) or from the container (production:
// the Drizzle repo + the selected push seam).

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

// Response JSON schema for the feed list, so the per-user array serializes via fast-json-stringify rather
// than slow JSON.stringify. Mirrors ListNotificationsResponseSchema / NotificationDTOSchema; the type/
// nullable shapes match the shared DTO. fast-json-stringify DROPS any property not declared here, so the
// optional body/link MUST be listed for them to reach the wire (they are NOT in `required`, preserving
// the prior {id,type,title,read,createdAt} contract).
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

// Optional injected notification-service dependencies (tests): the routes build the service from these
// instead of the container, so the whole list/read/prefs/register HTTP flow runs offline. Unset in
// production, where the routes build the Drizzle repo + the container push seam lazily.
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
