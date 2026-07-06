import { describe, it, expect } from "vitest"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeWsTicketStore, WS_TICKET_TTL_SECONDS } from "../../src/auth/ws-ticket.js"

describe("makeWsTicketStore", () => {
  it("mints a ticket that redeems once to the user, then is single-use", async () => {
    const cache = new InMemoryCacheClient()
    const store = makeWsTicketStore(cache)

    const { ticket, expiresInSeconds } = await store.mint("user-1")
    expect(typeof ticket).toBe("string")
    expect(ticket.length).toBeGreaterThan(20)
    expect(expiresInSeconds).toBe(WS_TICKET_TTL_SECONDS)

    expect(await store.redeem(ticket)).toBe("user-1")
    expect(await store.redeem(ticket)).toBeNull()
  })

  it("returns null for an unknown, empty, or expired ticket", async () => {
    let nowMs = 0
    const cache = new InMemoryCacheClient(() => nowMs)
    const store = makeWsTicketStore(cache, { ttlSeconds: 30 })

    expect(await store.redeem("nope")).toBeNull()
    expect(await store.redeem("")).toBeNull()

    const { ticket } = await store.mint("user-2")
    nowMs = 31_000
    expect(await store.redeem(ticket)).toBeNull()
  })

  it("does not leak the user id under the raw ticket key", async () => {
    const cache = new InMemoryCacheClient()
    const store = makeWsTicketStore(cache)
    const { ticket } = await store.mint("user-3")
    expect(await cache.get(ticket)).toBeNull()
    expect(await cache.get(`wsticket:${ticket}`)).toBe("user-3")
  })
})
