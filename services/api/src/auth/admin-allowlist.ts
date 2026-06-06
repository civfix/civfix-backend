/**
 * Operator allowlist check (Phase 2 admin auth).
 *
 * The only gate that decides whether an email may sign in to the admin dashboard. `env.ADMIN_EMAILS`
 * is already normalized (trimmed, lowercased, de-duplicated) by the env loader, so this is a pure
 * normalized membership test. An EMPTY allowlist means NO ONE is an admin (every check is false), which
 * is the documented "no admin can log in" default.
 *
 * Keep this trivial and dependency-free: the admin OTP request route calls it to decide whether to
 * issue a code WITHOUT revealing membership (no email enumeration), and the verify route calls it to
 * grant the operator role + reject any non-allowlisted verified email.
 */

import type { Env } from "../env.js"

/** True when `email` (case-insensitively, trimmed) is in env.ADMIN_EMAILS. Empty allowlist => false. */
export function isAdminEmail(env: Pick<Env, "ADMIN_EMAILS">, email: string): boolean {
  const normalized = email.trim().toLowerCase()
  if (normalized.length === 0) return false
  return env.ADMIN_EMAILS.includes(normalized)
}
