/**
 * Single-use WebSocket handshake tickets.
 *
 * A ticket is a short-lived bearer credential that stands in for the session token on the WS upgrade, so
 * the long-lived session never travels in a URL. The two properties that make it safe — stored hashed,
 * redeemed atomically (M2) — belong to every short-lived secret this service mints, so they live in
 * single-use-secret.ts; this module is the ticket-shaped face of that store (a ticket's stored value is
 * the user id its redemption authenticates, BOUND to the sha256 of the session token that minted it, so a
 * ticket socket can be re-validated against session revocation exactly like a cookie socket).
 */

import { makeSingleUseSecretStore } from "./single-use-secret.js"
import type { CacheClient } from "./cache.js"

export const WS_TICKET_TTL_SECONDS = 30
const WS_TICKET_PREFIX = "wsticket:"

export interface WsTicketPayload {
  userId: string
  sessionHash: string | null
}

export interface WsTicketStore {
  mint(userId: string, sessionHash: string): Promise<{ ticket: string; expiresInSeconds: number }>
  redeem(ticket: string): Promise<WsTicketPayload | null>
}

function encodePayload(userId: string, sessionHash: string): string {
  return JSON.stringify({ u: userId, s: sessionHash })
}

function decodePayload(raw: string): WsTicketPayload | null {
  if (!raw.startsWith("{")) return { userId: raw, sessionHash: null }
  try {
    const parsed = JSON.parse(raw) as { u?: unknown; s?: unknown }
    if (typeof parsed.u !== "string" || parsed.u.length === 0) return null
    return { userId: parsed.u, sessionHash: typeof parsed.s === "string" ? parsed.s : null }
  } catch {
    return null
  }
}

export function makeWsTicketStore(
  cache: CacheClient,
  opts: { ttlSeconds?: number; newTicketId?: () => string } = {},
): WsTicketStore {
  const secrets = makeSingleUseSecretStore(cache, {
    prefix: WS_TICKET_PREFIX,
    ttlSeconds: opts.ttlSeconds ?? WS_TICKET_TTL_SECONDS,
    ...(opts.newTicketId ? { newSecret: opts.newTicketId } : {}),
  })
  return {
    async mint(
      userId: string,
      sessionHash: string,
    ): Promise<{ ticket: string; expiresInSeconds: number }> {
      const { secret, expiresInSeconds } = await secrets.mint(encodePayload(userId, sessionHash))
      return { ticket: secret, expiresInSeconds }
    },
    async redeem(ticket: string): Promise<WsTicketPayload | null> {
      const raw = await secrets.redeem(ticket)
      return raw === null ? null : decodePayload(raw)
    },
  }
}
