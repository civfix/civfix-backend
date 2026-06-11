/**
 * Notifications route plugin.
 *
 *   GET  /notifications        [auth]       the caller's notifications, newest-first -> ListNotificationsResponse.
 *   POST /notifications/read   [auth][csrf] mark notifications read (own only) -> MarkReadResponse.
 *   GET  /notifications/prefs  [auth]       the caller's prefs (default-created) -> GetNotificationPrefsResponse.
 *   PUT  /notifications/prefs  [auth][csrf] update prefs (partial) -> NotificationPrefsDTO.
 *   POST /push/register        [auth][csrf] register a device push token -> RegisterPushTokenResponse.
 *
 * Bodies/params/queries are validated against the @civfix/shared Zod schemas via the same `parse` ->
 * AppError.validation pattern as the other routes. The DB handle + the push seam are reached lazily inside
 * handlers (via container) so merely mounting the plugin opens no connection.
 *
 * The notification service is built per request from either an injected override (tests: an in-memory repo
 * + the FakePushSender so the whole flow runs offline) or from the container (production: the Drizzle repo
 * + the real/selected push seam). registerPushToken persists the token AND delegates to PushSender; the
 * prefs/read/list endpoints operate purely over the repo.
 */

import {
  PaginationQuerySchema,
  MarkReadRequestSchema,
  UpdateNotificationPrefsRequestSchema,
  RegisterPushTokenRequestSchema,
  AppError,
  type ListNotificationsResponse,
  type MarkReadResponse,
  type GetNotificationPrefsResponse,
  type NotificationPrefsDTO,
  type RegisterPushTokenResponse,
} from "@civfix/shared"
import { ZodError, type z, type ZodTypeAny } from "zod"
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

/**
 * Optional injected notification-service dependencies (tests). When present the routes build the service
 * from these instead of the container, so the whole list/read/prefs/register HTTP flow runs offline (no
 * Docker). The push seam defaults to the container's (the FakePushSender in test). In production it is left
 * unset and the routes build the Drizzle-backed repo + the container push seam lazily.
 */
export interface NotificationServiceOverrides {
  repo: NotificationRepository
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected notification-service overrides (tests). See NotificationServiceOverrides. */
    notificationOverrides?: NotificationServiceOverrides
  }
}

export async function registerNotificationRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the notification repository from injected overrides (tests) or the container DB (production). */
  function repo(): NotificationRepository {
    const overrides = app.notificationOverrides
    if (overrides) return overrides.repo
    return makeDrizzleNotificationRepository(container.getDb().sql)
  }

  /** Build the notification service over the resolved repo + the container's push seam. */
  function service(): NotificationService {
    return makeNotificationService({
      repo: repo(),
      pushSender: container.pushSender,
      logger: app.log,
    })
  }

  // -------------------------------------------------------------------------
  // GET /notifications  [auth]
  // -------------------------------------------------------------------------
  route(app, "listNotifications", async (request, reply) => {
    const userId = requireAuth(request)
    const pagination = parse(PaginationQuerySchema, request.query)
    const payload: ListNotificationsResponse = await service().listNotifications(userId, pagination)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /notifications/read  [auth][csrf]
  // -------------------------------------------------------------------------
  route(app, "markNotificationsRead", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const body = parse(MarkReadRequestSchema, request.body)
    const payload: MarkReadResponse = await service().markRead(userId, body.ids)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /notifications/prefs  [auth]
  // -------------------------------------------------------------------------
  route(app, "getNotificationPrefs", async (request, reply) => {
    const userId = requireAuth(request)
    const payload: GetNotificationPrefsResponse = await service().getPrefs(userId)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // PUT /notifications/prefs  [auth][csrf]
  // -------------------------------------------------------------------------
  route(app, "updateNotificationPrefs", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const body = parse(UpdateNotificationPrefsRequestSchema, request.body)
    const payload: NotificationPrefsDTO = await service().updatePrefs(userId, body)
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /push/register  [auth][csrf]
  // -------------------------------------------------------------------------
  route(app, "registerPush", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const body = parse(RegisterPushTokenRequestSchema, request.body)
    const payload: RegisterPushTokenResponse = await service().registerPushToken(userId, body)
    reply.status(200).send(payload)
  })
}

/**
 * Validate `data` against a Zod schema, throwing AppError.validation (422 with field details) on
 * failure so the canonical envelope is returned instead of a generic 500. Mirrors the other routes.
 */
function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  try {
    return schema.parse(data)
  } catch (err) {
    if (err instanceof ZodError) {
      const fields: Record<string, string> = {}
      for (const issue of err.issues) {
        const key = issue.path.length > 0 ? issue.path.join(".") : "_"
        fields[key] = issue.message
      }
      throw AppError.validation(fields)
    }
    throw err
  }
}
