/**
 * Route registration root — wiring only, one plugin per domain. Each plugin is
 * `(app, container) => Promise<void>`. Health stays first. The auth + admin routes mount only when an
 * auth service bundle is present (see server.ts): the no-infra all-fakes boot has no Pg/Redis-backed
 * services to serve them.
 */

import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { registerHealthRoutes } from "./health.routes.js"
import { registerAuthRoutes } from "./auth.routes.js"
import { registerMapRoutes } from "./map.routes.js"
import { registerMediaRoutes } from "./media.routes.js"
import { registerReportRoutes } from "./reports.routes.js"
import { registerDiscussionRoutes } from "./discussion.routes.js"
import { registerAnonRoutes } from "./anon.routes.js"
import { registerClaimRoutes } from "./claim.routes.js"
import { registerCleanupRoutes } from "./cleanups.routes.js"
import { registerChatRoutes } from "./chat.routes.js"
import { registerDmRoutes } from "./dm.routes.js"
import { registerUsersRoutes } from "./users.routes.js"
import { registerReportContentRoutes } from "./report-content.routes.js"
import { registerSocialRoutes } from "./social.routes.js"
import { registerVerificationRoutes } from "./verification.routes.js"
import { registerNotificationRoutes } from "./notifications.routes.js"
import { registerAdminRoutes } from "./admin/index.js"
import { registerInboundMailWebhook } from "./webhooks/inbound-mail.routes.js"

export interface RegisterRoutesOptions {
  /** Whether an auth service bundle is available; gates mounting the auth routes. */
  authMounted?: boolean
}

export async function registerRoutes(
  app: FastifyInstance,
  container: Container,
  opts: RegisterRoutesOptions = {},
): Promise<void> {
  await registerHealthRoutes(app, container)

  // Auth routes mount only with the auth bundle (see the file header).
  if (opts.authMounted) {
    await registerAuthRoutes(app, container)
  }

  // Anon-ok domains mount unconditionally; DB-backed handlers reach the DB lazily via container.getDb()
  // only when hit, and auth-gated writes 401/403 cleanly with no infra.
  await registerMapRoutes(app, container)
  await registerMediaRoutes(app, container)
  await registerReportRoutes(app, container)
  await registerDiscussionRoutes(app, container)
  await registerAnonRoutes(app, container)
  await registerClaimRoutes(app, container)
  await registerCleanupRoutes(app, container)
  await registerChatRoutes(app, container)
  await registerDmRoutes(app, container)
  await registerUsersRoutes(app, container)
  await registerReportContentRoutes(app, container)
  await registerSocialRoutes(app, container)
  await registerVerificationRoutes(app, container)
  await registerNotificationRoutes(app, container)

  // Admin dashboard: gated on the auth bundle (operator sign-in reuses the same Pg/Redis-backed
  // OtpService/SessionService, which only exist when the bundle is mounted).
  if (opts.authMounted) {
    await registerAdminRoutes(app, container)
  }

  // SECURITY: the inbound-mail webhook mounts UNCONDITIONALLY (it needs no auth bundle) and authenticates
  // by CF_EMAIL_WEBHOOK_SECRET inside the handler, refusing every call when the secret is unconfigured.
  await registerInboundMailWebhook(app, container)
}
