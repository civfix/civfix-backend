/**
 * Transport selection for auth: how a session is carried back to (and presented by) a client.
 *
 * civfix serves two client kinds from the same endpoints:
 *   - WEB   (browser SPA): the session lives in an httpOnly + Secure + SameSite=Lax cookie, and a
 *     readable CSRF cookie/token guards state-changing requests. The token is NOT returned in the
 *     body (the browser never needs to see it).
 *   - MOBILE (native app): there is no cookie jar we want to rely on, so the opaque token is returned
 *     in the response body as a bearer credential and sent back via `Authorization: Bearer <token>`.
 *
 * The client kind is chosen by the `X-Client` request header: `mobile` selects the bearer transport;
 * anything else (including a missing header) defaults to `web`. This default-to-web choice means a
 * stray browser fetch never accidentally leaks a token into a response body.
 */

import type { FastifyReply, FastifyRequest } from "fastify"
import { isProd } from "../env.js"

/**
 * Auth cookie names, and the `__Host-` migration (L3).
 *
 * `__Host-` is a browser-enforced prefix: a cookie carrying it is REFUSED unless it is Secure, has
 * Path=/, and carries NO Domain attribute. That last part is the point — without it, anything that can
 * write cookies for a sibling subdomain (a compromised or dangling *.civfix.org host, an XSS on a
 * marketing subdomain) can set a Domain-scoped cookie of the same name that the browser will send to the
 * API, shadowing or fixating the real session. A `__Host-` cookie cannot be shadowed that way.
 *
 * The rename is a breaking change for any client already holding the legacy cookie, so it is staged:
 *   - READ accepts BOTH names, prefixed first — for the SESSION cookie only (sessionCookieValue). That is
 *     the transition window for live sessions. The CSRF cookie has no read path at all: the double-submit
 *     fallback that used to compare it was removed, so the token is now verified purely from the header
 *     against the session-bound signature (auth/csrf.ts) and the cookie is write-and-clear only — it
 *     exists so the SPA can read its own token, and the server never trusts it;
 *   - WRITE uses the prefixed name only where the browser will actually accept it, i.e. where the cookie
 *     is Secure — production. Outside production the API is served over plain http://localhost, where a
 *     `__Host-` cookie would be silently dropped and sign-in would simply not work;
 *   - CLEAR clears both names for both cookies, so a logout cannot leave a stale legacy cookie behind that
 *     outlives the session.
 * The legacy names can be deleted once every deployed client has been through one session lifetime.
 */

/** httpOnly session cookie name (web transport) — legacy, still accepted on read. */
export const SESSION_COOKIE = "civfix_session"
/** httpOnly session cookie name with the browser-enforced `__Host-` prefix. */
export const SESSION_COOKIE_HOST = "__Host-civfix_session"
/** Readable CSRF cookie name (web transport) — legacy, still accepted on read. */
export const CSRF_COOKIE = "civfix_csrf"
/** Readable CSRF cookie name with the browser-enforced `__Host-` prefix. */
export const CSRF_COOKIE_HOST = "__Host-civfix_csrf"
/** Anonymous-token cookie name (issued by the later anon step; read here so we do not break it). */
export const ANON_COOKIE = "civfix_anon"

/**
 * The cookie name to WRITE for the session. Prefixed only in production, because the prefix requires
 * Secure and only production serves over TLS (see the migration note above).
 */
export function sessionCookieName(): string {
  return isProd() ? SESSION_COOKIE_HOST : SESSION_COOKIE
}

/** The cookie name to WRITE for the CSRF token; same production-only prefixing as the session cookie. */
export function csrfCookieName(): string {
  return isProd() ? CSRF_COOKIE_HOST : CSRF_COOKIE
}

/** Read the presented session cookie under either name, preferring the `__Host-` one. */
export function sessionCookieValue(request: FastifyRequest): string | null {
  return firstNonEmptyCookie(request, SESSION_COOKIE_HOST, SESSION_COOKIE)
}

// NOTE: there is deliberately NO csrfCookieValue reader. Nothing on the server may read the CSRF cookie:
// the double-submit fallback (compare header to cookie) was removed because a subdomain that can set
// cookies could satisfy both halves, and the surviving check verifies the header token against the
// session-bound signature instead. Reintroducing a cookie read would reintroduce that hole.

function firstNonEmptyCookie(request: FastifyRequest, ...names: string[]): string | null {
  for (const name of names) {
    const value = request.cookies[name]
    if (value !== undefined && value.length > 0) return value
  }
  return null
}

/** Request header used to pick the transport. */
export const CLIENT_HEADER = "x-client"

export type ClientKind = "web" | "mobile"

/** Resolve the client kind from the `X-Client` header. Defaults to web. */
export function clientKind(request: FastifyRequest): ClientKind {
  const raw = request.headers[CLIENT_HEADER]
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase()
  return value === "mobile" ? "mobile" : "web"
}

/** Extract a bearer token from the Authorization header, or null (scheme match is case-insensitive). */
export function bearerToken(request: FastifyRequest): string | null {
  const raw = request.headers.authorization
  const header = Array.isArray(raw) ? raw[0] : raw
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1]!.trim() : null
}

/**
 * Read the presented session token from either transport: Authorization: Bearer (mobile) takes
 * precedence, falling back to the session cookie (web). Returns null when neither is present.
 */
export function presentedSessionToken(request: FastifyRequest): string | null {
  const bearer = bearerToken(request)
  if (bearer) return bearer
  return sessionCookieValue(request)
}

/** Set the httpOnly session cookie (web transport). */
export function setSessionCookie(reply: FastifyReply, token: string, maxAgeSeconds: number): void {
  reply.setCookie(sessionCookieName(), token, {
    httpOnly: true,
    sameSite: "lax",
    // Secure from the validated env loader (single source of truth), always true in prod. This is also
    // what makes the `__Host-` name acceptable to the browser in production.
    secure: isProd(),
    path: "/",
    maxAge: maxAgeSeconds,
  })
}

/** Clear the httpOnly session cookie (logout) under BOTH names, so no legacy cookie survives. */
export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" })
  reply.clearCookie(SESSION_COOKIE_HOST, { path: "/", secure: true })
}
