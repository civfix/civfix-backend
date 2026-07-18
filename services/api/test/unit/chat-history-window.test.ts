/**
 * Pure unit coverage for the around-mode window helpers (P2 2.4) so the split/merge/has-more math is
 * proven without Docker. The DB-backed window queries are covered by chat-around-pg.test.ts.
 */

import { describe, expect, it } from "vitest"
import { aroundLimits, mergeAroundWindow } from "../../src/services/chat-history-window.js"

describe("aroundLimits", () => {
  it("splits even limits into equal halves and gives odd limits the extra older slot", () => {
    expect(aroundLimits(6)).toEqual({ olderLimit: 3, newerLimit: 3 })
    expect(aroundLimits(5)).toEqual({ olderLimit: 3, newerLimit: 2 })
    expect(aroundLimits(1)).toEqual({ olderLimit: 1, newerLimit: 0 })
  })
})

describe("mergeAroundWindow", () => {
  const limits = { olderLimit: 2, newerLimit: 2 }

  it("merges newer(asc) + older(desc) into one newest-first window and trims the +1 probes", () => {
    // Anchor = 5. Older side (desc, anchor first) fetched 3 (=olderLimit+1): more older exist.
    // Newer side (asc, nearest first) fetched 3 (=newerLimit+1): more newer exist.
    const { rows, hasOlder, hasNewer } = mergeAroundWindow([5, 4, 3], [6, 7, 8], limits)
    expect(rows).toEqual([7, 6, 5, 4])
    expect(hasOlder).toBe(true)
    expect(hasNewer).toBe(true)
  })

  it("reports no-more per side when a side comes back short", () => {
    const head = mergeAroundWindow([5, 4, 3], [], limits) // anchor is the newest row
    expect(head.rows).toEqual([5, 4])
    expect(head.hasNewer).toBe(false)
    expect(head.hasOlder).toBe(true)

    const tail = mergeAroundWindow([5], [6, 7], limits) // anchor is the oldest row
    expect(tail.rows).toEqual([7, 6, 5])
    expect(tail.hasOlder).toBe(false)
    expect(tail.hasNewer).toBe(false)
  })

  it("a lone anchor with limit 1 yields just the anchor", () => {
    const one = mergeAroundWindow([9], [], aroundLimits(1))
    expect(one.rows).toEqual([9])
    expect(one.hasOlder).toBe(false)
    expect(one.hasNewer).toBe(false)
  })

  it("does not mutate its inputs (the newer side is reversed on a copy)", () => {
    const newer = [6, 7]
    mergeAroundWindow([5, 4], newer, limits)
    expect(newer).toEqual([6, 7])
  })
})
