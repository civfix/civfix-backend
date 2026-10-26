/**
 * The method and versioned path come from the same shared registry the typed client calls through, so
 * client and server cannot drift. Only method and path are copied: the registry's `csrf` flag is not
 * wired here, so a mutation adds `preHandler: csrfProtect` itself.
 */

import { endpoints, versionedPath } from "@civfix/contract/client"
import type {
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
  RouteHandlerMethod,
  RouteShorthandOptions,
} from "fastify"
import type { z } from "zod"
import { CHECK_RESPONSES, contractResponseCheck } from "./response-check.js"

export type EndpointName = keyof typeof endpoints

export type RouteOptions = Omit<RouteShorthandOptions, "method" | "url" | "handler">

/** `z.input`, not the parsed output: the handler sends what the client's schema parse accepts. */
export type EndpointReply<N extends EndpointName> = z.input<(typeof endpoints)[N]["response"]>

export type EndpointHandler<N extends EndpointName> = RouteHandlerMethod<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  { Reply: EndpointReply<N> }
>

export function route<N extends EndpointName>(
  app: FastifyInstance,
  name: N,
  handler: EndpointHandler<N>,
): void
export function route<N extends EndpointName>(
  app: FastifyInstance,
  name: N,
  opts: RouteOptions,
  handler: EndpointHandler<N>,
): void
export function route<N extends EndpointName>(
  app: FastifyInstance,
  name: N,
  optsOrHandler: RouteOptions | EndpointHandler<N>,
  maybeHandler?: EndpointHandler<N>,
): void {
  const ep = endpoints[name]
  const url = versionedPath(ep)

  const handler = maybeHandler ?? (optsOrHandler as EndpointHandler<N>)
  const opts = maybeHandler ? (optsOrHandler as RouteOptions) : {}

  app.route<{ Reply: EndpointReply<N> }>({
    ...opts,
    ...(CHECK_RESPONSES
      ? {
          onSend:
            opts.onSend === undefined
              ? contractResponseCheck(name)
              : [opts.onSend, contractResponseCheck(name)].flat(),
        }
      : {}),
    method: ep.method,
    url,
    handler,
  })
}
