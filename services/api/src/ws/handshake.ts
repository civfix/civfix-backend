import type { FastifyRequest } from "fastify"
import type { SessionService } from "../auth/session-service.js"
import { presentedSessionToken, sessionCookieValue } from "../auth/transport.js"
import { isProd } from "../env.js"
import type { WsHandshakeResult } from "./types.js"

export function isAllowedWsOrigin(
  origin: string | undefined,
  webOrigins: readonly string[],
  hasSessionCookie = false,
): boolean {
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
  // Read through the transport helper, never the literal cookie name: in production the session cookie
  // carries the `__Host-` prefix, and a direct `cookies[SESSION_COOKIE]` lookup would silently miss it —
  // which would drop the "cookie-bearing upgrade REQUIRES an allowlisted Origin" CSWSH defense below.
  return sessionCookieValue(request) !== null
}

/**
 * SECURITY (H5): the legacy `?token=<30-day session bearer>` upgrade path, now OFF by default.
 *
 * A query parameter is the worst place to put a full-privilege, long-lived credential: it is written
 * verbatim into every upstream access log, CDN/proxy trace, APM span and browser history entry. (Our own
 * pino serializer strips the query string, which HIDES the leak locally while it persists at the edge.)
 * The correct mechanism — a single-use, short-lived `?ticket=` minted by an authenticated request — is
 * already implemented and is what the mobile client reaches for FIRST.
 *
 * Not deleted outright because the shipped native client (apps/community-mobile/src/lib/ws.ts) still
 * falls back to `?token=` when the ticket endpoint is unreachable, and store-shipped builds cannot be
 * force-upgraded. Operators may re-enable the fallback TEMPORARILY with WS_ALLOW_QUERY_TOKEN=1 while old
 * builds age out; it must stay unset in normal operation. Read straight off process.env (the
 * version.ts precedent) rather than the validated env loader because this is a deliberately
 * short-lived, undocumented break-glass switch, not part of the service's env contract.
 */
function queryTokenAllowed(): boolean {
  const raw = process.env.WS_ALLOW_QUERY_TOKEN
  return raw === "1" || raw === "true"
}

/**
 * Resolve the upgrade's user AND the session token it authenticated with (M1: the socket keeps the token
 * so the heartbeat can re-check that the session still exists and the account is not banned — before
 * this, a socket authenticated ONCE at connect and a logged-out or banned user kept full read/write
 * access to every joined room until they closed the tab).
 *
 * `token` is deliberately absent on the ?ticket= path: a connect ticket is single-use and already
 * redeemed, so there is nothing to re-resolve — those sockets fall back to the banned-account check.
 */
export async function resolveWsUser(
  request: FastifyRequest,
  sessions: SessionService | undefined,
  redeemTicket?: (ticket: string) => Promise<string | null>,
): Promise<{ userId: string; token?: string } | null> {
  // The cookie path: the auth onRequest hook already resolved the httpOnly session cookie. Re-read the
  // presented token anyway so the live-socket re-check has a credential to resolve.
  const cookieOrBearer = presentedSessionToken(request)
  const fromContext = request.auth?.userId ?? null
  if (fromContext !== null) {
    return cookieOrBearer ? { userId: fromContext, token: cookieOrBearer } : { userId: fromContext }
  }

  const query = request.query as { token?: unknown; ticket?: unknown } | undefined

  const ticket = typeof query?.ticket === "string" && query.ticket.length > 0 ? query.ticket : null
  if (ticket && redeemTicket) {
    const userId = await redeemTicket(ticket)
    if (userId) return { userId }
  }

  const queryToken =
    queryTokenAllowed() && typeof query?.token === "string" && query.token.length > 0
      ? query.token
      : null
  const presented = queryToken ?? cookieOrBearer
  if (presented && sessions) {
    const resolved = await sessions.resolveSession(presented)
    if (resolved) return { userId: resolved.userId, token: presented }
  }
  return null
}

export async function checkWsHandshake(
  request: FastifyRequest,
  opts: {
    sessions: SessionService | undefined
    webOrigins: readonly string[]
    redeemTicket?: (ticket: string) => Promise<string | null>
  },
): Promise<WsHandshakeResult> {
  const hasSessionCookie = wsHasSessionCookie(request)
  if (!isAllowedWsOrigin(originHeader(request), opts.webOrigins, hasSessionCookie)) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Origin not allowed.",
      reason: "origin not allowed",
    }
  }
  const resolved = await resolveWsUser(request, opts.sessions, opts.redeemTicket)
  if (resolved === null) {
    return {
      ok: false,
      code: "UNAUTHORIZED",
      message: "Authentication required.",
      reason: "unauthenticated",
    }
  }
  // The token (when there is one) rides along so socket-lifecycle can re-authorize the LIVE socket on
  // each heartbeat (M1) — it is never sent to the client.
  return resolved.token !== undefined
    ? { ok: true, userId: resolved.userId, token: resolved.token }
    : { ok: true, userId: resolved.userId }
}

export { originHeader, wsHasSessionCookie }
