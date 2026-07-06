
import Fastify, { type FastifyInstance } from "fastify"
import { loadEnv, type Env } from "./env.js"
import { buildContainer, type Container } from "./di.js"
import { makeErrorHandler, makeNotFoundHandler } from "./errors/http-mapper.js"
import { initErrorReporting, flushErrorReporting } from "./errors/glitchtip.js"
import { genReqId, registerRequestId } from "./plugins/request-id.js"
import { registerCors } from "./plugins/cors.js"
import { registerHelmet } from "./plugins/helmet.js"
import { registerCookie } from "./plugins/cookie.js"
import { registerRateLimit } from "./plugins/rate-limit.js"
import { registerVersionGate } from "./versioning/version-gate.js"
import { registerAuthContext } from "./auth/context.js"
import {
  buildAuthServicesFromContainer,
  type AuthServices,
} from "./auth/auth-services.js"
import type { MediaRepository } from "./services/media-intake-service.js"
import type { ReportServiceOverrides } from "./routes/reports.routes.js"
import type { AnonServiceOverride } from "./routes/anon.routes.js"
import type { ClaimServiceOverride } from "./routes/claim.routes.js"
import type { CleanupServiceOverrides } from "./routes/cleanups.routes.js"
import type { ChatGatewayOverrides } from "./routes/chat.routes.js"
import type { DiscussionServiceOverrides } from "./routes/discussion.routes.js"
import type { SocialServiceOverrides } from "./routes/social.routes.js"
import type { VolunteerHoursOverrides } from "./routes/volunteer-hours.routes.js"
import type { NotificationServiceOverrides } from "./routes/notifications.routes.js"
import type { DataExportOverride } from "./routes/users.routes.js"
import type { ModerationRouteOverrides } from "./routes/admin/moderation.routes.js"
import { registerRoutes } from "./routes/index.js"
import { registerOutreachJobs } from "./services/admin/outreach-jobs.js"
import { registerInboundJobs, INBOUND_SWEEP_JOB } from "./services/admin/inbound-jobs.js"
import { registerDiscoveryJobs } from "./services/admin/discovery-jobs.js"
import { registerAutoForwardJobs } from "./services/admin/autoforward-jobs.js"
import { SERVICE_VERSION } from "./version.js"

declare module "fastify" {
  interface FastifyInstance {
    container: Container
  }
}

export interface BuildServerOptions {
  env?: Env
  container?: Container
  authServices?: AuthServices
  mediaRepo?: MediaRepository
  reportOverrides?: ReportServiceOverrides
  anonOverride?: AnonServiceOverride
  claimOverride?: ClaimServiceOverride
  cleanupOverrides?: CleanupServiceOverrides
  chatOverrides?: ChatGatewayOverrides
  discussionOverrides?: DiscussionServiceOverrides
  socialOverrides?: SocialServiceOverrides
  volunteerOverrides?: VolunteerHoursOverrides
  notificationOverrides?: NotificationServiceOverrides
  dataExportOverride?: DataExportOverride
  moderationOverrides?: ModerationRouteOverrides
}

const OVERRIDE_KEYS = [
  "mediaRepo",
  "reportOverrides",
  "anonOverride",
  "claimOverride",
  "cleanupOverrides",
  "chatOverrides",
  "discussionOverrides",
  "socialOverrides",
  "volunteerOverrides",
  "notificationOverrides",
  "dataExportOverride",
  "moderationOverrides",
] as const satisfies readonly (keyof BuildServerOptions)[]

export async function buildServer(opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  const env = opts.env ?? loadEnv()
  const container = opts.container ?? buildContainer(env)

  const app = Fastify({
    genReqId,
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 262144,
    requestTimeout: 15000,
    connectionTimeout: 10000,
    keepAliveTimeout: 5000,
    disableRequestLogging: false,
    logger: {
      level: env.NODE_ENV === "test" ? "silent" : env.NODE_ENV === "production" ? "info" : "debug",
      serializers: {
        req(request) {
          const acceptVersion = request.headers["accept-version"]
          return {
            method: request.method,
            url: request.url.split("?")[0],
            version: typeof acceptVersion === "string" ? acceptVersion : undefined,
            host: request.host,
            remoteAddress: request.ip,
            remotePort: request.socket.remotePort,
          }
        },
      },
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "res.headers['set-cookie']",
          "req.headers['x-csrf-token']",
          "*.password",
          "*.token",
          "*.otp",
          "*.email",
        ],
        censor: "[REDACTED]",
      },
    },
  })

  app.decorate("container", container)

  app.setErrorHandler(makeErrorHandler())
  app.setNotFoundHandler(makeNotFoundHandler())

  await registerHelmet(app)
  await registerRequestId(app)
  await registerCookie(app, env.SESSION_SIGNING_KEY)
  await registerCors(app, env.WEB_ORIGINS)
  await registerRateLimit(app, env.REDIS_URL ? { redis: container.getRedis() } : {})

  await registerVersionGate(app)

  const authServices = resolveAuthServices(opts, env, container)
  if (authServices) {
    app.decorate("authServices", authServices)
  } else if (env.NODE_ENV === "production") {
    throw new Error(
      "auth bundle absent in production: DATABASE_URL and REDIS_URL must both be set " +
        "(citizen /auth/* and operator /admin/* routes require them). Refusing to boot.",
    )
  } else {
    app.log.warn(
      {
        nodeEnv: env.NODE_ENV,
        hasDatabaseUrl: env.DATABASE_URL.length > 0,
        hasRedisUrl: env.REDIS_URL.length > 0,
      },
      "auth bundle absent: citizen /auth/* and operator /admin/* routes are NOT mounted (no DATABASE_URL/REDIS_URL).",
    )
  }

  for (const key of OVERRIDE_KEYS) {
    const value = opts[key]
    if (value !== undefined) (app.decorate as (name: string, value: unknown) => void)(key, value)
  }

  await registerAuthContext(app)
  await registerRoutes(app, container, { authMounted: authServices !== undefined })

  return app
}

function resolveAuthServices(
  opts: BuildServerOptions,
  env: Env,
  container: Container,
): AuthServices | undefined {
  if (opts.authServices) return opts.authServices
  if (env.DATABASE_URL && env.REDIS_URL) return buildAuthServicesFromContainer(container)
  return undefined
}

let shuttingDown = false

export async function start(env: Env = loadEnv()): Promise<FastifyInstance> {
  await initErrorReporting({
    ...(env.GLITCHTIP_DSN !== undefined ? { dsn: env.GLITCHTIP_DSN } : {}),
    environment: env.NODE_ENV,
    release: SERVICE_VERSION,
  })

  const app = await buildServer({ env })

  const startableJobs = app.container.jobs as { start?: () => Promise<void> }
  if (typeof startableJobs.start === "function" && env.DATABASE_URL) {
    await startableJobs.start()
    app.log.info("jobs: queue started")

    await registerOutreachJobs(app.container)
    await registerInboundJobs(app.container)
    await app.container.jobs.enqueue(INBOUND_SWEEP_JOB, {})
    await registerDiscoveryJobs(app.container)
    await registerAutoForwardJobs(app.container, app.log)
  }

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info({ signal }, "shutdown: draining")
    const watchdog = setTimeout(() => {
      app.log.error("shutdown: drain timed out; forcing exit")
      process.exit(1)
    }, 20000)
    watchdog.unref()
    try {
      await app.close()
      await app.container.close()
      await flushErrorReporting()
      clearTimeout(watchdog)
      app.log.info("shutdown: complete")
      process.exit(0)
    } catch (err) {
      clearTimeout(watchdog)
      app.log.error({ err }, "shutdown: error during drain")
      process.exit(1)
    }
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))

  await app.listen({ host: "0.0.0.0", port: env.PORT })
  app.log.info({ port: env.PORT, env: env.NODE_ENV }, "civfix-api listening")
  return app
}
