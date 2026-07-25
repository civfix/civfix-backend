/**
 * Operator route guard (Phase 2 admin dashboard).
 *
 * `requireOperator(request)` is the SESSION-CLAIM half of the authz gate for every `/admin/*` DATA route:
 * it runs requireAuth (401 when no session) then requireRole(request, "operator") (403 when the session is
 * not an operator). It returns the operator's userId for handler convenience, mirroring requireAuth.
 *
 * H2 (2026-07-24 security review) — that half ALONE is not sufficient. Operator authority used to be a
 * purely persistent `users.role = 'operator'` row, and the Cloudflare-Access + `ADMIN_EMAILS` gate was
 * checked ONLY at login (routes/admin/auth.routes.ts). Consequences:
 *   - ANY auth path mints a session carrying roles:["operator"] once the row exists — including the PUBLIC
 *     citizen Email-OTP / Google / Apple login. An off-boarded operator (removed from ADMIN_EMAILS, their
 *     Cloudflare Access account disabled) could simply sign in through the consumer app and keep full
 *     console access; with `X-Client: mobile` the bearer transport also skips CSRF.
 *   - Removing an email from ADMIN_EMAILS never demoted the row, so the allowlist was not actually an
 *     off-boarding control.
 *
 * The fix implemented here turns the allowlist into an AUTHORIZATION check that runs on EVERY admin
 * request, not just at login: `assertOperatorAuthority` resolves the caller's user row and requires
 * `isAdminEmail(env, user.email)`. `ADMIN_EMAILS` is now the single source of operator truth — dropping an
 * address from it revokes console access on the next request (bounded by the cache TTL below), regardless
 * of which login flow minted the session and regardless of what `users.role` says.
 *
 * COST: the check must not add a Postgres read to every admin request, so the boolean verdict is cached in
 * Redis (the same CacheClient the session write-through cache uses) under `opallow:<userId>` for
 * OPERATOR_ALLOWLIST_TTL_SECONDS. Both verdicts are cached: a negative verdict is cached too, so a
 * stranger's request storm cannot turn into a DB read storm. The TTL is the staleness window — an
 * off-boarded operator keeps access for at most that long, which is the deliberate trade against a
 * per-request user lookup. Kept short (60s) so off-boarding is effectively immediate.
 *
 * FAIL-CLOSED: any failure to establish the caller's identity (no auth bundle, no container/env, no user
 * row, no email on the row) is a 403, never a pass. A thrown cache/store error propagates (500) rather than
 * degrading to a pass.
 *
 * NOT IMPLEMENTED HERE (see the security report): the stronger control is tagging operator sessions with
 * their mint ORIGIN (`origin: "cf-access"`) at createSession time and rejecting any operator session not
 * minted by the admin Access exchange. That needs a session-record shape change in auth/session-service.ts
 * + auth/stores.ts, which are owned elsewhere; the email allowlist check below is the shipped control.
 *
 * The admin AUTH routes (/admin/auth/*) are explicitly NOT guarded by this (they establish the session);
 * see routes/admin/index.ts, which applies the preHandler below to the data routers only.
 */

import { AppError } from "@civfix/shared"
import type { FastifyRequest } from "fastify"
import { requireAuth, requireRole } from "./context.js"
import { isAdminEmail } from "./admin-allowlist.js"

/**
 * How long an allowlist verdict (positive OR negative) is cached per user. The staleness window for
 * off-boarding: after removing an address from ADMIN_EMAILS, a live operator session loses console access
 * within this many seconds. Short enough to be an effective revocation, long enough that a normal console
 * session (dozens of requests per minute) costs ~1 user lookup per minute instead of one per request.
 */
export const OPERATOR_ALLOWLIST_TTL_SECONDS = 60

/** Redis key namespace for the cached per-user operator-allowlist verdict. */
const OPERATOR_ALLOWLIST_PREFIX = "opallow:"

/** Assert an authenticated operator session CLAIM (401 no session / 403 not operator); returns the userId. */
export function requireOperator(request: FastifyRequest): string {
  const userId = requireAuth(request)
  requireRole(request, "operator")
  return userId
}

/**
 * The FULL operator gate (H2): the session claim check above PLUS a live `ADMIN_EMAILS` authorization
 * check against the caller's current email. Returns the operator's userId.
 *
 * Ordering matters: the cheap session-claim check runs first so an anonymous or citizen caller is rejected
 * without any lookup at all; only a caller already claiming `operator` reaches the allowlist resolution.
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
 * Fastify preHandler form of the full gate, suitable for `{ preHandler: requireOperatorPreHandler }`.
 * routes/admin/index.ts installs this ONCE on the encapsulated child context holding every admin data
 * router, so every admin data route is allowlist-checked deny-by-default.
 */
export async function requireOperatorPreHandler(request: FastifyRequest): Promise<void> {
  await assertOperatorAuthority(request)
}

/**
 * Whether `userId`'s CURRENT email is in `env.ADMIN_EMAILS`, cached per user for
 * OPERATOR_ALLOWLIST_TTL_SECONDS. Fail-closed: returns false when the auth bundle, the container/env, the
 * user row or the row's email is missing. Cache read/write failures are NOT swallowed (they propagate to a
 * 500) — a Redis outage must not silently disable the check.
 */
async function isAllowlistedOperator(request: FastifyRequest, userId: string): Promise<boolean> {
  const services = request.server.authServices
  const env = request.server.container?.env
  // No auth bundle / no env => we cannot evaluate the allowlist, so we cannot grant operator authority.
  // (In practice unreachable: without the auth bundle no session resolves and requireAuth already 401'd.)
  if (!services || !env) return false

  const key = OPERATOR_ALLOWLIST_PREFIX + userId
  const cached = await services.cache.get(key)
  if (cached !== null) return cached === "1"

  const user = await services.users.findById(userId)
  const allowed = user?.email != null && isAdminEmail(env, user.email)
  // Cache BOTH verdicts (see the file header): a denied caller must not cost a user lookup per request.
  await services.cache.set(key, allowed ? "1" : "0", OPERATOR_ALLOWLIST_TTL_SECONDS)
  return allowed
}
