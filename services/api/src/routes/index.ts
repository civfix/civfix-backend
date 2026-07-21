
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { registerHealthRoutes } from "./health.routes.js"
import { registerAuthRoutes } from "./auth.routes.js"
import { registerMapRoutes } from "./map.routes.js"
import { registerMediaRoutes } from "./media.routes.js"
import { registerReportRoutes } from "./reports.routes.js"
import { registerAnonRoutes } from "./anon.routes.js"
import { registerClaimRoutes } from "./claim.routes.js"
import { registerCleanupRoutes } from "./cleanups.routes.js"
import { registerChatRoutes } from "./chat.routes.js"
import { registerChatGroupRoutes } from "./chat-groups.routes.js"
import { registerReportChatRoutes } from "./report-chat.routes.js"
import { registerDmRoutes } from "./dm.routes.js"
import { registerMessagesRoutes } from "./messages.routes.js"
import { registerUsersRoutes } from "./users.routes.js"
import { registerReportContentRoutes } from "./report-content.routes.js"
import { registerSocialRoutes } from "./social.routes.js"
import { registerPostRoutes } from "./posts.routes.js"
import { registerVolunteerHoursRoutes } from "./volunteer-hours.routes.js"
import { registerVerificationRoutes } from "./verification.routes.js"
import { registerNotificationRoutes } from "./notifications.routes.js"
import { registerConversationRoutes } from "./conversations.routes.js"
import { registerAdminRoutes } from "./admin/index.js"
import { registerInboundMailWebhook } from "./webhooks/inbound-mail.routes.js"

export interface RegisterRoutesOptions {
  authMounted?: boolean
}

export async function registerRoutes(
  app: FastifyInstance,
  container: Container,
  opts: RegisterRoutesOptions = {},
): Promise<void> {
  await registerHealthRoutes(app, container)

  if (opts.authMounted) {
    await registerAuthRoutes(app, container)
  }

  await registerMapRoutes(app, container)
  await registerMediaRoutes(app, container)
  await registerReportRoutes(app, container)
  await registerAnonRoutes(app, container)
  await registerClaimRoutes(app, container)
  await registerCleanupRoutes(app, container)
  await registerChatRoutes(app, container)
  await registerChatGroupRoutes(app, container)
  await registerReportChatRoutes(app, container)
  await registerDmRoutes(app, container)
  await registerMessagesRoutes(app, container)
  await registerUsersRoutes(app, container)
  await registerReportContentRoutes(app, container)
  await registerSocialRoutes(app, container)
  await registerPostRoutes(app, container)
  await registerVolunteerHoursRoutes(app, container)
  await registerVerificationRoutes(app, container)
  await registerNotificationRoutes(app, container)
  await registerConversationRoutes(app, container)

  if (opts.authMounted) {
    await registerAdminRoutes(app, container)
  }

  await registerInboundMailWebhook(app, container)
}
