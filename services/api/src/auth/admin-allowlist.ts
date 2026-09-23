/**
 * The only gate that decides whether an email may sign in to the admin dashboard. The env loader already
 * normalizes ADMIN_EMAILS, and an empty list means no one is an admin.
 *
 * The Cloudflare Access exchange checks the email verified by the Access JWT against this list: in-app
 * authorization on top of the edge's Access authentication.
 */

import type { Env } from "../env.js"

export function isAdminEmail(env: Pick<Env, "ADMIN_EMAILS">, email: string): boolean {
  const normalized = email.trim().toLowerCase()
  if (normalized.length === 0) return false
  return env.ADMIN_EMAILS.includes(normalized)
}
