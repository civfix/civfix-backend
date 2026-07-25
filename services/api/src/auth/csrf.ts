/**
 * CSRF protection for the cookie (web) transport, bound to the session it protects.
 *
 * The web sign-in response sets two cookies: the httpOnly session cookie (not readable by JS) and a
 * readable CSRF cookie. On a state-changing request that authenticates via the SESSION COOKIE, the
 * client must echo the CSRF value in the `X-CSRF-Token` header.
 *
 * The token is NOT an independent random value (L3). Pure double-submit proves only that the caller
 * could read *a* CSRF cookie for this site — and anything that can WRITE cookies the API will accept
 * (a compromised sibling subdomain, an XSS on any *.civfix.org host, a MITM on a plain-http sibling)
 * can plant a CSRF cookie of its own choosing and then send the matching header, because nothing tied
 * the cookie to the victim's session. So the token is DERIVED: it is an HMAC-SHA256 over the session
 * id (the SHA-256 of the presented session token, i.e. exactly the value stored as sessions.id) keyed
 * by SESSION_SIGNING_KEY. A valid token can therefore only be produced by this server, and only for
 * one specific session — a token planted or captured for any other session simply does not verify.
 * The cookie remains the delivery mechanism, but verification is against the derived value, so the
 * cookie itself is no longer trusted as the source of truth.
 *
 * Bearer (mobile) requests are EXEMPT: they carry no ambient cookie, so there is nothing for a
 * browser to attach automatically and CSRF does not apply. The preHandler therefore only enforces
 * when a session cookie is present and no bearer token is used.
 */

import { createHmac } from "node:crypto"
import { AppError } from "@civfix/shared"
import type { FastifyReply, FastifyRequest } from "fastify"
import { constantTimeStringEqual, generateToken, sha256Hex } from "./crypto.js"
import { csrfCookieName, csrfCookieValue, sessionCookieValue, bearerToken, CSRF_COOKIE, CSRF_COOKIE_HOST } from "./transport.js"
import { env, isProd } from "../env.js"

/** Header carrying the echoed CSRF token on state-changing cookie requests. */
export const CSRF_HEADER = "x-csrf-token"

/**
 * Path prefix of the operator console's API surface, which still mints UNBOUND random CSRF tokens (see
 * generateCsrfToken). Requests under it are allowed to fall back to the old double-submit comparison so
 * the console keeps working; everything else requires a session-bound token. DELETE the fallback (and
 * this constant) as soon as the admin sign-in path issues csrfTokenForSession values — the admin surface
 * is the one that most wants the stronger check.
 */
const LEGACY_DOUBLE_SUBMIT_PATH_PREFIX = "/v1/admin/"

/** Domain separation: the signing key is shared with cookie signing, so label what is being signed. */
const CSRF_HMAC_LABEL = "civfix-csrf-v1:"

/**
 * Derive the CSRF token for the session carried by `sessionToken`. Deterministic, so it never needs to
 * be stored: the same session always yields the same token, and no other session can yield it.
 */
export async function csrfTokenForSession(sessionToken: string): Promise<string> {
  const sessionId = await sha256Hex(sessionToken)
  return createHmac("sha256", env.SESSION_SIGNING_KEY)
    .update(CSRF_HMAC_LABEL + sessionId)
    .digest("base64url")
}

/**
 * Generate an UNBOUND random CSRF token. LEGACY: kept only for the operator-console sign-in path, which
 * has not been moved to csrfTokenForSession yet. New callers must use csrfTokenForSession — a token that
 * is not tied to a session is a token an attacker who can write cookies for this site can also supply.
 */
export function generateCsrfToken(): string {
  return generateToken()
}

/**
 * Set the readable CSRF cookie. NOT httpOnly (the SPA reads it to echo in the header) but still
 * SameSite=Lax + Secure-in-prod so it is not sent on cross-site navigations or over plain HTTP. The
 * name carries the `__Host-` prefix in production — see the migration note in transport.ts.
 */
export function setCsrfCookie(reply: FastifyReply, token: string, maxAgeSeconds: number): void {
  reply.setCookie(csrfCookieName(), token, {
    httpOnly: false,
    sameSite: "lax",
    secure: isProd(),
    path: "/",
    maxAge: maxAgeSeconds,
  })
}

/** Clear the CSRF cookie (used on logout alongside the session cookie), under BOTH names. */
export function clearCsrfCookie(reply: FastifyReply): void {
  reply.clearCookie(CSRF_COOKIE, { path: "/" })
  reply.clearCookie(CSRF_COOKIE_HOST, { path: "/", secure: true })
}

/**
 * preHandler that enforces session-bound CSRF on cookie-authenticated, state-changing requests.
 *
 * Skips entirely when:
 *   - the request uses a bearer token (mobile; no ambient cookie), or
 *   - there is no session cookie (anonymous / unauthenticated request).
 *
 * Otherwise requires that `X-CSRF-Token` is present and constant-time-equal to the token DERIVED from
 * the session cookie actually presented on this request. The CSRF cookie is not consulted: it is only
 * how the token reaches the client.
 */
export async function csrfProtect(request: FastifyRequest): Promise<void> {
  // Bearer transport is exempt.
  if (bearerToken(request) !== null) return

  const sessionCookie = sessionCookieValue(request)
  if (sessionCookie === null) return // No cookie session => nothing to protect against here.

  const headerValue = request.headers[CSRF_HEADER]
  const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue
  if (!headerToken) {
    throw AppError.forbidden("CSRF token missing or invalid.")
  }

  const expected = await csrfTokenForSession(sessionCookie)
  if (constantTimeStringEqual(expected, headerToken)) return

  // TRANSITIONAL, admin console only: accept the old cookie==header double-submit for requests to the
  // operator API, whose sign-in path still issues unbound tokens. Scoped by path so a citizen-facing
  // mutation can never be forged with a planted cookie pair.
  if (request.url.startsWith(LEGACY_DOUBLE_SUBMIT_PATH_PREFIX)) {
    const cookieToken = csrfCookieValue(request)
    if (cookieToken !== null && constantTimeStringEqual(cookieToken, headerToken)) return
  }

  throw AppError.forbidden("CSRF token missing or invalid.")
}
