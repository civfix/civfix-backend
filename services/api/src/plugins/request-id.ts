import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyRequest } from "fastify"

const REQUEST_ID_HEADER = "x-request-id"
const REQUEST_ID_MAX_LENGTH = 200

/** Keeps hostile bytes (CRLF, control chars, log-injection payloads) out of logs and the echoed header. */
const SAFE_REQUEST_ID = new RegExp(`^[A-Za-z0-9._-]{1,${REQUEST_ID_MAX_LENGTH}}$`)

/** An inbound `x-request-id` is honored for edge trace stitching only when it matches the safe charset. */
export function genReqId(req: { headers: Record<string, unknown> }): string {
  const header = req.headers[REQUEST_ID_HEADER]
  if (typeof header === "string" && SAFE_REQUEST_ID.test(header)) {
    return header
  }
  return randomUUID()
}

export async function registerRequestId(app: FastifyInstance): Promise<void> {
  app.addHook("onSend", async (request: FastifyRequest, reply, payload) => {
    reply.header(REQUEST_ID_HEADER, request.id)
    return payload
  })
}
