import type { FastifyBaseLogger } from "fastify"
import type { Container } from "../di.js"
import { makeNotificationService, type NotificationService } from "./notification-service.js"
import { makeDrizzleNotificationRepository } from "./notification-repository.drizzle.js"

/**
 * Built per call: the Drizzle repo is a thin wrapper over the lazily-created `sql` tag, so this opens
 * no connection until a handler actually notifies.
 */
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
