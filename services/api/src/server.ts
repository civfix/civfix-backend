/**
 * Fastify server factory + lifecycle.
 *
 *   buildServer(env?)  builds a fully-configured Fastify instance WITHOUT requiring a live database.
 *                      Error handler, plugins, auth decorator, and routes are registered. Safe for
 *                      `app.inject(...)` in unit tests with all fakes on (the default outside prod).
 *   start(env?)        builds the server, initializes error reporting, listens on PORT, and installs
 *                      SIGTERM/SIGINT handlers for graceful shutdown (server -> jobs/redis/db).
 *
 * The container is attached to the app via `app.decorate("container", ...)` so routes and later
 * plugins can reach the seams.
 */

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
import type { SocialServiceOverrides } from "./routes/social.routes.js"
import type { NotificationServiceOverrides } from "./routes/notifications.routes.js"
import { registerRoutes } from "./routes/index.js"
import { SERVICE_VERSION } from "./version.js"

declare module "fastify" {
  interface FastifyInstance {
    /** The DI container holding all 9 seams plus db/redis handles. */
    container: Container
  }
}

export interface BuildServerOptions {
  /** Override the env (tests). Defaults to `loadEnv()` from process.env. */
  env?: Env
  /** Override/inject a container (tests). Defaults to one built from env. */
  container?: Container
  /**
   * Inject the auth service bundle (tests). When omitted it is built from the container (production:
   * Postgres stores + Redis cache + the selected mailer). Injecting in-memory stores + cache here is
   * what lets the full auth flow be exercised offline via app.inject.
   */
  authServices?: AuthServices
  /**
   * Inject an in-memory media repository (tests). When present the media routes use it instead of the
   * Drizzle-backed repo, so the create/finalize/getMedia HTTP flow runs offline (no Docker). Omitted in
   * production: the routes reach the database lazily via container.getDb().
   */
  mediaRepo?: MediaRepository
  /**
   * Inject report-service overrides (tests): an in-memory ReportRepository plus optional fake
   * jurisdiction/presign so the create/get/my-list/map/follow HTTP flow runs offline (no Docker). Left
   * unset in production, where the report routes build the Drizzle-backed repo + real seams lazily.
   */
  reportOverrides?: ReportServiceOverrides
  /**
   * Inject an anon-service override (tests): a fully-wired AnonService over an in-memory repo + fakes,
   * so the POST /anon/reports abuse + held-create flow and GET /anon/reports/:id/status run offline.
   * Left unset in production, where the anon routes build the Drizzle-backed service lazily.
   */
  anonOverride?: AnonServiceOverride
  /**
   * Inject a claim-service override (tests): a ClaimService over an in-memory repo, so the
   * GET /claim/nudge + POST /claim/report flow runs offline. Left unset in production.
   */
  claimOverride?: ClaimServiceOverride
  /**
   * Inject cleanup-service overrides (tests): an in-memory CleanupRepository so the cleanups
   * create/list/get/join/leave + member-gated history HTTP flow runs offline. Left unset in production.
   */
  cleanupOverrides?: CleanupServiceOverrides
  /**
   * Inject chat/threads overrides (tests): an isMember probe + in-memory ThreadsRepository (+ optional
   * shared ChatReadState) so the WS gateway and GET /threads run offline. Left unset in production.
   */
  chatOverrides?: ChatGatewayOverrides
  /**
   * Inject social-service overrides (tests): an in-memory SocialRepository + an optional new_follower
   * notifier (spy) so the people/follow/profile HTTP flow runs offline. Left unset in production, where
   * the social routes build the Drizzle-backed repo + the notification service as the notifier lazily.
   */
  socialOverrides?: SocialServiceOverrides
  /**
   * Inject notification-service overrides (tests): an in-memory NotificationRepository so the
   * list/read/prefs/push-register HTTP flow runs offline (the push seam stays the container's FakePushSender).
   * Left unset in production, where the notification routes build the Drizzle-backed repo lazily.
   */
  notificationOverrides?: NotificationServiceOverrides
}

/**
 * Build a configured Fastify instance. Does not listen and does not connect to any infra.
 */
export async function buildServer(opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  const env = opts.env ?? loadEnv()
  const container = opts.container ?? buildContainer(env)

  const app = Fastify({
    genReqId,
    // Trust ONLY the configured upstream hops for X-Forwarded-* so request.ip is the real client and a
    // client-supplied X-Forwarded-For cannot spoof the per-IP abuse/rate-limit key. Defaults to the
    // internal loopback+private ranges (see env.TRUST_PROXY / plugins/trust-proxy).
    trustProxy: env.TRUST_PROXY,
    disableRequestLogging: false,
    logger: {
      level: env.NODE_ENV === "test" ? "silent" : env.NODE_ENV === "production" ? "info" : "debug",
    },
  })

  app.decorate("container", container)

  // Error rendering first so failures during route setup still serialize cleanly.
  app.setErrorHandler(makeErrorHandler())
  app.setNotFoundHandler(makeNotFoundHandler())

  // Cross-cutting plugins. Order: security headers, request id echo, cookies, cors, rate limit.
  await registerHelmet(app)
  await registerRequestId(app)
  await registerCookie(app, env.SESSION_SIGNING_KEY)
  await registerCors(app, env.WEB_ORIGINS)
  // Use the shared Redis store for rate-limiting when REDIS_URL is configured (multi-instance correct);
  // otherwise the plugin's in-memory store (single instance / offline dev). getRedis() returns a
  // lazily-connecting ioredis client, so this does not open a socket until the first limited request.
  await registerRateLimit(app, env.REDIS_URL ? { redis: container.getRedis() } : {})

  // Auth services: injected (tests) or built from the container (production: Pg stores + Redis +
  // mailer). In all-fakes mode with no DATABASE_URL/REDIS_URL there is no infra to back them, so the
  // bundle is left off; the context hook then resolves every request as anonymous and the auth
  // routes are not mounted. This keeps `buildServer` bootable with no infra (health/unit tests).
  const authServices = resolveAuthServices(opts, env, container)
  if (authServices) {
    app.decorate("authServices", authServices)
  }

  // Optional injected media repository (tests). Left unset in production so the media routes build the
  // Drizzle-backed repo from the lazily-created DB handle.
  if (opts.mediaRepo) {
    app.decorate("mediaRepo", opts.mediaRepo)
  }

  // Optional injected report-service overrides (tests). Left unset in production so the report routes
  // build the Drizzle-backed repo + real jurisdiction/presign seams from the lazily-created DB handle.
  if (opts.reportOverrides) {
    app.decorate("reportOverrides", opts.reportOverrides)
  }

  // Optional injected anon/claim service overrides (tests). Left unset in production so those routes
  // build their Drizzle-backed services from the lazily-created DB handle + container seams.
  if (opts.anonOverride) {
    app.decorate("anonOverride", opts.anonOverride)
  }
  if (opts.claimOverride) {
    app.decorate("claimOverride", opts.claimOverride)
  }

  // Optional injected cleanup/chat overrides (tests). Left unset in production so those routes build
  // their Drizzle-backed repos from the lazily-created DB handle + the container's chat seam.
  if (opts.cleanupOverrides) {
    app.decorate("cleanupOverrides", opts.cleanupOverrides)
  }
  if (opts.chatOverrides) {
    app.decorate("chatOverrides", opts.chatOverrides)
  }

  // Optional injected social/notification overrides (tests). Left unset in production so those routes
  // build their Drizzle-backed repos from the lazily-created DB handle (+ the container push seam).
  if (opts.socialOverrides) {
    app.decorate("socialOverrides", opts.socialOverrides)
  }
  if (opts.notificationOverrides) {
    app.decorate("notificationOverrides", opts.notificationOverrides)
  }

  // Auth context hook (resolves req.auth from the session, or anonymous).
  await registerAuthContext(app)

  // Domain routes (health always; auth when an auth bundle is present).
  await registerRoutes(app, container, { authMounted: authServices !== undefined })

  return app
}

/**
 * Decide which auth bundle to use. Prefer an injected bundle; otherwise build from the container only
 * when both DATABASE_URL and REDIS_URL are present (real infra). Returns undefined in the no-infra
 * all-fakes case so the server still boots for health/unit tests.
 */
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

/**
 * Build, listen, and wire graceful shutdown. Returns the running app (useful for tests/embedding).
 */
export async function start(env: Env = loadEnv()): Promise<FastifyInstance> {
  await initErrorReporting({
    ...(env.GLITCHTIP_DSN !== undefined ? { dsn: env.GLITCHTIP_DSN } : {}),
    environment: env.NODE_ENV,
    release: SERVICE_VERSION,
  })

  const app = await buildServer({ env })

  // Start the jobs queue BEFORE listening so the hot enqueue paths (POST /media/:uploadId/finalize ->
  // media.checks; POST /reports + /anon/reports -> jurisdiction.discovery) work the moment we serve
  // traffic. Only the real PgBossJobs needs starting (it opens pg-boss + creates the API's queues), and
  // only when a database is actually configured; FakeJobs has no start. We feature-detect start() and
  // gate on DATABASE_URL so an all-fakes boot (no infra) stays connectionless.
  const startableJobs = app.container.jobs as { start?: () => Promise<void> }
  if (typeof startableJobs.start === "function" && env.DATABASE_URL) {
    await startableJobs.start()
    app.log.info("jobs: queue started")
  }

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info({ signal }, "shutdown: draining")
    try {
      // 1) Stop accepting new connections, finish in-flight HTTP, and close every open WebSocket: the
      //    @fastify/websocket preClose hook iterates server.clients and closes each one, then closes the
      //    WS server. Our per-socket close handler leaves rooms and clears the heartbeat timer.
      await app.close()
      // 2) Tear down seams + infra handles held by the container, in order: pg-boss (stop intake/drain),
      //    the chat pub/sub subscriber (the dedicated duplicated Redis connection), the shared Redis
      //    client, then the Postgres pool. See di.ts Container.close().
      await app.container.close()
      // 3) Flush any buffered error reports.
      await flushErrorReporting()
      app.log.info("shutdown: complete")
      process.exit(0)
    } catch (err) {
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
