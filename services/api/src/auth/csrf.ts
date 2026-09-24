/**
 * CSRF protection for the cookie (web) transport, bound to the session it protects. A state-changing
 * request authenticated by the session cookie must echo the CSRF value in `X-CSRF-Token`.
 *
 * The token is derived, not random. Pure double-submit proves only that the caller could read a CSRF
 * cookie for this site, and anything that can write cookies the API accepts (a compromised sibling
 * subdomain, an XSS on any *.civfix.org host, a MITM on a plain-http sibling) can plant its own cookie and
 * send the matching header. So the token is an HMAC-SHA256 over the session id (the SHA-256 of the
 * session token, i.e. sessions.id) keyed by SESSION_SIGNING_KEY: only this server can produce it, and only
 * for one session. The cookie is just the delivery mechanism.
 *
 * Bearer (mobile) requests are exempt: they carry no ambient cookie a browser could attach.
 *
 * Mint and verify are two halves of one HMAC and must read the same key, so there is no module-level
 * singleton: `makeCsrf(env)` binds both to one env and di.ts builds exactly one per container
 * (`container.csrf`), which every route file and mint call site reads.
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

export const CSRF_HEADER = "x-csrf-token"

/** Domain separation: the signing key is shared with cookie signing, so label what is being signed. */
const CSRF_HMAC_LABEL = "civfix-csrf-v1:"

/** Read lazily, so a lazily-loaded env is not forced early. */
export type CsrfEnv = Pick<Env, "SESSION_SIGNING_KEY">

/**
 * Both members are closures over the injected env, not `this`, so `protect` is safe to detach: that is what
 * lets a route file keep `{ preHandler: csrfProtect }`.
 */
export interface Csrf {
  /**
   * Deterministic, so it never needs to be stored: the same session always yields the same token, and no
   * other session can yield it.
   */
  tokenForSession(sessionToken: string): Promise<string>

  /**
   * Verifies against the token derived from the session cookie on this request; the CSRF cookie is not
   * consulted. There is no double-submit fallback on any path: the operator console mints session-bound
   * tokens too (routes/admin/auth.routes.ts), and a cookie==header fallback scoped to /v1/admin/ was
   * exactly the plantable-pair hole the derivation closes.
   */
  protect(request: FastifyRequest): Promise<void>
}

export function makeCsrf(env: CsrfEnv): Csrf {
  async function tokenForSession(sessionToken: string): Promise<string> {
    const sessionId = await sha256Hex(sessionToken)
    return createHmac("sha256", env.SESSION_SIGNING_KEY)
      .update(CSRF_HMAC_LABEL + sessionId)
      .digest("base64url")
  }

  async function protect(request: FastifyRequest): Promise<void> {
    if (bearerToken(request) !== null) return

    const sessionCookie = sessionCookieValue(request)
    if (sessionCookie === null) return

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
 * An unbound random token that can never satisfy `Csrf.protect`, which accepts only session-derived
 * tokens. Its one caller is the unreachable no-session-token branch of buildAdminSession, where a random
 * value is safer than echoing an attacker-supplied cookie. Never add a caller; mint with
 * `Csrf.tokenForSession`.
 */
export function generateCsrfToken(): string {
  return generateToken()
}

/**
 * Not httpOnly because the SPA reads it to echo in the header. The name carries the `__Host-` prefix in
 * production; see the migration note in transport.ts.
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

/** Clears both names; see the migration note in transport.ts. */
export function clearCsrfCookie(reply: FastifyReply): void {
  reply.clearCookie(CSRF_COOKIE, { path: "/" })
  reply.clearCookie(CSRF_COOKIE_HOST, { path: "/", secure: true })
}
