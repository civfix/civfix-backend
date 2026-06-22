/**
 * Operator route guard (Phase 2 admin dashboard).
 *
 * `requireOperator(request)` is the single authz gate for every `/admin/*` DATA route: it runs
 * requireAuth (401 when no session) then requireRole(request, "operator") (403 when the session is not
 * an operator). It returns the operator's userId for handler convenience, mirroring requireAuth.
 *
 * The admin AUTH routes (/admin/auth/*) are explicitly NOT guarded by this (they establish the
 * session); see routes/admin/index.ts, which applies this as a preHandler to the data routers only.
 */

import type { FastifyRequest } from "fastify"
import { requireAuth, requireRole } from "./context.js"

/** Assert an authenticated operator session (401 no session / 403 not operator); returns the userId. */
export function requireOperator(request: FastifyRequest): string {
  const userId = requireAuth(request)
  requireRole(request, "operator")
  return userId
}

/**
 * Fastify preHandler form of requireOperator, suitable for `{ preHandler: requireOperatorPreHandler }`.
 * Kept async so it composes cleanly with other async preHandlers (csrfProtect) in an array.
 */
export async function requireOperatorPreHandler(request: FastifyRequest): Promise<void> {
  requireOperator(request)
}
