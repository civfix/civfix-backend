import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { makeHostRouteContext } from "./_host-routes.js"
import { registerHostAnalyticsRoutes } from "./analytics.routes.js"
import { registerHostAnnouncementRoutes } from "./announcements.routes.js"
import { registerHostBroadcastRoutes } from "./broadcasts.routes.js"
import { registerHostCheckinRoutes } from "./checkin.routes.js"
import { registerHostExportRoutes } from "./exports.routes.js"
import { registerHostOrgRoutes } from "./orgs.routes.js"
import { registerPageViewRoutes } from "./page-views.routes.js"
import { registerHostPageRoutes } from "./pages.routes.js"
import { registerHostPortfolioRoutes } from "./portfolio.routes.js"
import { registerHostQuestionRoutes } from "./questions.routes.js"
import { registerHostRegistrationRoutes } from "./registrations.routes.js"
import { registerHostTeamRoutes } from "./team.routes.js"
import { registerHostTicketRoutes } from "./tickets.routes.js"
import { registerUnsubscribeRoutes } from "./unsubscribe.routes.js"
import { registerHostWaitlistRoutes } from "./waitlist.routes.js"

export async function registerHostSurface(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  await registerHostOrgRoutes(app, container)
  await registerHostTeamRoutes(app, container)
  await registerHostPortfolioRoutes(app, container)

  const ctx = makeHostRouteContext(app, container)
  registerHostTicketRoutes(app, container, ctx)
  registerHostQuestionRoutes(app, container, ctx)
  registerHostRegistrationRoutes(app, container, ctx)
  registerHostWaitlistRoutes(app, container, ctx)
  registerHostCheckinRoutes(app, container, ctx)
  registerHostPageRoutes(app, container, ctx)
}

export async function registerHostCommsRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  await registerHostBroadcastRoutes(app, container)
  await registerHostAnnouncementRoutes(app, container)
  await registerHostAnalyticsRoutes(app, container)
  await registerHostExportRoutes(app, container)
}

export async function registerPublicHostCommsRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  await registerUnsubscribeRoutes(app, container)
  await registerPageViewRoutes(app, container)
}
