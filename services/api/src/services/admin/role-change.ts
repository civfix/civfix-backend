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
 * indefinitely. Two call sites, two behaviours, one of them wrong. The gov-claims path now calls this
 * helper, so the ordering below cannot be forgotten there again.
 *
 * NOT AN INVARIANT — read this before trusting the paragraph above. This is NOT yet the only role-write
 * path in the admin domain. `services/admin/admin-user-service.ts` (setRole) still does the write and the
 * revoke INLINE: `repo.applyRole(...)` followed by `sessions.revokeAll(...)`. It behaves identically today,
 * but it is a second implementation of the same rule and nothing enforces that the two stay in step. The
 * reason it was not folded in is small and concrete: `applyRole` returns a "user existed" boolean that the
 * caller turns into a 404, and this helper's `write` seam returns `void`, so routing it through here means
 * wrapping the call in a `write` closure that throws `AppError.notFound` itself — a ~10-line change, not a
 * one-liner. Until that lands, a reviewer checking "does every role change revoke sessions?" must read
 * BOTH files, not just this one.
 *
 * Ordering: write first, then revoke. The reverse would leave a window in which the old sessions are gone
 * but the old role is still live (a re-login inside that window re-mints the OLD role). Writing first means
 * a failure of the revoke surfaces to the caller with the role already changed — the recoverable direction:
 * the operator retries and the revoke is idempotent. A swallowed revoke error is NOT acceptable here, so
 * this helper deliberately does not catch.
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
 * Change `userId`'s role and revoke all of their sessions. Every NEW role write in the admin domain must
 * go through here (admin-user-service.setRole is the one pre-existing exception — see the module header).
 * Returns the number of sessions revoked (0 when the user had none).
 */
export async function applyRoleChange(
  deps: ApplyRoleChangeDeps,
  userId: string,
  role: Role,
): Promise<number> {
  await deps.write(userId, role)
  return deps.revokeAll(userId)
}
