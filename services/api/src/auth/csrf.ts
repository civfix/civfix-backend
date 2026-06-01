/**
 * Double-submit CSRF protection for the cookie (web) transport.
 *
 * The web sign-in response sets two cookies: the httpOnly session cookie (not readable by JS) and a
 * readable CSRF cookie. On a state-changing request that authenticates via the SESSION COOKIE, the
 * client must echo the CSRF cookie value in the `X-CSRF-Token` header; the two are compared in
 * constant time. Because an attacker's cross-site request cannot read the victim's CSRF cookie, it
 * cannot forge the matching header.
 *
 * Bearer (mobile) requests are EXEMPT: they carry no ambient cookie, so there is nothing for a
 * browser to attach automatically and CSRF does not apply. The preHandler therefore only enforces
 * when a session cookie is present and no bearer token is used.
 */

import { AppError } from "@civfix/shared"
import type { FastifyReply, FastifyRequest } from "fastify"
import { constantTimeStringEqual, generateToken } from "./crypto.js"
import { CSRF_COOKIE, SESSION_COOKIE, bearerToken } from "./transport.js"

/** Header carrying the echoed CSRF token on state-changing cookie requests. */
export const CSRF_HEADER = "x-csrf-token"

/** Generate a fresh CSRF token (256-bit opaque value, same generator as session tokens). */
export function generateCsrfToken(): string {
  return generateToken()
}

/**
 * Set the readable CSRF cookie. NOT httpOnly (the SPA reads it to echo in the header) but still
 * SameSite=Lax + Secure-in-prod so it is not sent on cross-site navigations or over plain HTTP.
 */
export function setCsrfCookie(reply: FastifyReply, token: string, maxAgeSeconds: number): void {
  reply.setCookie(CSRF_COOKIE, token, {
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  })
}

/** Clear the CSRF cookie (used on logout alongside the session cookie). */
export function clearCsrfCookie(reply: FastifyReply): void {
  reply.clearCookie(CSRF_COOKIE, { path: "/" })
}

/**
 * preHandler that enforces double-submit CSRF on cookie-authenticated, state-changing requests.
 *
 * Skips entirely when:
 *   - the request uses a bearer token (mobile; no ambient cookie), or
 *   - there is no session cookie (anonymous / unauthenticated request).
 *
 * Otherwise requires that `X-CSRF-Token` is present and constant-time-equal to the CSRF cookie.
 */
export async function csrfProtect(request: FastifyRequest): Promise<void> {
  // Bearer transport is exempt.
  if (bearerToken(request) !== null) return

  const sessionCookie = request.cookies[SESSION_COOKIE]
  if (!sessionCookie) return // No cookie session => nothing to protect against here.

  const cookieToken = request.cookies[CSRF_COOKIE]
  const headerValue = request.headers[CSRF_HEADER]
  const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue

  if (!cookieToken || !headerToken || !constantTimeStringEqual(cookieToken, headerToken)) {
    throw AppError.forbidden("CSRF token missing or invalid.")
  }
}
