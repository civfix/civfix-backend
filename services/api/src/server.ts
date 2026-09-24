import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify"
import { loadEnv, type Env } from "./env.js"
import { assertRedisReachable, makeContainer, type Container } from "./di.js"
import { makeErrorHandler, makeNotFoundHandler } from "./errors/http-mapper.js"
import { initErrorReporting } from "./errors/glitchtip.js"
import { LOG_REDACTION_CENSOR, redactLogObject } from "./errors/log-redaction.js"
import { loggedRequestUrl } from "./lib/request-url.js"
import { genReqId, registerRequestId } from "./plugins/request-id.js"
import { registerCors } from "./plugins/cors.js"
import { registerHelmet } from "./plugins/helmet.js"
import { registerCookie } from "./plugins/cookie.js"
import { registerRateLimit } from "./plugins/rate-limit.js"
import { registerVersionGate } from "./versioning/version-gate.js"
import { registerAuthContext } from "./auth/context.js"
import { registerAccountStatusGuard } from "./auth/account-status.js"
import { makeAuthServicesFromContainer, type AuthServices } from "./auth/auth-services.js"
import type { MediaRepository } from "./services/media-repository.js"
import type { ReportServiceOverrides } from "./routes/reports.routes.js"
import type { AnonServiceOverride } from "./routes/anon.routes.js"
import type { HomeTurfOverrides } from "./routes/forms.routes.js"
import type { ClaimServiceOverride } from "./routes/claim.routes.js"
import type { CleanupServiceOverrides } from "./routes/cleanups.routes.js"
import type { GuestRsvpOverrides } from "./routes/guest-rsvp.routes.js"
import type { ChatGatewayOverrides } from "./routes/chat.routes.js"
import type { DiscussionServiceOverrides } from "./routes/report-chat.routes.js"
import type { SocialServiceOverrides } from "./routes/social.routes.js"
import type { VolunteerHoursOverrides } from "./routes/volunteer-hours.routes.js"
import type { CertificateOverrides } from "./routes/service-hours-certificates.routes.js"
import type { NotificationServiceOverrides } from "./routes/notifications.routes.js"
import type { ConversationRoutesOverrides } from "./routes/conversations.routes.js"
import type { ModerationRouteOverrides } from "./routes/admin/moderation.routes.js"
import type { OrganizationOverrides } from "./routes/host/orgs.routes.js"
import type { HostTeamOverrides } from "./routes/host/team.routes.js"
import type { HostPortfolioOverrides } from "./routes/host/portfolio.routes.js"
import type {
  HostRegistrationOverrides,
  HostPageOverrides,
} from "./services/host/registration-wiring.js"
import type { BroadcastOverrides } from "./routes/host/broadcasts.routes.js"
import type { HostAnalyticsOverrides } from "./routes/host/analytics.routes.js"
import type { HostExportOverrides } from "./routes/host/exports.routes.js"
import type { AdminEventPageOverrides } from "./routes/admin/pages.routes.js"
import type { AdminMediaOverrides } from "./routes/admin/media.routes.js"
import type { AdminBroadcastOverrides } from "./routes/admin/broadcasts.routes.js"
import type { ContentSubjectGate } from "./services/content-report-subject.js"
import { registerRoutes } from "./routes/index.js"
import { registerOutreachJobs } from "./services/admin/outreach-jobs.js"
import { registerInboundJobs } from "./services/admin/inbound-jobs.js"
import { INBOUND_SWEEP_JOB } from "./lib/queue-names.js"
import { registerDiscoveryJobs } from "./services/admin/discovery-jobs.js"
import { registerAutoForwardJobs } from "./services/admin/autoforward-jobs.js"
import { registerDataExportJobs } from "./services/data-export-jobs.js"
import { registerChatRoomFanoutJob } from "./services/chat-fanout-jobs.js"
import { registerCleanupCancelFanoutJob } from "./services/cleanup-jobs.js"
import { registerGuestJobs } from "./services/guest-jobs.js"
import { registerRegistrationJobs } from "./services/host/registration-jobs.js"
import { registerCommsJobs } from "./services/host/comms-jobs.js"
import { SERVICE_VERSION } from "./version.js"
import { makeLifecycle, makeShutdown, REQUEST_TIMEOUT_MS } from "./lifecycle.js"

const API_BODY_LIMIT_BYTES = 256 * 1024
const SOCKET_CONNECTION_TIMEOUT_MS = 30_000
const KEEP_ALIVE_TIMEOUT_MS = 5_000
const LISTEN_HOST = "0.0.0.0"

declare module "fastify" {
  interface FastifyInstance {
    container: Container
  }
}

export interface MakeServerOptions {
  env?: Env
  container?: Container
  authServices?: AuthServices
  mediaRepo?: MediaRepository
  reportOverrides?: ReportServiceOverrides
  anonOverride?: AnonServiceOverride
  homeTurfOverrides?: HomeTurfOverrides
  claimOverride?: ClaimServiceOverride
  cleanupOverrides?: CleanupServiceOverrides
  guestRsvpOverrides?: GuestRsvpOverrides
  hostRegistrationOverrides?: HostRegistrationOverrides
  hostPageOverrides?: HostPageOverrides
  organizationOverrides?: OrganizationOverrides
  hostTeamOverrides?: HostTeamOverrides
  hostPortfolioOverrides?: HostPortfolioOverrides
  broadcastOverrides?: BroadcastOverrides
  hostAnalyticsOverrides?: HostAnalyticsOverrides
  hostExportOverrides?: HostExportOverrides
  adminEventPageOverrides?: AdminEventPageOverrides
  adminMediaOverrides?: AdminMediaOverrides
  adminBroadcastOverrides?: AdminBroadcastOverrides
  chatOverrides?: ChatGatewayOverrides
  discussionOverrides?: DiscussionServiceOverrides
  socialOverrides?: SocialServiceOverrides
  volunteerOverrides?: VolunteerHoursOverrides
  certificateOverrides?: CertificateOverrides
  notificationOverrides?: NotificationServiceOverrides
  conversationRoutesOverrides?: ConversationRoutesOverrides
  moderationOverrides?: ModerationRouteOverrides
  contentSubjectGate?: ContentSubjectGate
}

const OVERRIDE_KEYS = [
  "mediaRepo",
  "reportOverrides",
  "anonOverride",
  "homeTurfOverrides",
  "claimOverride",
  "cleanupOverrides",
  "guestRsvpOverrides",
  "hostRegistrationOverrides",
  "hostPageOverrides",
  "organizationOverrides",
  "hostTeamOverrides",
  "hostPortfolioOverrides",
  "broadcastOverrides",
  "hostAnalyticsOverrides",
  "hostExportOverrides",
  "adminEventPageOverrides",
  "adminMediaOverrides",
  "adminBroadcastOverrides",
  "chatOverrides",
  "discussionOverrides",
  "socialOverrides",
  "volunteerOverrides",
  "certificateOverrides",
  "notificationOverrides",
  "conversationRoutesOverrides",
  "moderationOverrides",
  "contentSubjectGate",
] as const satisfies readonly (keyof MakeServerOptions)[]

// Header and error-envelope paths only. Sensitive keys inside logged objects are censored at any depth by
// redactLogObject; wildcard paths here only ever reached one nesting level.
export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
  "req.headers['x-csrf-token']",
  "err.raw",
  "err.raw.source",
  "err.headers",
  "*.smtp.response",
  "smtp.response",
  "err.smtp.response",
]

export { loggedRequestUrl }

type LoggerOptions = Exclude<NonNullable<FastifyServerOptions["logger"]>, boolean>

export function loggerOptions(env: Env): LoggerOptions {
  return {
    level: env.NODE_ENV === "test" ? "silent" : env.NODE_ENV === "production" ? "info" : "debug",
    serializers: {
      req(request) {
        const acceptVersion = request.headers["accept-version"]
        return {
          method: request.method,
          url: loggedRequestUrl(request.url),
          version: typeof acceptVersion === "string" ? acceptVersion : undefined,
          host: request.host,
          remoteAddress: request.ip,
          remotePort: request.socket.remotePort,
        }
      },
    },
    formatters: { log: redactLogObject },
    redact: {
      paths: LOG_REDACT_PATHS,
      censor: LOG_REDACTION_CENSOR,
    },
  }
}

export async function makeServer(opts: MakeServerOptions = {}): Promise<FastifyInstance> {
  const env = opts.env ?? opts.container?.env ?? loadEnv()
  const container = opts.container ?? makeContainer(env)

  const app = Fastify({
    genReqId,
    trustProxy: env.TRUST_PROXY,
    bodyLimit: API_BODY_LIMIT_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
    forceCloseConnections: false,
    connectionTimeout: SOCKET_CONNECTION_TIMEOUT_MS,
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    logger: loggerOptions(env),
  })

  app.decorate("container", container)
  app.decorate("lifecycle", makeLifecycle())

  app.setErrorHandler(makeErrorHandler())
  app.setNotFoundHandler(makeNotFoundHandler())

  await registerHelmet(app)
  await registerRequestId(app)
  await registerCookie(app, env.SESSION_SIGNING_KEY)
  await registerCors(app, env.WEB_ORIGINS)
  await registerRateLimit(app, env.REDIS_URL ? { redis: container.getRedis() } : {})

  await assertRedisReachable(container)

  await registerVersionGate(app)

  const authServices = resolveAuthServices(opts, env, container, app.log)
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
  registerAccountStatusGuard(app)

  if (env.DATABASE_URL) container.getNotificationService(app.log)

  await registerRoutes(app, container, { authMounted: authServices !== undefined })

  return app
}

function resolveAuthServices(
  opts: MakeServerOptions,
  env: Env,
  container: Container,
  logger: FastifyInstance["log"],
): AuthServices | undefined {
  if (opts.authServices) return opts.authServices
  if (env.DATABASE_URL && env.REDIS_URL) {
    return makeAuthServicesFromContainer(container, { logger })
  }
  return undefined
}

export async function startBackgroundJobs(app: FastifyInstance, env: Env): Promise<void> {
  const startableJobs = app.container.jobs as { start?: () => Promise<void> }
  if (typeof startableJobs.start !== "function" || !env.DATABASE_URL) return
  await startableJobs.start()
  app.log.info("jobs: queue started")

  await registerOutreachJobs(app.container, app.log)
  await registerInboundJobs(app.container)
  await app.container.jobs.enqueue(INBOUND_SWEEP_JOB, {})
  await registerDiscoveryJobs(app.container)
  if (env.REPORT_AUTOFORWARD_ENABLED) await registerAutoForwardJobs(app.container, app.log)
  await registerDataExportJobs(app.container, { logger: app.log })
  await registerCleanupCancelFanoutJob(app.container, app.log)
  await registerGuestJobs(app.container, app.log)
  await registerChatRoomFanoutJob(app.container, app.log)
  await registerRegistrationJobs(app.container, app.log)
  await registerCommsJobs(app.container, app.log)
}

export async function start(env: Env = loadEnv()): Promise<FastifyInstance> {
  await initErrorReporting({
    ...(env.GLITCHTIP_DSN !== undefined ? { dsn: env.GLITCHTIP_DSN } : {}),
    environment: env.NODE_ENV,
    release: SERVICE_VERSION,
  })

  const app = await makeServer({ env })
  await startBackgroundJobs(app, env)

  const shutdown = makeShutdown(app, {
    drainMs: env.SHUTDOWN_DRAIN_MS,
    closeContainer: () => app.container.close(),
  })

  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))

  await app.listen({ host: LISTEN_HOST, port: env.PORT })
  app.log.info({ port: env.PORT, env: env.NODE_ENV }, "civfix-api listening")
  return app
}
