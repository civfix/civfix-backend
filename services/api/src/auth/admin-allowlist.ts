/**
 * Operator allowlist check (Phase 2 admin auth).
 *
 * The only gate that decides whether an email may sign in to the admin dashboard. `env.ADMIN_EMAILS`
 * is already normalized (trimmed, lowercased, de-duplicated) by the env loader, so this is a pure
 * normalized membership test. An EMPTY allowlist means NO ONE is an admin (every check is false), which
 * is the documented "no admin can log in" default.
 *
 * The Cloudflare Access exchange route authorizes the email verified by the Access JWT against this
 * list — the in-app authorization gate complementing the edge Access authentication (doc 16).
 */

import type { Env } from "../env.js"

/** True when `email` (case-insensitively, trimmed) is in env.ADMIN_EMAILS. Empty allowlist => false. */
export function isAdminEmail(env: Pick<Env, "ADMIN_EMAILS">, email: string): boolean {
  const normalized = email.trim().toLowerCase()
  if (normalized.length === 0) return false
  return env.ADMIN_EMAILS.includes(normalized)
}
