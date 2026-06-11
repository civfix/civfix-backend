/**
 * Typed, version-aware route registration helper.
 *
 * `route(app, "createReport", handler)` registers a Fastify route whose METHOD, PATH, and VERSION are
 * all derived from the shared endpoint registry (`@civfix/shared/client` → `endpoints` + `versionedPath`),
 * which is the single source of truth shared with the typed API client. Because the backend computes its
 * wire path from the same registry the client uses to *call* it, the two can never drift: bump an
 * endpoint's `version` (or its `path`) in the contract and both move together.
 *
 *   route(app, name, handler)         // no extra Fastify options
 *   route(app, name, opts, handler)   // with preHandler / config.rateLimit / schema / etc.
 *
 * `name` is `keyof typeof endpoints`, so it autocompletes and a typo is a compile error. ALL Fastify
 * route options passed in `opts` are preserved (merged into the route object). This pass intentionally
 * does NOT thread the contract's request/response types onto the handler — registration only — so the
 * route refactor stays mechanical and low-risk; handlers keep their existing Fastify typing.
 *
 * `app` is a `FastifyInstance`, which also covers an encapsulated child instance (e.g. the admin
 * operator scope created by `app.register(async (operator) => …)`), so admin routes register on the
 * guarded scope exactly the same way.
 */

import { endpoints, versionedPath } from "@civfix/shared/client"
import type { FastifyInstance } from "fastify"
import type { RouteHandlerMethod, RouteShorthandOptions } from "fastify"

/** A key of the shared endpoint registry — the stable operation id (e.g. "createReport"). */
export type EndpointName = keyof typeof endpoints

/**
 * Fastify route options accepted by the shorthands (`preHandler`, `config`, `schema`, `constraints`, …),
 * minus `method`/`url`/`handler`, which `route()` supplies from the registry and its own arguments.
 */
export type RouteOptions = Omit<RouteShorthandOptions, "method" | "url" | "handler">

/** Register a contract endpoint with no extra Fastify options. */
export function route(app: FastifyInstance, name: EndpointName, handler: RouteHandlerMethod): void
/** Register a contract endpoint, preserving the given Fastify route options. */
export function route(
  app: FastifyInstance,
  name: EndpointName,
  opts: RouteOptions,
  handler: RouteHandlerMethod,
): void
export function route(
  app: FastifyInstance,
  name: EndpointName,
  optsOrHandler: RouteOptions | RouteHandlerMethod,
  maybeHandler?: RouteHandlerMethod,
): void {
  const ep = endpoints[name]
  const url = versionedPath(ep)

  // Disambiguate the two arities: with 3 args the third is the handler; with 4 it is the options object.
  const handler = (maybeHandler ?? optsOrHandler) as RouteHandlerMethod
  const opts = (maybeHandler ? optsOrHandler : {}) as RouteOptions

  app.route({
    ...opts,
    method: ep.method,
    url,
    handler,
  })
}
