import type { FastifyRequest } from "fastify"
import type { SessionService } from "../auth/session-service.js"
import { presentedSessionToken, SESSION_COOKIE } from "../auth/transport.js"
import { isProd } from "../env.js"
import type { WsHandshakeResult } from "./types.js"

/**
 * Decide whether a WebSocket upgrade Origin is allowed (anti-CSWSH). Pure so it is unit-testable with no
 * socket. `hasSessionCookie` is whether the upgrade presented an ambient session cookie. Policy (mirrors
 * the CORS plugin, with the P1-4 cookie-path tightening): empty allowlist → ALLOW (dev only); no Origin
 * WITH a cookie → REJECT (a real browser always sends one, so a missing Origin on the cookie path is a
 * non-browser client replaying a stolen cookie — the CSWSH second factor); no Origin WITHOUT a cookie →
 * ALLOW (native/server/tests carry no ambient cookie); Origin present in the allowlist → ALLOW; any other
 * Origin → REJECT.
 */
export function isAllowedWsOrigin(
  origin: string | undefined,
  webOrigins: readonly string[],
  hasSessionCookie = false,
): boolean {
  // In prod env.ts requires WEB_ORIGINS non-empty at boot; this is belt-and-suspenders against a
  // regression that empties it (the gate is disabled only outside prod).
  if (webOrigins.length === 0) return !isProd()
  if (origin === undefined || origin === "") {
    return !hasSessionCookie
  }
  return webOrigins.includes(origin)
}

function originHeader(request: FastifyRequest): string | undefined {
  const raw = request.headers.origin
  const value = Array.isArray(raw) ? raw[0] : raw
  return value === undefined || value === "" ? undefined : value
}

function wsHasSessionCookie(request: FastifyRequest): boolean {
  const cookie = request.cookies?.[SESSION_COOKIE]
  return typeof cookie === "string" && cookie.length > 0
}

/**
 * Resolve the authenticated user id for a WS handshake. Prefers an already-resolved session on req.auth
 * (cookie web transport, or a bearer the auth hook honored). Falls back to the ?token query param (mobile
 * RN WebSocket cannot set headers), resolving it via the session service. Returns null when neither yields
 * a user.
 */
export async function resolveWsUser(
  request: FastifyRequest,
  sessions: SessionService | undefined,
): Promise<string | null> {
  const fromContext = request.auth?.userId ?? null
  if (fromContext !== null) return fromContext

  const query = request.query as { token?: unknown } | undefined
  const token = typeof query?.token === "string" && query.token.length > 0 ? query.token : null
  const presented = token ?? presentedSessionToken(request)
  if (presented && sessions) {
    const resolved = await sessions.resolveSession(presented)
    if (resolved) return resolved.userId
  }
  return null
}

/**
 * Validate a WS upgrade handshake. Order matters: (1) Origin allowlist (anti-CSWSH) — a cross-site Origin
 * is rejected BEFORE the cookie is consulted, so a hijacking page can never ride the ambient session
 * cookie; (2) auth — resolve the user from the cookie/bearer session or the ?token query. The Origin gate
 * is stricter when an ambient cookie is present (P1-4): the cookie path MUST carry an allowlisted Origin.
 */
export async function checkWsHandshake(
  request: FastifyRequest,
  opts: { sessions: SessionService | undefined; webOrigins: readonly string[] },
): Promise<WsHandshakeResult> {
  const hasSessionCookie = wsHasSessionCookie(request)
  if (!isAllowedWsOrigin(originHeader(request), opts.webOrigins, hasSessionCookie)) {
    return { ok: false, code: "FORBIDDEN", message: "Origin not allowed.", reason: "origin not allowed" }
  }
  const userId = await resolveWsUser(request, opts.sessions)
  if (userId === null) {
    return { ok: false, code: "UNAUTHORIZED", message: "Authentication required.", reason: "unauthenticated" }
  }
  return { ok: true, userId }
}

export { originHeader, wsHasSessionCookie }
