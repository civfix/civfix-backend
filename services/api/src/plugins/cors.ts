import fastifyCors from "@fastify/cors"
import type { FastifyInstance } from "fastify"
import { isProd } from "../env.js"

export async function registerCors(app: FastifyInstance, webOrigins: string[]): Promise<void> {
  const allowlist = new Set(webOrigins)
  // Security: reflecting ANY origin with credentials:true is a credential-theft hole, so the empty-allowlist
  // "allow all" dev convenience must be unreachable in production, which fails closed instead.
  const prod = isProd()
  const isEmpty = allowlist.size === 0
  const allowAll = isEmpty && !prod
  if (isEmpty) {
    if (prod) {
      app.log.error("CORS: WEB_ORIGINS is empty in production; denying all cross-origin requests.")
    } else {
      app.log.warn("CORS: WEB_ORIGINS is empty; allowing all origins (dev only).")
    }
  }

  await app.register(fastifyCors, {
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 600,
    // Browsers hide all but a few simple response headers from cross-origin JS. Same-origin web reads the
    // anon token from the civfix_anon cookie instead, but a cross-origin client needs X-Anon-Token here.
    exposedHeaders: [
      "X-Anon-Token",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
      "Retry-After",
    ],
    origin(origin, cb) {
      if (!origin || allowAll || allowlist.has(origin)) {
        cb(null, true)
        return
      }
      cb(null, false)
    },
  })
}
