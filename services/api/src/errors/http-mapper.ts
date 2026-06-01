/**
 * Fastify error handler that renders the canonical AppError wire envelope.
 *
 *   AppError            -> { statusCode, body: { code, message, requestId, fields? } }
 *   Fastify validation  -> 422 VALIDATION with field details
 *   anything else       -> 500 INTERNAL (message hidden in production), with requestId
 *
 * Every unknown (non-AppError, or AppError with httpStatus >= 500) error is forwarded to
 * GlitchTip/Sentry via captureError (no-op when no DSN). There are NO silent catches: the handler
 * always logs and always responds.
 */

import { AppError, ErrorCode } from "@civfix/shared"
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify"
import { captureError } from "./glitchtip.js"

interface ErrorBody {
  code: ErrorCode
  message: string
  requestId: string
  fields?: Record<string, string>
}

/** Map a Fastify schema-validation error into field-keyed messages. */
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

/**
 * Build the Fastify error handler. Logging uses the per-request logger; production-mode message
 * hiding is driven by NODE_ENV.
 */
export function makeErrorHandler() {
  const isProd = process.env.NODE_ENV === "production"

  return function errorHandler(
    error: FastifyError | AppError | Error,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    const requestId = request.id

    // 1) Our own typed errors render directly.
    if (error instanceof AppError) {
      error.requestId = requestId
      const body: ErrorBody = {
        code: error.code,
        message: error.message,
        requestId,
        ...(error.fields ? { fields: error.fields } : {}),
      }
      if (error.httpStatus >= 500) {
        request.log.error({ err: error, requestId }, "AppError (server)")
        captureError(error, { requestId, url: request.url, method: request.method })
      } else {
        request.log.info({ code: error.code, requestId }, "AppError (client)")
      }
      reply.status(error.httpStatus).send(body)
      return
    }

    // 2) Fastify validation errors -> VALIDATION (422).
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

    // 3) Fastify's own rate-limit / known statusCode errors (e.g. 429, 400) pass through honestly.
    const statusCode = typeof fastifyErr.statusCode === "number" ? fastifyErr.statusCode : 500
    if (statusCode < 500) {
      request.log.info({ requestId, statusCode }, "client error")
      const code = statusCode === 429 ? ErrorCode.RATE_LIMITED : ErrorCode.VALIDATION
      const body: ErrorBody = {
        code,
        message: error.message || "Request error",
        requestId,
      }
      reply.status(statusCode).send(body)
      return
    }

    // 4) Everything else is an unexpected server error.
    request.log.error({ err: error, requestId }, "unhandled error")
    captureError(error, { requestId, url: request.url, method: request.method })
    const body: ErrorBody = {
      code: ErrorCode.INTERNAL,
      message: isProd ? "Internal error" : (error.message ?? "Internal error"),
      requestId,
    }
    reply.status(500).send(body)
  }
}

/**
 * Not-found handler so missing routes return the same envelope as everything else.
 */
export function makeNotFoundHandler() {
  return function notFoundHandler(request: FastifyRequest, reply: FastifyReply): void {
    const body: ErrorBody = {
      code: ErrorCode.NOT_FOUND,
      message: `Route ${request.method} ${request.url} not found`,
      requestId: request.id,
    }
    reply.status(404).send(body)
  }
}
