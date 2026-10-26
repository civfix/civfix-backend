import { createRequire } from "node:module"
import type {
  AdminDevJobsResponse,
  AdminDevOverviewResponse,
  AdminDevRunJobResponse,
} from "@civfix/contract"
import type { Jobs } from "@civfix/seams"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../di.js"
import { requireOperator } from "../../auth/admin-guard.js"
import { perIdentity } from "../../plugins/rate-limit.js"
import { insertAuditRow } from "../../services/admin/audit-repository.drizzle.js"
import type { WriteAuditInput } from "../../services/admin/audit.js"
import type { DevJobsRepository } from "../../services/admin/dev-jobs-repository.js"
import { makeDrizzleDevJobsRepository } from "../../services/admin/dev-jobs-repository.drizzle.js"
import { makeDevJobsService, type DevJobsService } from "../../services/admin/dev-jobs-service.js"
import {
  makeDevOverviewService,
  type DevOverviewService,
} from "../../services/admin/dev-overview-service.js"
import { SERVICE_VERSION } from "../../version.js"
import { route } from "../../versioning/route.js"

/** Read once at boot: the contract version this API was built and deployed with. */
const CONTRACT_VERSION = (
  createRequire(import.meta.url)("@civfix/contract/package.json") as { version: string }
).version

const API_STARTED_AT = new Date(performance.timeOrigin)

const ADMIN_DEV_RUN_JOB_RATE_LIMIT = perIdentity({
  max: 10,
  timeWindow: "1 minute",
  skipOnError: false,
})

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

interface DevStatusServices {
  jobs: DevJobsService
  overview: DevOverviewService
}

export async function registerDevStatusRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect
  const env = container.env

  function build(deps: DevStatusRouteOverrides): DevStatusServices {
    const jobs = makeDevJobsService({ ...deps, jobsIsFake: env.USE_FAKE_JOBS })
    const overview = makeDevOverviewService({
      env,
      serviceVersion: SERVICE_VERSION,
      startedAt: API_STARTED_AT,
      contractVersion: CONTRACT_VERSION,
      nodeVersion: process.version,
      jobs,
    })
    return { jobs, overview }
  }

  // Built once per process (per override set in tests), so the jobs view's 30-second cache holds.
  let built: { from: DevStatusRouteOverrides | undefined; services: DevStatusServices } | null =
    null
  function services(): DevStatusServices {
    const overrides = app.devStatusOverrides
    if (built !== null && built.from === overrides) return built.services
    const services = build(
      overrides ?? {
        // Resolved per read: with fake jobs nothing reads pg-boss, and a run may have no database.
        repo: {
          snapshot: (names) => makeDrizzleDevJobsRepository(container.getDb().sql).snapshot(names),
          runState: (name) => makeDrizzleDevJobsRepository(container.getDb().sql).runState(name),
        },
        jobs: container.jobs,
        audit: async (input) => {
          await insertAuditRow(container.getDb().sql, input)
        },
      },
    )
    built = { from: overrides, services }
    return services
  }

  route(app, "adminDevOverview", async (_request, reply) => {
    const payload: AdminDevOverviewResponse = await services().overview.overview()
    reply.status(200).send(payload)
  })

  route(app, "adminDevJobs", async (_request, reply) => {
    const payload: AdminDevJobsResponse = await services().jobs.view()
    reply.status(200).send(payload)
  })

  route(
    app,
    "adminDevRunJob",
    { preHandler: csrfProtect, config: { rateLimit: ADMIN_DEV_RUN_JOB_RATE_LIMIT } },
    async (request, reply) => {
      const actorId = requireOperator(request)
      const { name } = request.params as { name: string }
      const payload: AdminDevRunJobResponse = await services().jobs.runNow(name, actorId)
      reply.status(200).send(payload)
    },
  )
}
