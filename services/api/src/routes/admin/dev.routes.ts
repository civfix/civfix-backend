import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { registerDevFlagRoutes } from "./dev-flags.routes.js"
import { registerDevStatusRoutes } from "./dev-status.routes.js"
import { registerDevTestRoutes } from "./dev-test.routes.js"

/** The developer console. Registered in the operator scope, so every route here is operator only. */
export async function registerAdminDevRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  await registerDevFlagRoutes(app, container)
  await registerDevStatusRoutes(app, container)
  await registerDevTestRoutes(app, container)
}
