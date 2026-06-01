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

export async function registerCors(app: FastifyInstance, webOrigins: string[]): Promise<void> {
  const allowlist = new Set(webOrigins)
  const allowAll = allowlist.size === 0
  if (allowAll) {
    app.log.warn("CORS: WEB_ORIGINS is empty; allowing all origins (dev only).")
  }

  await app.register(fastifyCors, {
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    origin(origin, cb) {
      if (!origin || allowAll || allowlist.has(origin)) {
        cb(null, true)
        return
      }
      cb(null, false)
    },
  })
}
