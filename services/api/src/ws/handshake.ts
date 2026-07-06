import type { FastifyRequest } from "fastify"
import type { SessionService } from "../auth/session-service.js"
import { presentedSessionToken, SESSION_COOKIE } from "../auth/transport.js"
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
  const cookie = request.cookies?.[SESSION_COOKIE]
  return typeof cookie === "string" && cookie.length > 0
}

export async function resolveWsUser(
  request: FastifyRequest,
  sessions: SessionService | undefined,
  redeemTicket?: (ticket: string) => Promise<string | null>,
): Promise<string | null> {
  const fromContext = request.auth?.userId ?? null
  if (fromContext !== null) return fromContext

  const query = request.query as { token?: unknown; ticket?: unknown } | undefined

  const ticket = typeof query?.ticket === "string" && query.ticket.length > 0 ? query.ticket : null
  if (ticket && redeemTicket) {
    const userId = await redeemTicket(ticket)
    if (userId) return userId
  }

  const token = typeof query?.token === "string" && query.token.length > 0 ? query.token : null
  const presented = token ?? presentedSessionToken(request)
  if (presented && sessions) {
    const resolved = await sessions.resolveSession(presented)
    if (resolved) return resolved.userId
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
    return { ok: false, code: "FORBIDDEN", message: "Origin not allowed.", reason: "origin not allowed" }
  }
  const userId = await resolveWsUser(request, opts.sessions, opts.redeemTicket)
  if (userId === null) {
    return { ok: false, code: "UNAUTHORIZED", message: "Authentication required.", reason: "unauthenticated" }
  }
  return { ok: true, userId }
}

export { originHeader, wsHasSessionCookie }
