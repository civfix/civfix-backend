/**
 * Security headers via @fastify/helmet.
 *
 * CSP (P2-6 hardening): the API serves ONLY JSON, never HTML, so it never legitimately loads scripts,
 * styles, frames, or other subresources. We therefore apply a maximally-restrictive lock-down CSP:
 * default-src 'none' plus an explicit frame-ancestors 'none' (clickjacking defense). If a JSON response
 * were ever mis-rendered as a document (a content-type confusion attack), this CSP blocks every active
 * content vector, and nosniff (helmet default, retained) stops the browser from sniffing JSON as HTML.
 * This is strictly additive for a JSON API: there is nothing of value to block, so it cannot break a
 * legitimate response. The web app and the edge own their own page CSPs separately.
 */

import fastifyHelmet from "@fastify/helmet"
import type { FastifyInstance } from "fastify"

export async function registerHelmet(app: FastifyInstance): Promise<void> {
  await app.register(fastifyHelmet, {
    // Lock-down CSP for a pure-JSON API: deny every subresource and disallow being framed. helmet's
    // other defaults (X-Content-Type-Options: nosniff, X-Frame-Options, etc.) remain on.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'none'"],
        "frame-ancestors": ["'none'"],
        "base-uri": ["'none'"],
        "form-action": ["'none'"],
      },
    },
  })
}
