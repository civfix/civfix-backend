/**
 * Operator route guard for every `/admin/*` data route.
 *
 * The session's operator role claim alone is not enough: `users.role = 'operator'` persists, and every
 * login path (including the public citizen Email-OTP, Google and Apple flows) mints a session carrying it,
 * with CSRF skipped on the bearer transport. An off-boarded operator could otherwise sign in through the
 * consumer app and keep console access. So `ADMIN_EMAILS` is re-checked against the caller's current email
 * on every admin request: dropping an address revokes access regardless of which flow minted the session
 * or what `users.role` says.
 *
 * The verdict is cached in Redis so the check adds no Postgres read per request. Negative verdicts are
 * cached too, so a stranger's request storm cannot become a DB read storm.
 *
 * Fail-closed: a missing auth bundle, env, user row or email is a 403, and a cache or store error
 * propagates as a 500 rather than degrading to a pass.
 *
 * A stronger control would tag operator sessions with their mint origin and reject any not minted by the
 * admin Access exchange; that needs a session-record shape change, so the allowlist check is what ships.
 *
 * The /admin/auth/* routes are not guarded by this (they establish the session); routes/admin/index.ts
 * applies the preHandler to the data routers only.
 */

import { AppError } from "@civfix/shared"
import type { FastifyRequest } from "fastify"
import { requireAuth, requireRole } from "./context.js"
import { isAdminEmail } from "./admin-allowlist.js"

/**
 * The off-boarding staleness window: a removed operator keeps console access at most this long. Short
 * enough to be an effective revocation, long enough that a busy console session costs about one user
 * lookup per minute instead of one per request.
 */
export const OPERATOR_ALLOWLIST_TTL_SECONDS = 60

const OPERATOR_ALLOWLIST_PREFIX = "opallow:"

/** Checks only the session's role claim; admin data routes need assertOperatorAuthority. */
export function requireOperator(request: FastifyRequest): string {
  const userId = requireAuth(request)
  requireRole(request, "operator")
  return userId
}

/**
 * The cheap session-claim check runs first so an anonymous or citizen caller is rejected without any
 * lookup; only a caller already claiming `operator` reaches the allowlist resolution.
 */
export async function assertOperatorAuthority(request: FastifyRequest): Promise<string> {
  const userId = requireOperator(request)
  if (!(await isAllowlistedOperator(request, userId))) {
    // Deliberately the same generic 403 requireRole produces: an off-boarded operator learns only that they
    // are not authorized, not that the allowlist specifically is what rejected them.
    throw AppError.forbidden()
  }
  return userId
}

/**
 * routes/admin/index.ts installs this once on the encapsulated child context holding every admin data
 * router, so every admin data route is allowlist-checked deny-by-default.
 */
export async function requireOperatorPreHandler(request: FastifyRequest): Promise<void> {
  await assertOperatorAuthority(request)
}

async function isAllowlistedOperator(request: FastifyRequest, userId: string): Promise<boolean> {
  const services = request.server.authServices
  const env = request.server.container?.env
  // Without the auth bundle or env the allowlist cannot be evaluated, so no operator authority. In practice
  // unreachable: without the auth bundle no session resolves and requireAuth already 401'd.
  if (!services || !env) return false

  const key = OPERATOR_ALLOWLIST_PREFIX + userId
  const cached = await services.cache.get(key)
  if (cached !== null) return cached === "1"

  const user = await services.users.findById(userId)
  const allowed = user?.email != null && isAdminEmail(env, user.email)
  // A denied caller must not cost a user lookup per request either.
  await services.cache.set(key, allowed ? "1" : "0", OPERATOR_ALLOWLIST_TTL_SECONDS)
  return allowed
}
