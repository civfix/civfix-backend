/**
 * Request-id support. Fastify already assigns `request.id`; we configure the generator at server
 * construction time (see server.ts `genReqId`) and this module provides:
 *   - a small, dependency-free id generator
 *   - an onSend hook that echoes the id back in the `x-request-id` response header
 *
 * Keeping the generator here means the error mapper and logs share one definition of request ids.
 */

import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyRequest } from "fastify"

/**
 * Safe charset for an inbound request id we are willing to echo: alphanumerics plus a few separators.
 * This prevents reflecting hostile bytes (CRLF / control chars / log-injection payloads) from a
 * client-supplied x-request-id back into logs and the x-request-id response header.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,200}$/

/**
 * Generate a request id. Honors an inbound `x-request-id` (for edge/reverse-proxy trace stitching) ONLY
 * when it matches the safe charset; anything else (including hostile or oversized values) mints a UUID.
 */
export function genReqId(req: { headers: Record<string, unknown> }): string {
  const header = req.headers["x-request-id"]
  if (typeof header === "string" && SAFE_REQUEST_ID.test(header)) {
    return header
  }
  return randomUUID()
}

/** Register the onSend hook that reflects the request id back to the caller. */
export async function registerRequestId(app: FastifyInstance): Promise<void> {
  app.addHook("onSend", async (request: FastifyRequest, reply, payload) => {
    reply.header("x-request-id", request.id)
    return payload
  })
}
