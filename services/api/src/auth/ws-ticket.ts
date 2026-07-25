/**
 * Single-use WebSocket handshake tickets.
 *
 * A ticket is a short-lived bearer credential that stands in for the session token on the WS upgrade, so
 * the long-lived session never travels in a URL. Two properties make it safe, and both are enforced here
 * rather than by the caller:
 *
 *   - AT REST it is a secret, so only its SHA-256 is stored, exactly as session tokens are (a cache dump
 *     or a Redis MONITOR transcript must not yield a usable credential).
 *   - REDEMPTION IS ATOMIC (M2). The old `get` then `del` was a TOCTOU: N connections presenting the same
 *     ticket concurrently all read the user id before any of them deleted it, so "single-use" held only
 *     when nothing raced. The claim is now taken with INCR - the one primitive on the CacheClient seam
 *     that is atomic across processes - and only the caller that receives 1 (the increment that CREATED
 *     the claim key) is the redeemer. Every concurrent loser and every later replay sees >1 and is
 *     refused, whether or not the value key has been deleted yet.
 */

import { randomBytes } from "node:crypto"
import { sha256Hex } from "./crypto.js"
import type { CacheClient } from "./cache.js"

export const WS_TICKET_TTL_SECONDS = 30
const WS_TICKET_PREFIX = "wsticket:"
const WS_TICKET_CLAIM_PREFIX = "wsticket:claim:"

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
      await cache.set(WS_TICKET_PREFIX + (await sha256Hex(ticket)), userId, ttl)
      return { ticket, expiresInSeconds: ttl }
    },
    async redeem(ticket: string): Promise<string | null> {
      if (typeof ticket !== "string" || ticket.length === 0) return null
      const hash = await sha256Hex(ticket)

      // Take the claim FIRST: whoever creates the claim key (result === 1) owns this redemption. The
      // claim carries the ticket's own TTL so it expires with it and leaves nothing behind. A claim is
      // spent even for an unknown/expired ticket, which is fine - it is keyed on the ticket's hash, so
      // it can only ever throttle a replay of that same ticket.
      const claim = await cache.incr(WS_TICKET_CLAIM_PREFIX + hash, ttl)
      if (claim !== 1) return null

      const userId = await cache.get(WS_TICKET_PREFIX + hash)
      if (userId === null) return null
      await cache.del(WS_TICKET_PREFIX + hash)
      return userId
    },
  }
}
