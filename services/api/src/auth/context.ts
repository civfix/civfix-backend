/**
 * Auth context decoration.
 *
 * SCAFFOLD: this attaches a PLACEHOLDER anonymous AuthContext to every request. Real session
 * resolution (signed session cookie -> userId/roles, anon token -> anonSessionId) lands in the auth
 * step, which will replace the body of the onRequest hook below. The decorator + type augmentation
 * are stable so later route code can rely on `req.auth` and `requireAuth(req)` today.
 */

import { AppError } from "@civfix/shared"
import type { AuthContext } from "@civfix/shared"
import type { FastifyInstance, FastifyRequest } from "fastify"

declare module "fastify" {
  interface FastifyRequest {
    /** Resolved auth context. Always present after the auth onRequest hook runs. */
    auth: AuthContext
  }
}

/** The default anonymous context used until real auth resolution is implemented. */
export function anonymousAuth(): AuthContext {
  return { userId: null, roles: [], anon: true }
}

/**
 * Register the auth decorator + onRequest hook. Decorating with a getter-less default and then
 * assigning per request is the Fastify-recommended pattern for request-scoped state.
 */
export async function registerAuthContext(app: FastifyInstance): Promise<void> {
  // Declare the property so Fastify allocates the slot on every request object. The onRequest hook
  // below assigns a real value before any route handler runs. Using the declare-only overload keeps
  // the decorated type as AuthContext (no `| null`).
  app.decorateRequest("auth")

  app.addHook("onRequest", async (request: FastifyRequest) => {
    // PLACEHOLDER: always anonymous. Real resolution comes later.
    request.auth = anonymousAuth()
  })
}

/**
 * Guard used by later authenticated routes. Throws AppError.unauthorized() when there is no
 * resolved userId. Returns the userId for convenience when present.
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
 * Provided now so later route steps share one definition.
 */
export function requireRole(request: FastifyRequest, ...roles: AuthContext["roles"]): void {
  const held = request.auth?.roles ?? []
  if (!roles.some((r) => held.includes(r))) {
    throw AppError.forbidden()
  }
}
