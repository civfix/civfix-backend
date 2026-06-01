/**
 * Route registration root.
 *
 * EXTENSION POINT for later domain steps: register your route plugin here, one line per domain.
 * Each plugin is `(app, container) => Promise<void>` and should register under its own prefix.
 *
 * Keep health first. Do not put domain logic in this file; it is wiring only. The auth routes are
 * mounted only when an auth service bundle is present on the app (see server.ts): in the no-infra
 * all-fakes boot there are no Pg/Redis-backed services to serve them.
 */

import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { registerHealthRoutes } from "./health.routes.js"
import { registerAuthRoutes } from "./auth.routes.js"
import { registerMapRoutes } from "./map.routes.js"
import { registerMediaRoutes } from "./media.routes.js"
import { registerReportRoutes } from "./reports.routes.js"

export interface RegisterRoutesOptions {
  /** Whether an auth service bundle is available; gates mounting the auth routes. */
  authMounted?: boolean
}

export async function registerRoutes(
  app: FastifyInstance,
  container: Container,
  opts: RegisterRoutesOptions = {},
): Promise<void> {
  await registerHealthRoutes(app, container)

  if (opts.authMounted) {
    await registerAuthRoutes(app, container)
  }

  // Map: tile metadata + jurisdiction/reverse-geocode resolution + cleanup pins. All anon-ok, so they
  // mount unconditionally. The DB-backed handlers (resolve-jurisdiction, cleanups) reach the database
  // lazily via container.getDb() only when hit; tileinfo + reverse-label need no DB.
  await registerMapRoutes(app, container)

  // Media: presigned-upload intake (create/finalize) + media fetch. All anon-ok, so they mount
  // unconditionally. The handlers reach the database lazily via container.getDb() only when hit; the
  // expensive untrusted-byte processing happens in the separate media-worker via the "media.checks"
  // job this enqueues on finalize.
  await registerMediaRoutes(app, container)

  // Reports: create (idempotent) + get + my-list + clustered map + follow. POST/follow require auth +
  // CSRF (anonymous submissions go through /anon/reports, a later step); GET /reports/:id and
  // GET /map/reports are anon-ok. DB-backed handlers reach the database lazily via container.getDb().
  await registerReportRoutes(app, container)

  // <-- later domain steps append their route registrations below, e.g.:
  // await registerCleanupRoutes(app, container)
}
