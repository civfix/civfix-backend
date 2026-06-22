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

/** httpOnly session cookie name (web transport). */
export const SESSION_COOKIE = "civfix_session"
/** Readable CSRF cookie name (web transport, double-submit). */
export const CSRF_COOKIE = "civfix_csrf"
/** Anonymous-token cookie name (issued by the later anon step; read here so we do not break it). */
export const ANON_COOKIE = "civfix_anon"

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
  const cookie = request.cookies[SESSION_COOKIE]
  return cookie && cookie.length > 0 ? cookie : null
}

/** Set the httpOnly session cookie (web transport). */
export function setSessionCookie(reply: FastifyReply, token: string, maxAgeSeconds: number): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // Secure from the validated env loader (single source of truth), always true in prod.
    secure: isProd(),
    path: "/",
    maxAge: maxAgeSeconds,
  })
}

/** Clear the httpOnly session cookie (logout). */
export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" })
}
