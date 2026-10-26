import { AppError } from "@civfix/contract"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { route } from "../../versioning/route.js"
import type { Jobs } from "@civfix/seams"
import type { WriteAuditInput } from "../../services/admin/audit.js"
import type { DevJobsRepository } from "../../services/admin/dev-jobs-repository.js"

export interface DevStatusRouteOverrides {
  repo: DevJobsRepository
  jobs: Jobs
  audit: (input: WriteAuditInput) => Promise<void>
  now?: () => Date
}

declare module "fastify" {
  interface FastifyInstance {
    devStatusOverrides?: DevStatusRouteOverrides
  }
}

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
