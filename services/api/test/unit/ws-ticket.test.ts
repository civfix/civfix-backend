import { describe, it, expect } from "vitest"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { sha256Hex } from "../../src/auth/crypto.js"
import { makeWsTicketStore, WS_TICKET_TTL_SECONDS } from "../../src/auth/ws-ticket.js"

describe("makeWsTicketStore", () => {
  it("mints a ticket that redeems once to the user, then is single-use", async () => {
    const cache = new InMemoryCacheClient()
    const store = makeWsTicketStore(cache)

    const { ticket, expiresInSeconds } = await store.mint("user-1", "hash-1")
    expect(typeof ticket).toBe("string")
    expect(ticket.length).toBeGreaterThan(20)
    expect(expiresInSeconds).toBe(WS_TICKET_TTL_SECONDS)

    expect(await store.redeem(ticket)).toEqual({ userId: "user-1", sessionHash: "hash-1" })
    expect(await store.redeem(ticket)).toBeNull()
  })

  it("H2: a legacy ticket value (bare user id, minted before session binding) redeems with no session hash", async () => {
    const cache = new InMemoryCacheClient()
    const store = makeWsTicketStore(cache)
    await cache.set(`wsticket:${await sha256Hex("legacy")}`, "user-legacy", 30)
    expect(await store.redeem("legacy")).toEqual({ userId: "user-legacy", sessionHash: null })
  })

  it("returns null for an unknown, empty, or expired ticket", async () => {
    let nowMs = 0
    const cache = new InMemoryCacheClient(() => nowMs)
    const store = makeWsTicketStore(cache, { ttlSeconds: 30 })

    expect(await store.redeem("nope")).toBeNull()
    expect(await store.redeem("")).toBeNull()

    const { ticket } = await store.mint("user-2", "hash-2")
    nowMs = 31_000
    expect(await store.redeem(ticket)).toBeNull()
  })

  it("stores the ticket HASHED, never the raw ticket (M2)", async () => {
    const cache = new InMemoryCacheClient()
    const store = makeWsTicketStore(cache)
    const { ticket } = await store.mint("user-3", "hash-3")
    // Neither the bare ticket nor the prefixed RAW ticket is a key: a cache dump yields no usable
    // credential, exactly as for session tokens.
    expect(await cache.get(ticket)).toBeNull()
    expect(await cache.get(`wsticket:${ticket}`)).toBeNull()
    expect(await cache.get(`wsticket:${await sha256Hex(ticket)}`)).toBe(
      JSON.stringify({ u: "user-3", s: "hash-3" }),
    )
  })

  it("M2: N CONCURRENT redemptions of one ticket authenticate exactly ONE connection", async () => {
    const cache = new InMemoryCacheClient()
    const store = makeWsTicketStore(cache)
    const { ticket } = await store.mint("user-4", "hash-4")

    // The old get-then-del was a TOCTOU: every racer read the user id before any delete landed, so one
    // ticket opened N sockets. With an atomic claim exactly one caller may win.
    const results = await Promise.all(Array.from({ length: 12 }, () => store.redeem(ticket)))
    expect(results.filter((r) => r?.userId === "user-4")).toHaveLength(1)
    expect(results.filter((r) => r === null)).toHaveLength(11)
  })
})
