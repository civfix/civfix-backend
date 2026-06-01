/**
 * Security headers via @fastify/helmet. CSP is intentionally left at helmet defaults here; the API
 * serves JSON, not HTML, so a strict app-specific CSP is not required at this layer. Tighten later
 * if any HTML is ever served directly from the API.
 */

import fastifyHelmet from "@fastify/helmet"
import type { FastifyInstance } from "fastify"

export async function registerHelmet(app: FastifyInstance): Promise<void> {
  await app.register(fastifyHelmet, {
    // API responses are JSON; disable CSP here to avoid blocking nothing-of-value and keep headers
    // lean. Edge/reverse-proxy or web app owns page CSP.
    contentSecurityPolicy: false,
  })
}
