/**
 * Route registration root.
 *
 * EXTENSION POINT for later domain steps: register your route plugin here, one line per domain.
 * Each plugin is `(app, container) => Promise<void>` and should register under its own prefix.
 *
 * Example (a later step adds reports):
 *   import { registerReportRoutes } from "./reports.routes.js"
 *   await registerReportRoutes(app, container)
 *
 * Keep health first. Do not put domain logic in this file; it is wiring only.
 */

import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { registerHealthRoutes } from "./health.routes.js"

export async function registerRoutes(app: FastifyInstance, container: Container): Promise<void> {
  await registerHealthRoutes(app, container)

  // <-- later domain steps append their route registrations below, e.g.:
  // await registerAuthRoutes(app, container)
  // await registerReportRoutes(app, container)
  // await registerCleanupRoutes(app, container)
}
