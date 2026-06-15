/**
 * CORS plugin configured from the WEB_ORIGINS allowlist.
 *
 * Behavior:
 *   - Requests with no Origin header (curl, server-to-server, health checks) are allowed.
 *   - An Origin present in the allowlist is reflected back.
 *   - Any other Origin is rejected (the browser then blocks the response).
 *   - If the allowlist is empty (dev convenience only), all origins are allowed; this is logged.
 */

import fastifyCors from "@fastify/cors"
import type { FastifyInstance } from "fastify"
import { isProd } from "../env.js"

export async function registerCors(app: FastifyInstance, webOrigins: string[]): Promise<void> {
  const allowlist = new Set(webOrigins)
  // SECURITY: reflecting ANY origin while credentials:true is set is a credential-theft hole. The
  // empty-allowlist "allow all" branch is a DEV convenience ONLY — it must never be reachable in
  // production. Fail closed there (deny all cross-origin) rather than reflect-all-with-credentials.
  // Uses the validated env loader (isProd()), the project convention, not a raw process.env read.
  const prod = isProd()
  const allowAll = allowlist.size === 0 && !prod
  if (allowlist.size === 0) {
    if (prod) {
      app.log.error("CORS: WEB_ORIGINS is empty in production; denying all cross-origin requests.")
    } else {
      app.log.warn("CORS: WEB_ORIGINS is empty; allowing all origins (dev only).")
    }
  }

  await app.register(fastifyCors, {
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // Expose the anon-token header so a CROSS-ORIGIN client could read a freshly-issued token from the
    // response. Same-origin web does not need this (it round-trips via the readable civfix_anon cookie),
    // but a cross-origin SPA reading X-Anon-Token must have it whitelisted here (browsers hide all but a
    // few simple response headers from JS otherwise). Header name is case-insensitive on the wire.
    exposedHeaders: ["X-Anon-Token"],
    origin(origin, cb) {
      if (!origin || allowAll || allowlist.has(origin)) {
        cb(null, true)
        return
      }
      cb(null, false)
    },
  })
}
