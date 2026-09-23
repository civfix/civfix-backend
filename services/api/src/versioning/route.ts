/**
 * The method and versioned path come from the same shared registry the typed client calls through, so
 * client and server cannot drift. Only method and path are copied: the registry's `csrf` flag is not
 * wired here, so a mutation adds `preHandler: csrfProtect` itself.
 */

import { endpoints, versionedPath } from "@civfix/shared/client"
import type { FastifyInstance } from "fastify"
import type { RouteHandlerMethod, RouteShorthandOptions } from "fastify"

export type EndpointName = keyof typeof endpoints

export type RouteOptions = Omit<RouteShorthandOptions, "method" | "url" | "handler">

export function route(app: FastifyInstance, name: EndpointName, handler: RouteHandlerMethod): void
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

  const handler = (maybeHandler ?? optsOrHandler) as RouteHandlerMethod
  const opts = (maybeHandler ? optsOrHandler : {}) as RouteOptions

  app.route({
    ...opts,
    method: ep.method,
    url,
    handler,
  })
}
