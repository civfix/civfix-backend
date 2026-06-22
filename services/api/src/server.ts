/**
 * Fastify server factory + lifecycle.
 *
 *   buildServer(opts?)  builds a fully-configured Fastify instance WITHOUT requiring a live database.
 *                       Error handler, plugins, auth decorator, and routes are registered. Safe for
 *                       `app.inject(...)` in unit tests with all fakes on (the default outside prod).
 *   start(env?)         builds the server, initializes error reporting, listens on PORT, and installs
 *                       SIGTERM/SIGINT handlers for graceful shutdown (server -> jobs/redis/db).
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
import type { SocialServiceOverrides } from "./routes/social.routes.js"
import type { NotificationServiceOverrides } from "./routes/notifications.routes.js"
import type { DataExportOverride } from "./routes/users.routes.js"
import type { ModerationRouteOverrides } from "./routes/admin/moderation.routes.js"
import { registerRoutes } from "./routes/index.js"
import { registerOutreachJobs } from "./services/admin/outreach-jobs.js"
import { registerInboundJobs, INBOUND_SWEEP_JOB } from "./services/admin/inbound-jobs.js"
import { registerDiscoveryJobs } from "./services/admin/discovery-jobs.js"
import { SERVICE_VERSION } from "./version.js"

declare module "fastify" {
  interface FastifyInstance {
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
   * Per-route in-memory overrides (tests). Each is decorated onto the app under the same name and read
   * by its route plugin (`app.<name>`); left unset in production, where every route builds its
   * Drizzle-backed repo + real seams lazily from `container`. Keep the field name === the decorator name
   * the route reads — they are wired by the data-driven loop in buildServer.
   */
  mediaRepo?: MediaRepository
  reportOverrides?: ReportServiceOverrides
  anonOverride?: AnonServiceOverride
  claimOverride?: ClaimServiceOverride
  cleanupOverrides?: CleanupServiceOverrides
  chatOverrides?: ChatGatewayOverrides
  socialOverrides?: SocialServiceOverrides
  notificationOverrides?: NotificationServiceOverrides
  dataExportOverride?: DataExportOverride
  moderationOverrides?: ModerationRouteOverrides
}

/**
 * The test-injection override keys: each is decorated onto the app under its own name (the route plugin
 * reads `app.<name>`). buildServer iterates this list so there is ONE place that wires every override.
 */
const OVERRIDE_KEYS = [
  "mediaRepo",
  "reportOverrides",
  "anonOverride",
  "claimOverride",
  "cleanupOverrides",
  "chatOverrides",
  "socialOverrides",
  "notificationOverrides",
  "dataExportOverride",
  "moderationOverrides",
] as const satisfies readonly (keyof BuildServerOptions)[]

/** Build a configured Fastify instance. Does not listen and does not connect to any infra. */
export async function buildServer(opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  const env = opts.env ?? loadEnv()
  const container = opts.container ?? buildContainer(env)

  const app = Fastify({
    genReqId,
    // Trust ONLY the configured upstream hops for X-Forwarded-* so request.ip is the real client and a
    // client-supplied X-Forwarded-For cannot spoof the per-IP abuse/rate-limit key. Defaults to the
    // internal loopback+private ranges (see env.TRUST_PROXY / env/parsers parseTrustProxy).
    trustProxy: env.TRUST_PROXY,
    // App-layer DoS defense-in-depth (the proxy is required but not sufficient): cap body size and bound
    // slow-client / slowloris exposure. Routes that legitimately need a bigger body opt into a per-route
    // bodyLimit (the inbound-mail webhook fetches the .eml from R2, so it does not need one).
    bodyLimit: 262144,
    requestTimeout: 15000,
    connectionTimeout: 10000,
    keepAliveTimeout: 5000,
    disableRequestLogging: false,
    logger: {
      level: env.NODE_ENV === "test" ? "silent" : env.NODE_ENV === "production" ? "info" : "debug",
      // disableRequestLogging:false logs req/res — redact the auth/cookie/CSRF headers and any PII-ish
      // body fields so secrets never reach the logs.
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

  // API version gate (onRequest): rejects unknown/retired `/vN` segments before any handler runs.
  // Registered AFTER rate limiting (so a flood of bad-version requests is still throttled) and BEFORE
  // the auth-context hook (so a malformed version is rejected without spending a session resolve).
  await registerVersionGate(app)

  // Auth services: injected (tests) or built from the container (production: Pg stores + Redis + mailer).
  // In all-fakes mode with no DATABASE_URL/REDIS_URL there is no infra to back them.
  const authServices = resolveAuthServices(opts, env, container)
  if (authServices) {
    app.decorate("authServices", authServices)
  } else if (env.NODE_ENV === "production") {
    // FAIL CLOSED IN PROD: a missing auth bundle means DATABASE_URL/REDIS_URL are unset, which in
    // production is a misconfiguration. Booting "healthy" but 404-ing all /auth/* and /admin/* (the
    // reported operator-dashboard outage) is a worse failure than a hard boot error, and the deploy is
    // NOT health-gated. Hard-fail here, consistent with di.ts's [BOOT]-credential aggregation. Keyed on
    // the env that built this server (not the global isProd cache) so an embedded/test boot is precise.
    throw new Error(
      "auth bundle absent in production: DATABASE_URL and REDIS_URL must both be set " +
        "(citizen /auth/* and operator /admin/* routes require them). Refusing to boot.",
    )
  } else {
    // Non-prod offline boot: no auth bundle => registerRoutes mounts NEITHER /auth/* NOR /admin/*, so
    // those routes 404. This is the intended all-fakes path for local dev / unit tests. Warn so a server
    // that silently booted in all-fakes mode is diagnosable from the logs.
    app.log.warn(
      {
        nodeEnv: env.NODE_ENV,
        hasDatabaseUrl: env.DATABASE_URL.length > 0,
        hasRedisUrl: env.REDIS_URL.length > 0,
      },
      "auth bundle absent: citizen /auth/* and operator /admin/* routes are NOT mounted (no DATABASE_URL/REDIS_URL).",
    )
  }

  // Test-injection overrides: one data-driven wiring point. Each is decorated under its own name so the
  // route plugin reads `app.<name>`; left unset in production so every route builds its Drizzle-backed
  // repo from the lazily-created DB handle + container seams.
  for (const key of OVERRIDE_KEYS) {
    const value = opts[key]
    // Decorate under the literal name the route plugin reads (`app.<key>`). decorate() is cast to a loose
    // signature because the loop spans several override types; each route still reads its own typed decorator.
    if (value !== undefined) (app.decorate as (name: string, value: unknown) => void)(key, value)
  }

  await registerAuthContext(app)
  await registerRoutes(app, container, { authMounted: authServices !== undefined })

  return app
}

/**
 * Decide which auth bundle to use. Prefer an injected bundle; otherwise build from the container only
 * when both DATABASE_URL and REDIS_URL are present (real infra). Returns undefined in the no-infra
 * all-fakes case (the caller hard-fails in prod, warns-and-degrades otherwise).
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

/** Build, listen, and wire graceful shutdown. Returns the running app (useful for tests/embedding). */
export async function start(env: Env = loadEnv()): Promise<FastifyInstance> {
  await initErrorReporting({
    ...(env.GLITCHTIP_DSN !== undefined ? { dsn: env.GLITCHTIP_DSN } : {}),
    environment: env.NODE_ENV,
    release: SERVICE_VERSION,
  })

  const app = await buildServer({ env })

  // Start the jobs queue BEFORE listening so the hot enqueue paths (finalize -> media.checks; report
  // create -> jurisdiction.discovery) work the moment we serve traffic. Only the real PgBossJobs needs
  // starting; FakeJobs has no start. start()/stop() are not on the Jobs interface (lifecycle is
  // adapter-specific), so we feature-detect and gate on DATABASE_URL to keep an all-fakes boot
  // connectionless.
  const startableJobs = app.container.jobs as { start?: () => Promise<void> }
  if (typeof startableJobs.start === "function" && env.DATABASE_URL) {
    await startableJobs.start()
    app.log.info("jobs: queue started")

    // Register the outreach.digest cron, the inbound-mail sweep (+ one boot sweep to drain anything the
    // CF Email Worker buffered to R2 while the API was down), and the jurisdiction-discovery worker —
    // all gated on real pg-boss + a real DATABASE_URL.
    await registerOutreachJobs(app.container)
    await registerInboundJobs(app.container)
    await app.container.jobs.enqueue(INBOUND_SWEEP_JOB, {})
    await registerDiscoveryJobs(app.container)
  }

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info({ signal }, "shutdown: draining")
    // Force-exit watchdog: if the drain (app.close -> container.close -> flush) wedges, exit non-zero
    // rather than hang the process and block the orchestrator's SIGKILL grace. unref'd so it never
    // keeps the loop alive on a clean drain.
    const watchdog = setTimeout(() => {
      app.log.error("shutdown: drain timed out; forcing exit")
      process.exit(1)
    }, 20000)
    watchdog.unref()
    try {
      // 1) Stop accepting new connections, finish in-flight HTTP, close every open WebSocket (the
      //    @fastify/websocket preClose hook + our per-socket close handler).
      await app.close()
      // 2) Tear down seams + infra handles (pg-boss, chat pub/sub subscriber, shared Redis, Postgres
      //    pool). See di.ts Container.close().
      await app.container.close()
      // 3) Flush any buffered error reports.
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
