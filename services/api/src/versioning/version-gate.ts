/**
 * API version gate.
 *
 * A single `onRequest` hook that inspects the FIRST path segment of every request and enforces the
 * served-versions policy (see ./policy.ts):
 *
 *   - segment is NOT a `/vN` (e.g. `/healthz`, `/auth/google/start`, `/ws`, `/webhooks/inbound-mail`)
 *       → pass straight through. These are system / deliberately-unversioned paths; the gate owns only
 *         the versioned namespace.
 *   - segment is a served, `current` version → allow.
 *   - segment is a served, `deprecated` version → allow, and attach `Deprecation: true` (plus
 *     `Sunset: <HTTP-date>` when a sunset date is configured) to the response — RFC 8594 signaling. The
 *     headers are set here in `onRequest` (not `onSend`) so they ride along with whatever the handler
 *     ultimately returns, including error responses, without re-touching an already-sent reply.
 *   - segment is a known-but-`sunset` version → 410 (AppError.apiVersionSunset()).
 *   - segment is an unknown `vN`, or a `vN` below MIN_SUPPORTED_VERSION → 400
 *     (AppError.unsupportedApiVersion()).
 *
 * Throwing AppError routes through the app's error handler into the standard wire envelope (the new
 * codes already carry their 400/410 status via ERROR_HTTP_STATUS). Today, with only `v1 = current`, the
 * single active behavior is rejecting malformed/unknown `/vN` segments, which is desirable immediately.
 *
 * Registered as a plain async `registerVersionGate(app)` to match the repo's plugin convention (no
 * `fastify-plugin`; cross-cutting hooks are added directly in buildServer), before routes, so it runs at
 * `onRequest` ahead of any handler.
 */

import { AppError } from "@civfix/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import {
  isBelowMinSupported,
  isServedVersion,
  isVersionSegment,
  validateVersionPolicy,
  versionStatus,
} from "./policy.js"

/** Extract the first path segment of a URL, ignoring any query string. e.g. "/v1/reports?x=1" → "v1". */
function firstPathSegment(url: string): string {
  const queryStart = url.indexOf("?")
  const path = queryStart === -1 ? url : url.slice(0, queryStart)
  // path always starts with "/"; return the first non-empty segment.
  for (const seg of path.split("/")) {
    if (seg.length > 0) return seg
  }
  return ""
}

/**
 * Register the version gate: an `onRequest` hook enforcing the served-versions policy and, for a
 * deprecated version, attaching the `Deprecation`/`Sunset` response headers.
 */
export async function registerVersionGate(app: FastifyInstance): Promise<void> {
  // Fail boot on an inconsistent policy (served/min version missing or sunset) rather than at request time.
  validateVersionPolicy()
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const seg = firstPathSegment(request.url)

    // Not a versioned path (system / unversioned route) → nothing to enforce.
    if (!isVersionSegment(seg)) return

    // A well-formed vN below the supported floor is unsupported regardless of the lifecycle map.
    if (isBelowMinSupported(seg)) {
      throw AppError.unsupportedApiVersion()
    }

    const status = versionStatus(seg)
    if (status === null) {
      // A vN the contract does not define at all.
      throw AppError.unsupportedApiVersion()
    }

    // SERVED_VERSIONS is the operational on/off switch (single source of truth): a contract-defined but
    // not-served version is rejected here, regardless of its lifecycle entry.
    if (!isServedVersion(seg)) {
      throw status.status === "sunset"
        ? AppError.apiVersionSunset()
        : AppError.unsupportedApiVersion()
    }

    switch (status.status) {
      case "current":
        return
      case "deprecated":
        // RFC 8594: `Deprecation: true` flags the version as deprecated; the optional `Sunset` header
        // (HTTP-date) names when it stops being served. Set on the reply now so it survives to the
        // response (including error responses) without an onSend pass over an already-sent reply.
        reply.header("Deprecation", "true")
        if (status.sunset) {
          const sunsetDate = new Date(status.sunset)
          if (!Number.isNaN(sunsetDate.getTime())) {
            reply.header("Sunset", sunsetDate.toUTCString())
          }
        }
        return
      case "sunset":
        throw AppError.apiVersionSunset()
      default: {
        // A new VersionLifecycle member must declare its handling above; this never-assignment makes the
        // omission a compile error, and the throw fails closed rather than falling through to allow.
        const _exhaustive: never = status.status
        return _exhaustive
      }
    }
  })
}
