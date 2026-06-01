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
 * Generate a request id. Honors an inbound `x-request-id` (trusted at the edge / reverse proxy)
 * when present and reasonable, otherwise mints a UUID.
 */
export function genReqId(req: { headers: Record<string, unknown> }): string {
  const header = req.headers["x-request-id"]
  if (typeof header === "string" && header.length > 0 && header.length <= 200) {
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
