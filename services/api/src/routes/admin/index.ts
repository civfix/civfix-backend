
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireOperatorPreHandler } from "../../auth/admin-guard.js"
import { registerAdminAuthRoutes } from "./auth.routes.js"
import { registerAdminHomeRoutes } from "./home.routes.js"
import { registerAdminDiscoveryRoutes } from "./discovery.routes.js"
import { registerAdminJurisdictionsRoutes } from "./jurisdictions.routes.js"
import { registerAdminReportsRoutes } from "./reports.routes.js"
import { registerAdminEventsRoutes } from "./events.routes.js"
import { registerAdminUsersRoutes } from "./users.routes.js"
import { registerAdminGovRoutes } from "./gov.routes.js"
import { registerAdminModerationRoutes } from "./moderation.routes.js"
import { registerAdminMailRoutes } from "./mail.routes.js"
import { registerAdminInboxRoutes } from "./inbox.routes.js"
import { registerAdminAnalyticsRoutes } from "./analytics.routes.js"
import { registerAdminActivityRoutes } from "./activity.routes.js"
import { registerAdminAuditRoutes } from "./audit.routes.js"
import { registerAdminSystemRoutes } from "./system.routes.js"
import { registerAdminOrgRoutes } from "./orgs.routes.js"
import { registerAdminBroadcastRoutes } from "./broadcasts.routes.js"
import { registerAdminEventPageRoutes } from "./pages.routes.js"
import { registerAdminMediaRoutes } from "./media.routes.js"
import { registerAdminLegalRoutes } from "./legal.routes.js"

export async function registerAdminRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  await registerAdminAuthRoutes(app, container)

  await app.register(async (operator) => {
    operator.addHook("preHandler", requireOperatorPreHandler)

    await registerAdminHomeRoutes(operator, container)
    await registerAdminDiscoveryRoutes(operator, container)
    await registerAdminJurisdictionsRoutes(operator, container)
    await registerAdminReportsRoutes(operator, container)
    await registerAdminEventsRoutes(operator, container)
    await registerAdminUsersRoutes(operator, container)
    await registerAdminGovRoutes(operator, container)
    await registerAdminModerationRoutes(operator, container)
    await registerAdminMailRoutes(operator, container)
    await registerAdminInboxRoutes(operator, container)
    await registerAdminAnalyticsRoutes(operator, container)
    await registerAdminActivityRoutes(operator, container)
    await registerAdminAuditRoutes(operator, container)
    await registerAdminSystemRoutes(operator, container)
    await registerAdminOrgRoutes(operator, container)
    await registerAdminBroadcastRoutes(operator, container)
    await registerAdminEventPageRoutes(operator, container)
    await registerAdminMediaRoutes(operator, container)
    await registerAdminLegalRoutes(operator, container)
  })
}
