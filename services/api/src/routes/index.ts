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
import { registerAnonRoutes } from "./anon.routes.js"
import { registerClaimRoutes } from "./claim.routes.js"
import { registerCleanupRoutes } from "./cleanups.routes.js"
import { registerChatRoutes } from "./chat.routes.js"
import { registerSocialRoutes } from "./social.routes.js"
import { registerNotificationRoutes } from "./notifications.routes.js"
import { registerAdminRoutes } from "./admin/index.js"
import { registerInboundMailWebhook } from "./webhooks/inbound-mail.routes.js"

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
  // CSRF (anonymous submissions go through /anon/reports); GET /reports/:id and GET /map/reports are
  // anon-ok. DB-backed handlers reach the database lazily via container.getDb().
  await registerReportRoutes(app, container)

  // Anon: the logged-out submit (POST /anon/reports, full abuse stack, held) + the claim-code-gated
  // status (GET /anon/reports/:id/status). Both public, so they mount unconditionally; the DB +
  // CounterStore + AbuseChecks seams are reached lazily inside the handlers.
  await registerAnonRoutes(app, container)

  // Claim: the post-submit nudge (GET /claim/nudge, anon-ok) + claiming a held anon report into the
  // signed-in account (POST /claim/report, auth + CSRF). Mount unconditionally; the claim POST 401s
  // when no session is presented.
  await registerClaimRoutes(app, container)

  // Cleanups: create/join/leave (auth + CSRF) + list/get (anon-ok) + member-gated chat history. Mount
  // unconditionally; DB-backed handlers reach the database lazily via container.getDb(), and the
  // auth-gated POST/messages routes 401/403 cleanly with no infra.
  await registerCleanupRoutes(app, container)

  // Chat: the GET /ws WebSocket upgrade (real-time cleanup chat, dual-auth handshake) + GET /threads
  // (auth). Registers @fastify/websocket. Mount unconditionally; the gateway authenticates each
  // handshake and GET /threads 401s with no session.
  await registerChatRoutes(app, container)

  // Social: people directory/search (anon-ok) + follow/unfollow (auth + CSRF) + public profile (anon-ok)
  // + own profile (auth). Mount unconditionally; DB-backed handlers reach the database lazily via
  // container.getDb(), and a NEW follow fires a new_follower notification (which inline-pushes when the
  // followed user's prefs allow). The auth-gated routes 401 cleanly with no infra.
  await registerSocialRoutes(app, container)

  // Notifications: the in-app feed + mark-read (auth + CSRF) + prefs get/update (auth + CSRF) + push-token
  // registration (auth + CSRF). Mount unconditionally; DB-backed handlers reach the database lazily via
  // container.getDb(), and push registration also delegates to the container push seam.
  await registerNotificationRoutes(app, container)

  // Admin / operator dashboard (Phase 2): the operator-auth routes (public) + every operator-gated
  // domain router under the requireOperator guard. Gated on the auth bundle presence, like the citizen
  // auth routes: operator sign-in reuses the same OtpService/SessionService, which only exist when the
  // Pg/Redis-backed bundle is mounted (the no-infra all-fakes boot has nothing to back them). The
  // group's index.ts is the complete, final wiring; wave-2 agents implement the individual domain files.
  if (opts.authMounted) {
    await registerAdminRoutes(app, container)
  }

  // Inbound mail webhook (Phase 2): server-side ingress for the Cloudflare Email worker. NOT under
  // /admin and NOT operator-gated; authenticated by CF_EMAIL_WEBHOOK_SECRET inside the handler. Mount
  // unconditionally (it needs no auth bundle); it refuses every call when the secret is unconfigured.
  await registerInboundMailWebhook(app, container)
}
