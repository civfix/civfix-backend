import { AppError } from "@civfix/contract"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { route } from "../../versioning/route.js"

/**
 * The overview, the jobs view and run now. Registered so every registry endpoint has a route; each
 * answers NOT_FOUND until its handler is built.
 */
export async function registerDevStatusRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect
  const notServed = async (): Promise<never> => {
    throw AppError.notFound()
  }

  route(app, "adminDevOverview", notServed)
  route(app, "adminDevJobs", notServed)
  route(app, "adminDevRunJob", { preHandler: csrfProtect }, notServed)
}
