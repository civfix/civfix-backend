/**
 * Route-level wiring for the notification pipeline (in-app row + push + user-channel signal).
 *
 * The identical repo/pushSender/userChannel/logger block was copy-pasted into every plugin that rings a
 * bell (notifications, social, cleanups), so a change to the notifier's dependencies meant finding every
 * copy. One builder instead. Built per call — the Drizzle repo is a thin wrapper over the lazily-created
 * `sql` tag, so this opens no connection until a handler actually notifies.
 */

import type { FastifyBaseLogger } from "fastify"
import type { Container } from "../di.js"
import { makeNotificationService, type NotificationService } from "./notification-service.js"
import { makeDrizzleNotificationRepository } from "./notification-repository.drizzle.js"

export function makeRouteNotificationService(
  container: Container,
  logger?: Pick<FastifyBaseLogger, "warn" | "error">,
): NotificationService {
  return makeNotificationService({
    repo: makeDrizzleNotificationRepository(container.getDb().sql),
    pushSender: container.pushSender,
    userChannel: container.userChannel,
    ...(logger !== undefined ? { logger } : {}),
  })
}
