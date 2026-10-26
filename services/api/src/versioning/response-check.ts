/**
 * Test-only guard: every JSON success body a `route()` handler sends is parsed with the endpoint's
 * contract `response` schema, exactly as the typed client parses it, so the route tests catch
 * server-vs-contract drift the reply typing cannot see (response schemas whose declared input type is
 * `unknown`, bodies emitted by a fast-json-stringify response schema). Never registered outside
 * NODE_ENV=test, so production pays nothing.
 */

import { ErrorCode } from "@civfix/contract"
import { endpoints } from "@civfix/contract/client"
import type { onSendAsyncHookHandler } from "fastify"
import type { EndpointName } from "./route.js"

const HTTP_OK_MIN = 200
const HTTP_NO_CONTENT = 204
const HTTP_REDIRECT_MIN = 300
const HTTP_INTERNAL = 500
const JSON_CONTENT_TYPE = "application/json"
const ROOT_PATH_LABEL = "(root)"

export const CHECK_RESPONSES = process.env.NODE_ENV === "test"

function isJsonSuccess(statusCode: number, contentType: unknown): boolean {
  return (
    statusCode >= HTTP_OK_MIN &&
    statusCode < HTTP_REDIRECT_MIN &&
    statusCode !== HTTP_NO_CONTENT &&
    typeof contentType === "string" &&
    contentType.startsWith(JSON_CONTENT_TYPE)
  )
}

export function contractResponseCheck(name: EndpointName): onSendAsyncHookHandler {
  const schema = endpoints[name].response
  return async (request, reply, payload) => {
    if (
      typeof payload !== "string" ||
      !isJsonSuccess(reply.statusCode, reply.getHeader("content-type"))
    ) {
      return payload
    }
    const result = schema.safeParse(JSON.parse(payload))
    if (result.success) return payload

    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || ROOT_PATH_LABEL}: ${issue.message}`)
      .join("; ")
    const message = `${name} response does not match the contract: ${issues}`
    // The test logger is silent, and most route tests only assert the status code, so stderr is what
    // puts the drift in front of whoever reads the failing run.
    console.error(message)
    // Rewritten here rather than thrown: an async handler that calls reply.send() without returning it
    // races fastify's error path from onSend and the 500 goes out with an empty body.
    reply.code(HTTP_INTERNAL)
    return JSON.stringify({ code: ErrorCode.INTERNAL, message, requestId: request.id })
  }
}
