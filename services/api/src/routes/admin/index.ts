/**
 * Admin / operator route group.
 *
 *   - The admin AUTH routes (/admin/auth/*) are registered UNGUARDED: they establish the operator
 *     session, so they cannot sit behind the requireOperator guard.
 *   - Every admin DATA router is registered inside ONE encapsulated Fastify child context carrying a
 *     single requireOperator `preHandler`. A hook added to a registered (encapsulated) instance runs for
 *     every route declared in it, so the guard applies to EVERY admin data route deny-by-default without
 *     each route repeating it.
 *
 * Per-route CSRF on state-changing mutations is still declared in the domain files (csrfProtect as a
 * route preHandler), so a mutation runs [requireOperator (scope hook)] then [csrfProtect (route)].
 */

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

export async function registerAdminRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  // Operator auth (public: establishes the session). NOT guarded.
  await registerAdminAuthRoutes(app, container)

  // All data routers, encapsulated under the requireOperator guard. The hook is added to the child
  // instance only, so it does NOT leak onto the parent app's non-admin routes.
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
  })
}
