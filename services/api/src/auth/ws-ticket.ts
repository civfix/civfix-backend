import { randomBytes } from "node:crypto"
import type { CacheClient } from "./cache.js"

export const WS_TICKET_TTL_SECONDS = 30
const WS_TICKET_PREFIX = "wsticket:"

export interface WsTicketStore {
  mint(userId: string): Promise<{ ticket: string; expiresInSeconds: number }>
  redeem(ticket: string): Promise<string | null>
}

function defaultTicketId(): string {
  return randomBytes(32).toString("base64url")
}

export function makeWsTicketStore(
  cache: CacheClient,
  opts: { ttlSeconds?: number; newTicketId?: () => string } = {},
): WsTicketStore {
  const ttl = opts.ttlSeconds ?? WS_TICKET_TTL_SECONDS
  const newTicketId = opts.newTicketId ?? defaultTicketId
  return {
    async mint(userId: string): Promise<{ ticket: string; expiresInSeconds: number }> {
      const ticket = newTicketId()
      await cache.set(WS_TICKET_PREFIX + ticket, userId, ttl)
      return { ticket, expiresInSeconds: ttl }
    },
    async redeem(ticket: string): Promise<string | null> {
      if (typeof ticket !== "string" || ticket.length === 0) return null
      const key = WS_TICKET_PREFIX + ticket
      const userId = await cache.get(key)
      if (userId === null) return null
      await cache.del(key)
      return userId
    },
  }
}
