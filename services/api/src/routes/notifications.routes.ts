
import {
  PaginationQuerySchema,
  MarkReadRequestSchema,
  UpdateNotificationPrefsRequestSchema,
  RegisterPushTokenRequestSchema,
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
          // Derived from the contract, never hand-listed: the inline copy had already drifted seven types
          // behind @civfix/shared (group_chat, cleanup_role, the five post_* kinds).
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

  // An injected repo (tests) keeps the rest of the pipeline wired by hand; production shares the one
  // notifier wiring with social.routes / cleanups.routes.
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
    // H12: the shared contract types deviceId as a bare optional string. Normalize it against a tight
    // shape BEFORE it reaches the service, because the service uses it to key a destructive
    // cross-account write. A value that does not match is DROPPED (not rejected) — see normalizeDeviceId.
    const deviceId = normalizeDeviceId(body.deviceId)
    if (body.deviceId !== undefined && deviceId === undefined) {
      request.log.warn({ userId }, "registerPush: malformed deviceId dropped (device-claim skipped)")
    }
    // Destructure the raw value OUT before the spread: `{...body}` would otherwise carry the rejected
    // string straight through whenever the normalizer drops it, and the service persists
    // `req.deviceId ?? null` — so the gate has to remove the field, not merely fail to re-add it.
    const { deviceId: _raw, ...rest } = body
    const payload: RegisterPushTokenResponse = await service().registerPushToken(userId, {
      ...rest,
      ...(deviceId !== undefined ? { deviceId } : {}),
    })
    reply.status(200).send(payload)
  })
}

/**
 * H12 shape gate for `deviceId`.
 *
 * The field arrives from a JSON body as an unconstrained string in the shared contract, and the server
 * uses it as the key for a DESTRUCTIVE cross-account write (revoke other users' active tokens on "this
 * device"). Constraining it does not make it authoritative — the ownership check in
 * notification-service.ts is what does that — but it removes the trivially-abusable shapes: wildcards,
 * enormous values, and anything that is not the client-generated UUID the mobile app actually stores.
 *
 * DROP, don't reject: a malformed value returns `undefined` so the registration still succeeds without
 * the device-claim step. Rejecting would 422 older clients and silently cost them push entirely — the
 * exact failure mode H11 is about.
 */
export function normalizeDeviceId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const parsed = DeviceIdSchema.safeParse(raw.trim().toLowerCase())
  return parsed.success ? parsed.data : undefined
}

const DeviceIdSchema = z.string().uuid()
