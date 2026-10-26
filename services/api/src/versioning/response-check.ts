/**
 * Test-only guard: every success body a `route()` handler sends is parsed with the endpoint's contract
 * `response` schema, the schema the typed client parses it with, so the route tests catch
 * server-vs-contract drift the reply typing cannot see (response schemas whose declared input type is
 * `unknown`, bodies emitted by a fast-json-stringify response schema). Never registered outside
 * NODE_ENV=test, so production pays nothing.
 */

import { ErrorCode } from "@civfix/contract"
import { endpoints } from "@civfix/contract/client"
import type { FastifyReply, onSendAsyncHookHandler } from "fastify"
import type { z } from "zod"
import type { EndpointName } from "./route.js"

const HTTP_OK_MIN = 200
const HTTP_NO_CONTENT = 204
const HTTP_REDIRECT_MIN = 300
const HTTP_INTERNAL = 500
const ROOT_PATH_LABEL = "(root)"

export const CHECK_RESPONSES = process.env.NODE_ENV === "test"

/** The typed client parses every 2xx body but a 204 as JSON, whatever its content-type, so this does too. */
function expectsBody(statusCode: number): boolean {
  return (
    statusCode >= HTTP_OK_MIN && statusCode < HTTP_REDIRECT_MIN && statusCode !== HTTP_NO_CONTENT
  )
}

function driftIn(schema: z.ZodType, payload: unknown): string | null {
  const text = typeof payload === "string" || Buffer.isBuffer(payload) ? payload.toString() : null
  if (!text) return "the body is empty"
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return "the body is not JSON"
  }
  const result = schema.safeParse(body)
  if (result.success) return null
  return result.error.issues
    .map((issue) => `${issue.path.join(".") || ROOT_PATH_LABEL}: ${issue.message}`)
    .join("; ")
}

/**
 * An async handler that calls `reply.send(x)` without returning it resolves while the async onSend
 * chain is still running, so fastify sends a second, empty `undefined` payload that loses the race to the
 * first. Only the first payload a reply sends reaches the client, so only that one is checked.
 */
const checkedReplies = new WeakSet<FastifyReply>()

export function contractResponseCheck(name: EndpointName): onSendAsyncHookHandler {
  const schema = endpoints[name].response
  return async (request, reply, payload) => {
    if (checkedReplies.has(reply)) return payload
    checkedReplies.add(reply)
    if (!expectsBody(reply.statusCode)) return payload
    const drift = driftIn(schema, payload)
    if (drift === null) return payload

    const message = `${name} response does not match the contract: ${drift}`
    // The test logger is silent, and most route tests only assert the status code, so stderr is what
    // puts the drift in front of whoever reads the failing run.
    console.error(message)
    // Rewritten here rather than thrown: an async handler that calls reply.send() without returning it
    // races fastify's error path from onSend and the 500 goes out with an empty body.
    reply.code(HTTP_INTERNAL).type("application/json; charset=utf-8")
    return JSON.stringify({ code: ErrorCode.INTERNAL, message, requestId: request.id })
  }
}
