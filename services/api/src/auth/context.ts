/**
 * Auth context resolution.
 *
 * An onRequest hook resolves `req.auth` for EVERY request before any route handler runs:
 *   - read the presented session token from Authorization: Bearer (mobile) or the session cookie
 *     (web), via the transport helper;
 *   - if present and SessionService.resolveSession succeeds, attach {userId, roles, anon:false}
 *     (this is the Redis-backed probe: a warm session never touches Postgres);
 *   - otherwise attach the anonymous context {userId:null, roles:[], anon:true}, additionally
 *     carrying the anon-session id from the anon cookie when present (anon-token ISSUANCE is a later
 *     step; we only read it here so as not to break it).
 *
 * The auth services bundle is attached to the app via decorate("authServices", ...) by the auth
 * route plugin; the hook reads it from the request's server instance. requireAuth/requireRole are
 * unchanged so existing call sites keep working.
 */

import { AppError } from "@civfix/shared"
import type { AuthContext } from "@civfix/shared"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { AuthServices } from "./auth-services.js"
import { ANON_COOKIE, presentedSessionToken } from "./transport.js"

declare module "fastify" {
  interface FastifyRequest {
    /** Resolved auth context. Always present after the auth onRequest hook runs. */
    auth: AuthContext
  }
  interface FastifyInstance {
    /** The auth service bundle, attached by the auth route plugin. */
    authServices: AuthServices
  }
}

/** The default anonymous context used when no live session is presented. */
export function anonymousAuth(anonSessionId?: string): AuthContext {
  return {
    userId: null,
    roles: [],
    anon: true,
    ...(anonSessionId !== undefined ? { anonSessionId } : {}),
  }
}

/**
 * Register the auth decorator + onRequest hook. Decorating with a declare-only default and assigning
 * per request is the Fastify-recommended pattern for request-scoped state.
 */
export async function registerAuthContext(app: FastifyInstance): Promise<void> {
  app.decorateRequest("auth")

  app.addHook("onRequest", async (request: FastifyRequest) => {
    request.auth = await resolveAuthContext(request)
  })
}

/**
 * Resolve the auth context for a request. Exposed (not just inlined) so it can be unit-tested with a
 * synthetic request. Falls back to anonymous on any resolution miss.
 */
export async function resolveAuthContext(request: FastifyRequest): Promise<AuthContext> {
  // The anon cookie (if any) is surfaced on the context regardless of auth outcome.
  const anonCookie = request.cookies?.[ANON_COOKIE]

  const services: AuthServices | undefined = request.server.authServices
  const token = presentedSessionToken(request)
  if (services && token) {
    // H2 defense-in-depth + V1: resolveSession itself vetoes a banned account (a single Redis read,
    // never Postgres) BEFORE it slides the session expiry, so a missed-revoke session cannot be extended
    // past the banned marker and a banned user resolves to null here. The warm-session Redis-only
    // property is preserved for active users (no store read is added on the hot path).
    const resolved = await services.sessions.resolveSession(token)
    if (resolved) {
      return { userId: resolved.userId, roles: resolved.roles, anon: false }
    }
  }
  return anonymousAuth(anonCookie)
}

/**
 * Guard for authenticated routes. Throws AppError.unauthorized() when there is no resolved userId;
 * returns the userId for convenience when present.
 */
export function requireAuth(request: FastifyRequest): string {
  const userId = request.auth?.userId
  if (!userId) {
    throw AppError.unauthorized()
  }
  return userId
}

/**
 * Guard that asserts the caller holds at least one of the given roles. Throws forbidden otherwise.
 */
export function requireRole(request: FastifyRequest, ...roles: AuthContext["roles"]): void {
  const held = request.auth?.roles ?? []
  if (!roles.some((r) => held.includes(r))) {
    throw AppError.forbidden()
  }
}
