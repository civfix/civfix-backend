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
}

/**
 * Build a configured Fastify instance. Does not listen and does not connect to any infra.
 */
export async function buildServer(opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  const env = opts.env ?? loadEnv()
  const container = opts.container ?? buildContainer(env)

  const app = Fastify({
    genReqId,
    trustProxy: true,
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
  await registerRateLimit(app)

  // Auth decorator/hook (placeholder anonymous context for now).
  await registerAuthContext(app)

  // Domain routes (health now; later steps append in routes/index.ts).
  await registerRoutes(app, container)

  return app
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

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info({ signal }, "shutdown: draining")
    try {
      // Stop accepting connections and finish in-flight requests first.
      await app.close()
      // Then tear down seams + infra handles held by the container.
      await app.container.close()
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
