/**
 * Fastify error handler that renders the canonical AppError wire envelope.
 *
 *   AppError            -> { statusCode, body: { code, message, requestId, fields? } }
 *   ZodError            -> 422 VALIDATION (structural match: a ZodError thrown outside a route's
 *                          parse() wrapper would otherwise fall through to 500)
 *   Fastify validation  -> 422 VALIDATION with field details
 *   anything else        -> mapped client code (<500) or 500 INTERNAL (message hidden in production)
 *
 * A 5xx AppError's message is hidden in production too, unless the error was marked with exposeMessage()
 * or the route is on the operator plane, whose console needs the diagnostic.
 *
 * Every unknown (non-AppError, or AppError with httpStatus >= 500) error is forwarded to
 * GlitchTip/Sentry via captureError. There are NO silent catches: the handler always logs and responds.
 */

import { AppError, ErrorCode } from "@civfix/shared"
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify"
import { isProd } from "../env.js"
import { loggedRequestUrl } from "../lib/request-url.js"
import { isMessageExposed } from "./exposed-message.js"
import { captureError } from "./glitchtip.js"

const INTERNAL_ERROR_MESSAGE = "Internal error"

// Operator routes sit behind Cloudflare Access and the operator guard, and the console shows server-side
// diagnostics (an SMTP rejection, a misconfigured provider) that the operator is there to fix.
const OPERATOR_ROUTE_PREFIX = "/v1/admin/"

interface ErrorBody {
  code: ErrorCode
  message: string
  requestId: string
  fields?: Record<string, string>
}

// A non-AppError client error carries its honest HTTP status; map it to the matching wire code so the
// typed client's status->code reverse-map agrees. Unmapped <500 falls back to VALIDATION.
const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: ErrorCode.VALIDATION,
  401: ErrorCode.UNAUTHORIZED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  410: ErrorCode.API_VERSION_SUNSET,
  415: ErrorCode.VALIDATION,
  422: ErrorCode.VALIDATION,
  429: ErrorCode.RATE_LIMITED,
}

function fieldsFromValidation(err: FastifyError): Record<string, string> {
  const out: Record<string, string> = {}
  const validation = err.validation ?? []
  for (const v of validation) {
    // instancePath looks like "/body/email"; reduce to the last path segment.
    const path = (v.instancePath || "").split("/").filter(Boolean)
    const key = path.length > 0 ? path[path.length - 1]! : (v.params?.missingProperty ?? "_")
    out[String(key)] = v.message ?? "invalid"
  }
  return out
}

export function makeErrorHandler() {
  return function errorHandler(
    error: FastifyError | AppError | Error,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    const requestId = request.id

    if (error instanceof AppError) {
      error.requestId = requestId
      const body: ErrorBody = {
        code: error.code,
        message: serverMessageHidden(error, request) ? INTERNAL_ERROR_MESSAGE : error.message,
        requestId,
        ...(error.fields ? { fields: error.fields } : {}),
      }
      if (error.httpStatus >= 500) {
        request.log.error({ err: error, requestId }, "AppError (server)")
        captureError(error, {
          requestId,
          url: loggedRequestUrl(request.url),
          method: request.method,
        })
      } else {
        request.log.info({ code: error.code, requestId }, "AppError (client)")
      }
      reply.status(error.httpStatus).send(body)
      return
    }

    // Structural ZodError match (NOT instanceof) so it survives the dual-zod-realm boundary between
    // @civfix/shared's zod and the API's zod: a ZodError thrown outside a route parse() (service-level
    // parse / .transform / nested parse) reaches the handler and must render as 422, never 500.
    if (error.name === "ZodError" && Array.isArray((error as { issues?: unknown }).issues)) {
      const issues = (
        error as unknown as { issues: { path: (string | number)[]; message: string }[] }
      ).issues
      const fields: Record<string, string> = {}
      for (const i of issues) fields[i.path.length ? i.path.join(".") : "_"] = i.message
      request.log.info({ requestId, fields }, "zod validation error")
      const body: ErrorBody = {
        code: ErrorCode.VALIDATION,
        message: "Validation failed",
        requestId,
        fields,
      }
      reply.status(422).send(body)
      return
    }

    const fastifyErr = error as FastifyError
    if (fastifyErr.validation && fastifyErr.validation.length > 0) {
      const fields = fieldsFromValidation(fastifyErr)
      request.log.info({ requestId, fields }, "validation error")
      const body: ErrorBody = {
        code: ErrorCode.VALIDATION,
        message: "Validation failed",
        requestId,
        fields,
      }
      reply.status(422).send(body)
      return
    }

    const statusCode = typeof fastifyErr.statusCode === "number" ? fastifyErr.statusCode : 500
    if (statusCode < 500) {
      request.log.info({ requestId, statusCode }, "client error")
      const code = STATUS_TO_CODE[statusCode] ?? ErrorCode.VALIDATION
      const body: ErrorBody = {
        code,
        message: error.message || "Request error",
        requestId,
      }
      reply.status(statusCode).send(body)
      return
    }

    request.log.error({ err: error, requestId }, "unhandled error")
    captureError(error, { requestId, url: loggedRequestUrl(request.url), method: request.method })
    const body: ErrorBody = {
      code: ErrorCode.INTERNAL,
      message: isProd() ? INTERNAL_ERROR_MESSAGE : (error.message ?? INTERNAL_ERROR_MESSAGE),
      requestId,
    }
    reply.status(500).send(body)
  }
}

function serverMessageHidden(error: AppError, request: FastifyRequest): boolean {
  if (error.httpStatus < 500 || !isProd()) return false
  if (isMessageExposed(error)) return false
  const routePattern = request.routeOptions.url ?? ""
  return !routePattern.startsWith(OPERATOR_ROUTE_PREFIX)
}

export function makeNotFoundHandler() {
  return function notFoundHandler(request: FastifyRequest, reply: FastifyReply): void {
    request.log.info(
      { method: request.method, url: loggedRequestUrl(request.url), requestId: request.id },
      "route not found",
    )
    const body: ErrorBody = {
      code: ErrorCode.NOT_FOUND,
      // Prod: static (stealth). Dev/test: echo method+url so route-coverage can tell an
      // unregistered-endpoint 404 apart from a domain (AppError) 404.
      message: isProd() ? "Not found" : `Route ${request.method} ${request.url} not found`,
      requestId: request.id,
    }
    reply.status(404).send(body)
  }
}
