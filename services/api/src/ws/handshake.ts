import type { FastifyRequest } from "fastify"
import type { SessionService } from "../auth/session-service.js"
import type { AccountStatus } from "../auth/stores.js"
import type { WsTicketPayload } from "../auth/ws-ticket.js"
import { sha256Hex } from "../auth/crypto.js"
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
 * Resolve the upgrade's user AND the sha256 of the session that authenticated it (M1/H2: the socket keeps
 * the session HASH — never the raw token — so the heartbeat can re-check that the session still exists,
 * has not been revoked, and the account is not banned. Before this, a socket authenticated ONCE at connect
 * and a logged-out or banned user kept full read/write access to every joined room until they closed the
 * tab; and the ?ticket= (mobile) path had no session to re-check at all, so admin revoke, logout, role
 * change and the absolute session cap were all invisible to it.
 *
 * A connect ticket is bound at mint time to the hash of the session that requested it, so the ticket path
 * yields the same `sessionHash` the cookie path does and re-validates identically.
 */
export async function resolveWsUser(
  request: FastifyRequest,
  sessions: SessionService | undefined,
  redeemTicket?: (ticket: string) => Promise<WsTicketPayload | null>,
): Promise<{ userId: string; sessionHash?: string; accountStatus?: AccountStatus } | null> {
  // The cookie path: the auth onRequest hook already resolved the httpOnly session cookie. Re-read the
  // presented token anyway so the live-socket re-check has a session hash to resolve.
  const cookieOrBearer = presentedSessionToken(request)
  const fromContext = request.auth?.userId ?? null
  if (fromContext !== null) {
    const status = request.accountStatus
    const base = status !== undefined ? { accountStatus: status } : {}
    return cookieOrBearer
      ? { userId: fromContext, sessionHash: await sha256Hex(cookieOrBearer), ...base }
      : { userId: fromContext, ...base }
  }

  const query = request.query as { token?: unknown; ticket?: unknown } | undefined

  const ticket = typeof query?.ticket === "string" && query.ticket.length > 0 ? query.ticket : null
  if (ticket && redeemTicket) {
    const redeemed = await redeemTicket(ticket)
    if (redeemed) {
      if (redeemed.sessionHash === null || !sessions) return { userId: redeemed.userId }
      const resolved = await sessions.resolveSessionByHash(redeemed.sessionHash)
      if (resolved !== null && resolved.userId === redeemed.userId) {
        return {
          userId: redeemed.userId,
          sessionHash: redeemed.sessionHash,
          accountStatus: resolved.accountStatus,
        }
      }
      return null
    }
  }

  const queryToken =
    queryTokenAllowed() && typeof query?.token === "string" && query.token.length > 0
      ? query.token
      : null
  const presented = queryToken ?? cookieOrBearer
  if (presented && sessions) {
    const resolved = await sessions.resolveSession(presented)
    if (resolved) {
      return {
        userId: resolved.userId,
        sessionHash: await sha256Hex(presented),
        accountStatus: resolved.accountStatus,
      }
    }
  }
  return null
}

export async function checkWsHandshake(
  request: FastifyRequest,
  opts: {
    sessions: SessionService | undefined
    webOrigins: readonly string[]
    redeemTicket?: (ticket: string) => Promise<WsTicketPayload | null>
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
  // The session hash (when there is one) rides along so socket-lifecycle can re-authorize the LIVE socket
  // on each heartbeat (M1/H2) — it is never sent to the client and is not a usable credential.
  return {
    ok: true,
    userId: resolved.userId,
    ...(resolved.sessionHash !== undefined ? { sessionHash: resolved.sessionHash } : {}),
    ...(resolved.accountStatus !== undefined ? { accountStatus: resolved.accountStatus } : {}),
  }
}

export { originHeader, wsHasSessionCookie }
