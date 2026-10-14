/**
 * How a session is carried back to and presented by a client.
 *   - web: the session lives in an httpOnly, Secure, SameSite=Lax cookie and a readable CSRF token guards
 *     state-changing requests. The session token is never returned in the body.
 *   - mobile: there is no cookie jar worth relying on, so the token is returned in the body and sent back
 *     as `Authorization: Bearer <token>`.
 *
 * `X-Client: mobile` selects the bearer transport; anything else, including no header, is web, so a stray
 * browser fetch never leaks a token into a response body.
 */

import type { FastifyReply, FastifyRequest } from "fastify"
import { isProd } from "../env.js"

/**
 * Auth cookie names and the `__Host-` migration.
 *
 * The browser refuses a `__Host-` cookie unless it is Secure, has Path=/ and carries no Domain attribute.
 * The last part is the point: otherwise anything that can write cookies for a sibling subdomain (a
 * compromised or dangling *.civfix.org host, an XSS on a marketing subdomain) can set a Domain-scoped
 * cookie of the same name that the browser sends to the API, shadowing or fixating the real session.
 *
 * The rename breaks any client holding the legacy cookie, so it is staged:
 *   - read accepts both names, prefixed first, for the session cookie only. The CSRF cookie has no read
 *     path: the header is verified against the session-bound signature (auth/csrf.ts), and the cookie
 *     exists only so the SPA can read its own token;
 *   - write uses the prefixed name only in production, where the cookie is Secure. Over plain
 *     http://localhost a `__Host-` cookie is silently dropped and sign-in would not work;
 *   - clear clears both names for both cookies, so a logout cannot leave a legacy cookie that outlives the
 *     session.
 * The legacy names can be deleted once every deployed client has been through one session lifetime.
 */

/** Legacy name: written outside production, still accepted on read. */
export const SESSION_COOKIE = "civfix_session"
export const SESSION_COOKIE_HOST = "__Host-civfix_session"
/** Legacy name: written outside production. */
export const CSRF_COOKIE = "civfix_csrf"
export const CSRF_COOKIE_HOST = "__Host-civfix_csrf"
export const ANON_COOKIE = "civfix_anon"

const CLIENT_HEADER = "x-client"

const MOBILE_CLIENT = "mobile"

const BEARER_RE = /^Bearer\s+(.+)$/i

function sessionCookieName(): string {
  return isProd() ? SESSION_COOKIE_HOST : SESSION_COOKIE
}

export function csrfCookieName(): string {
  return isProd() ? CSRF_COOKIE_HOST : CSRF_COOKIE
}

export function sessionCookieValue(request: FastifyRequest): string | null {
  return firstNonEmptyCookie(request, SESSION_COOKIE_HOST, SESSION_COOKIE)
}

// There is deliberately no CSRF cookie reader. A header-equals-cookie check can be satisfied by any
// subdomain that can set cookies, so the header is verified against the session-bound signature instead;
// reading the cookie would reintroduce that hole.

function firstNonEmptyCookie(request: FastifyRequest, ...names: string[]): string | null {
  for (const name of names) {
    const value = request.cookies[name]
    if (value !== undefined && value.length > 0) return value
  }
  return null
}

export type ClientKind = "web" | "mobile"

export function clientKind(request: FastifyRequest): ClientKind {
  const raw = request.headers[CLIENT_HEADER]
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase()
  return value === MOBILE_CLIENT ? "mobile" : "web"
}

export function bearerToken(request: FastifyRequest): string | null {
  const raw = request.headers.authorization
  const header = Array.isArray(raw) ? raw[0] : raw
  if (!header) return null
  const match = BEARER_RE.exec(header.trim())
  return match ? match[1]!.trim() : null
}

export function presentedSessionToken(request: FastifyRequest): string | null {
  const bearer = bearerToken(request)
  if (bearer) return bearer
  return sessionCookieValue(request)
}

export function setSessionCookie(reply: FastifyReply, token: string, maxAgeSeconds: number): void {
  reply.setCookie(sessionCookieName(), token, {
    httpOnly: true,
    sameSite: "lax",
    // Also what makes the `__Host-` name acceptable to the browser in production.
    secure: isProd(),
    path: "/",
    maxAge: maxAgeSeconds,
  })
}

/** Clears both names, so no legacy cookie survives a logout. */
export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" })
  reply.clearCookie(SESSION_COOKIE_HOST, { path: "/", secure: true })
}
