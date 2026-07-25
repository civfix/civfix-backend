/**
 * Tests for the web-push pinned-agent pool (src/adapters/push-webpush.ts).
 *
 * The pool exists for SSRF pinning (the connection may only go to the address resolveSafePushTarget
 * already validated), but its eviction policy is what these tests pin, because the first version of it
 * had a real availability bug: on reaching the ceiling it called `destroy()` on EVERY cached agent, and
 * node's Agent.destroy() tears down sockets that are mid-request — so one eviction during a fan-out
 * aborted the other in-flight pushes, which this dispatcher warns about and never retries.
 *
 * Pinned here:
 *   - one agent per (family, address), reused across calls, and keepAlive so the reuse is real,
 *   - eviction is LRU and ONE agent at a time (a cache hit refreshes recency),
 *   - an evicted IDLE agent is destroyed at once,
 *   - an evicted BUSY agent is parked, never destroyed under its own sockets, and reaped once drained,
 *   - destroyAll (the container-close path) takes everything, busy included.
 */

import { describe, it, expect, vi } from "vitest"
import { makePinnedAgentPool } from "../../src/adapters/push-webpush.js"
import type { Agent } from "node:https"

/** Make an agent look like it is serving one request, the way node's Agent tracks it. The stub carries
 *  a destroy() because Agent.destroy() calls it on every socket — which is the whole bug: an eviction
 *  that destroys the agent destroys the socket under the request that is using it. */
function markInFlight(agent: Agent): void {
  ;(agent as unknown as { sockets: Record<string, unknown[]> }).sockets = {
    "push.example:443:": [{ destroy: () => {} }],
  }
}

/** ...and like it has finished (node deletes the bucket when the last socket goes). */
function markDrained(agent: Agent): void {
  ;(agent as unknown as { sockets: Record<string, unknown[]> }).sockets = {}
}

describe("makePinnedAgentPool", () => {
  it("caches one keep-alive agent per address+family", () => {
    const pool = makePinnedAgentPool({ max: 4 })
    try {
      const a = pool.get("203.0.113.7", 4)
      const again = pool.get("203.0.113.7", 4)
      const other = pool.get("203.0.113.8", 4)
      const sameAddressV6 = pool.get("203.0.113.7", 6)

      expect(again).toBe(a)
      expect(other).not.toBe(a)
      expect(sameAddressV6).not.toBe(a)
      expect(pool.stats()).toEqual({ cached: 3, retiring: 0 })
      // Without keepAlive the cache buys nothing: every send would open a fresh TCP+TLS connection.
      // (`keepAlive` is a runtime property of node's Agent that @types/node does not surface.)
      const opts = a as unknown as { keepAlive?: boolean; options: { timeout?: number } }
      expect(opts.keepAlive).toBe(true)
      // ...and an idle-socket ceiling, so a quiet pinned address does not hold a socket forever.
      expect(opts.options.timeout).toBeGreaterThan(0)
    } finally {
      pool.destroyAll()
    }
  })

  it("evicts only the least-recently-used agent, and a cache hit refreshes recency", () => {
    const pool = makePinnedAgentPool({ max: 2 })
    try {
      const first = pool.get("198.51.100.1", 4)
      const second = pool.get("198.51.100.2", 4)
      const firstDestroy = vi.spyOn(first, "destroy")
      const secondDestroy = vi.spyOn(second, "destroy")

      // Touching `first` makes `second` the LRU tail.
      expect(pool.get("198.51.100.1", 4)).toBe(first)
      pool.get("198.51.100.3", 4)

      expect(secondDestroy).toHaveBeenCalledTimes(1)
      expect(firstDestroy).not.toHaveBeenCalled()
      expect(pool.stats()).toEqual({ cached: 2, retiring: 0 })
      // The survivor is still the cached instance, not a rebuilt one.
      expect(pool.get("198.51.100.1", 4)).toBe(first)
    } finally {
      pool.destroyAll()
    }
  })

  it("never destroys an evicted agent that is mid-request; reaps it once it drains", () => {
    const pool = makePinnedAgentPool({ max: 1 })
    try {
      const busy = pool.get("203.0.113.10", 4)
      const busyDestroy = vi.spyOn(busy, "destroy")
      markInFlight(busy)

      pool.get("203.0.113.11", 4)

      // THE regression guard: the in-flight push must survive the eviction.
      expect(busyDestroy).not.toHaveBeenCalled()
      expect(pool.stats()).toEqual({ cached: 1, retiring: 1 })

      // A sweep while it is still busy is a no-op, not a teardown.
      pool.sweep()
      expect(busyDestroy).not.toHaveBeenCalled()
      expect(pool.stats().retiring).toBe(1)

      markDrained(busy)
      pool.sweep()
      expect(busyDestroy).toHaveBeenCalledTimes(1)
      expect(pool.stats()).toEqual({ cached: 1, retiring: 0 })
    } finally {
      pool.destroyAll()
    }
  })

  it("counts queued requests as in-flight, not just live sockets", () => {
    const pool = makePinnedAgentPool({ max: 1 })
    try {
      const queued = pool.get("203.0.113.20", 4)
      const destroy = vi.spyOn(queued, "destroy")
      ;(queued as unknown as { requests: Record<string, unknown[]> }).requests = {
        "push.example:443:": [{ destroy: () => {} }],
      }

      pool.get("203.0.113.21", 4)

      expect(destroy).not.toHaveBeenCalled()
      expect(pool.stats().retiring).toBe(1)
    } finally {
      pool.destroyAll()
    }
  })

  it("destroyAll takes cached and parked agents (container close)", () => {
    const pool = makePinnedAgentPool({ max: 1 })
    const parked = pool.get("192.0.2.1", 4)
    markInFlight(parked)
    const parkedDestroy = vi.spyOn(parked, "destroy")
    const live = pool.get("192.0.2.2", 4)
    const liveDestroy = vi.spyOn(live, "destroy")
    expect(pool.stats()).toEqual({ cached: 1, retiring: 1 })

    pool.destroyAll()

    expect(parkedDestroy).toHaveBeenCalledTimes(1)
    expect(liveDestroy).toHaveBeenCalledTimes(1)
    expect(pool.stats()).toEqual({ cached: 0, retiring: 0 })
  })

  it("pins DNS resolution to the given address in both lookup callback shapes", () => {
    const pool = makePinnedAgentPool({ max: 2 })
    try {
      const agent = pool.get("203.0.113.55", 6)
      const lookup = (
        agent as unknown as {
          options: {
            lookup: (hostname: string, options: unknown, cb: (...args: unknown[]) => void) => void
          }
        }
      ).options.lookup

      const single: unknown[] = []
      lookup("fcm.googleapis.com", {}, (...args) => single.push(...args))
      expect(single).toEqual([null, "203.0.113.55", 6])

      const all: unknown[] = []
      lookup("fcm.googleapis.com", { all: true }, (...args) => all.push(...args))
      expect(all).toEqual([null, [{ address: "203.0.113.55", family: 6 }]])
    } finally {
      pool.destroyAll()
    }
  })
})
