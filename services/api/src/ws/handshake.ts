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
  return sessionCookieValue(request) !== null
}

// Break-glass only: a session bearer in a URL lands in proxy and access logs. Off unless the loaded env
// turns it on, including for a request that carries no app container.
function queryTokenAllowed(request: FastifyRequest): boolean {
  return request.server?.container?.env.WS_ALLOW_QUERY_TOKEN === true
}

export async function resolveWsUser(
  request: FastifyRequest,
  sessions: SessionService | undefined,
  redeemTicket?: (ticket: string) => Promise<WsTicketPayload | null>,
): Promise<{ userId: string; sessionHash?: string; accountStatus?: AccountStatus } | null> {
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
    typeof query?.token === "string" && query.token.length > 0 && queryTokenAllowed(request)
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
  return {
    ok: true,
    userId: resolved.userId,
    ...(resolved.sessionHash !== undefined ? { sessionHash: resolved.sessionHash } : {}),
    ...(resolved.accountStatus !== undefined ? { accountStatus: resolved.accountStatus } : {}),
  }
}

export { originHeader, wsHasSessionCookie }
