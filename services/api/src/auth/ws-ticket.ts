/**
 * Single-use WebSocket handshake tickets.
 *
 * A ticket is a short-lived bearer credential that stands in for the session token on the WS upgrade, so
 * the long-lived session never travels in a URL. The two properties that make it safe — stored hashed,
 * redeemed atomically (M2) — belong to every short-lived secret this service mints, so they live in
 * single-use-secret.ts; this module is the ticket-shaped face of that store (a ticket's stored value is
 * the user id its redemption authenticates).
 */

import { makeSingleUseSecretStore } from "./single-use-secret.js"
import type { CacheClient } from "./cache.js"

export const WS_TICKET_TTL_SECONDS = 30
const WS_TICKET_PREFIX = "wsticket:"

export interface WsTicketStore {
  mint(userId: string): Promise<{ ticket: string; expiresInSeconds: number }>
  redeem(ticket: string): Promise<string | null>
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
    async mint(userId: string): Promise<{ ticket: string; expiresInSeconds: number }> {
      const { secret, expiresInSeconds } = await secrets.mint(userId)
      return { ticket: secret, expiresInSeconds }
    },
    redeem(ticket: string): Promise<string | null> {
      return secrets.redeem(ticket)
    },
  }
}
