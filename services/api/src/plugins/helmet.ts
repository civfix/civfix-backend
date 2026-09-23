/**
 * The API serves only JSON, so the CSP denies every subresource and framing: if a JSON response were ever
 * rendered as a document (content-type confusion), no active content can run, and helmet's default nosniff
 * stops the browser sniffing JSON as HTML. The web app and the edge own their own page CSPs.
 */

import fastifyHelmet from "@fastify/helmet"
import type { FastifyInstance } from "fastify"
import { isProd } from "../env.js"

export async function registerHelmet(app: FastifyInstance): Promise<void> {
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'none'"],
        "frame-ancestors": ["'none'"],
        "base-uri": ["'none'"],
        "form-action": ["'none'"],
      },
    },
    // Explicit rather than helmet's ~180-day default: the API and web app share the civfix.org tree, so
    // `includeSubDomains` closes the sibling-subdomain downgrade path, and `preload` protects even a
    // user's FIRST request. Two years + includeSubDomains + preload is what hstspreload.org requires.
    // Off outside prod: pinning localhost to HTTPS for months would break local development.
    ...(isProd()
      ? {
          strictTransportSecurity: {
            maxAge: 63072000,
            includeSubDomains: true,
            preload: true,
          },
        }
      : { strictTransportSecurity: false }),
  })
}
