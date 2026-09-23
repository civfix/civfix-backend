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
 *
 * INJECTION (C1). Mint and verify are TWO HALVES OF ONE HMAC, so they must read the same key: a mint
 * side keyed by the container's env while the verify side reached for a module-global would 403 every
 * cookie mutation the moment the two differed. There is therefore no module-level singleton here —
 * `makeCsrf(env)` returns both halves bound to ONE env, di.ts builds exactly one per container
 * (`container.csrf`), and every route file and every mint call site reads that instance.
 */

import { createHmac } from "node:crypto"
import { AppError } from "@civfix/shared"
import type { FastifyReply, FastifyRequest } from "fastify"
import { constantTimeStringEqual, generateToken, sha256Hex } from "./crypto.js"
import {
  csrfCookieName,
  sessionCookieValue,
  bearerToken,
  CSRF_COOKIE,
  CSRF_COOKIE_HOST,
} from "./transport.js"
import { isProd, type Env } from "../env.js"

/** Header carrying the echoed CSRF token on state-changing cookie requests. */
export const CSRF_HEADER = "x-csrf-token"

/** Domain separation: the signing key is shared with cookie signing, so label what is being signed. */
const CSRF_HMAC_LABEL = "civfix-csrf-v1:"

/** The slice of the env the CSRF HMAC reads. Read lazily, so a lazily-loaded env is not forced early. */
export type CsrfEnv = Pick<Env, "SESSION_SIGNING_KEY">

/**
 * The two halves of session-bound CSRF, keyed by one env.
 *
 * `protect` is a plain preHandler and is safe to detach from the object (both members are closures over
 * the injected env, not `this`), which is what lets a route file keep `{ preHandler: csrfProtect }`.
 */
export interface Csrf {
  /**
   * Derive the CSRF token for the session carried by `sessionToken`. Deterministic, so it never needs to
   * be stored: the same session always yields the same token, and no other session can yield it.
   */
  tokenForSession(sessionToken: string): Promise<string>

  /**
   * preHandler that enforces session-bound CSRF on cookie-authenticated, state-changing requests.
   *
   * Skips entirely when:
   *   - the request uses a bearer token (mobile; no ambient cookie), or
   *   - there is no session cookie (anonymous / unauthenticated request).
   *
   * Otherwise requires that `X-CSRF-Token` is present and constant-time-equal to the token DERIVED from
   * the session cookie actually presented on this request. The CSRF cookie is not consulted: it is only
   * how the token reaches the client. There is no double-submit fallback for any path — the operator
   * console mints session-bound tokens too (routes/admin/auth.routes.ts), and a cookie==header fallback
   * scoped to /v1/admin/ was exactly the plantable-pair hole the derivation exists to close.
   */
  protect(request: FastifyRequest): Promise<void>
}

/** Build the mint + verify pair for one env. See Csrf and the INJECTION note in the module header. */
export function makeCsrf(env: CsrfEnv): Csrf {
  async function tokenForSession(sessionToken: string): Promise<string> {
    const sessionId = await sha256Hex(sessionToken)
    return createHmac("sha256", env.SESSION_SIGNING_KEY)
      .update(CSRF_HMAC_LABEL + sessionId)
      .digest("base64url")
  }

  async function protect(request: FastifyRequest): Promise<void> {
    // Bearer transport is exempt.
    if (bearerToken(request) !== null) return

    const sessionCookie = sessionCookieValue(request)
    if (sessionCookie === null) return // No cookie session => nothing to protect against here.

    const headerValue = request.headers[CSRF_HEADER]
    const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue
    if (!headerToken) {
      throw AppError.forbidden("CSRF token missing or invalid.")
    }

    const expected = await tokenForSession(sessionCookie)
    if (!constantTimeStringEqual(expected, headerToken)) {
      throw AppError.forbidden("CSRF token missing or invalid.")
    }
  }

  return { tokenForSession, protect }
}

/**
 * Generate an UNBOUND random CSRF token. LEGACY, and now UNVERIFIABLE: nothing accepts a token that is
 * not derived from the presented session, so a value from here can never satisfy `Csrf.protect`. Its one
 * remaining caller is the unreachable no-session-token branch of buildAdminSession (defense in depth: an
 * authenticated request always presented a token, so the branch cannot fire), where handing back a random
 * value is strictly safer than echoing an attacker-supplied cookie. Never add a caller — mint with
 * `Csrf.tokenForSession`.
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
