/**
 * The ONE way to change a user's role (M4).
 *
 * A role write is only half a privilege change: the OLD role is baked into every live session's Redis
 * projection (auth/session-service.ts writes `{userId, roles, expiresAtMs}` at mint time and serves warm
 * hits from it without ever re-reading `users.role`). A role change that does not revoke sessions therefore
 * does not take effect until every existing session expires — and sliding expiry means an actively-used
 * session never expires at all.
 *
 * The admin users endpoint got this right (`sessions.revokeAll` after the write); the gov-claims approve
 * path did not, so a PRIOR OPERATOR moved to `gov_admin` kept full operator authority in every live session
 * indefinitely. Two call sites, two behaviours, one of them wrong.
 *
 * BOTH CONSOLE call sites go through here — gov-claims-service.approve and admin-user-service.setRole — so
 * "does an operator-driven role change revoke sessions?" is answered by this file alone. A `write` seam that
 * returns void is what makes that possible: setRole's repo call reports "user existed" as a boolean, and its
 * closure raises the 404 itself rather than teaching this helper about HTTP.
 *
 * ONE role write deliberately does NOT come through here: `provisionOperator` in routes/admin/auth.routes.ts
 * promotes the signing-in operator to `operator` during the Cloudflare-Access exchange, via the raw
 * `UserStore.setRole`. Revoking there would either kill the session being minted or log the operator out of
 * their own sign-in. It is also the only role write that cannot leak authority: it strictly ADDS a role, so
 * a stale warm session carrying the old (lesser) role under-privileges rather than over-privileges its
 * holder — the exact inverse of the demotion hazard above. Any NEW role writer that can lower a role, or
 * that runs outside a login exchange, belongs here.
 *
 * Ordering: write first, then revoke. The reverse would leave a window in which the old sessions are gone
 * but the old role is still live (a re-login inside that window re-mints the OLD role). Writing first means
 * a failure of the revoke surfaces to the caller with the role already changed — the recoverable direction,
 * because the revoke IS idempotent: SessionService.revokeAllForUser bumps the user's revocation epoch
 * BEFORE it deletes any row, and every cached session projection is checked against that epoch on every
 * hit, so the privilege is gone the instant the epoch moves — whether or not the Redis eviction that
 * follows succeeds, and whether or not a retry ever runs. A swallowed revoke error is still NOT acceptable
 * here, so this helper deliberately does not catch.
 */

import type { Role } from "@civfix/shared"

/** The narrow session-revocation seam a role change needs (SessionService.revokeAllForUser in production). */
export type RevokeAllSessions = (userId: string) => Promise<number>

export interface ApplyRoleChangeDeps {
  /** Persist the new role (and, where the repo supports it, its audit row in the same transaction). */
  write: (userId: string, role: Role) => Promise<void>
  /** Revoke every live session of the user so no warm session keeps serving the OLD role. */
  revokeAll: RevokeAllSessions
}

/**
 * Change `userId`'s role and revoke all of their sessions. EVERY role write in the admin domain goes through
 * here. Returns the number of sessions revoked (0 when the user had none).
 */
export async function applyRoleChange(
  deps: ApplyRoleChangeDeps,
  userId: string,
  role: Role,
): Promise<number> {
  await deps.write(userId, role)
  return deps.revokeAll(userId)
}
