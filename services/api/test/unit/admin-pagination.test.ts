/**
 * services/admin/pagination.ts — offset-cursor clamping (L22).
 *
 * The offset cursor is opaque but UNAUTHENTICATED: anyone can mint one carrying any integer, and an
 * unbounded OFFSET makes Postgres walk and discard that many rows per request. It was clamped at the
 * lower bound only; both ends are now clamped.
 */

import { describe, it, expect } from "vitest"
import {
  ADMIN_MAX_OFFSET,
  decodeOffsetCursor,
  encodeOffsetCursor,
} from "../../src/services/admin/pagination.js"

/** Mint a cursor for an arbitrary offset, bypassing encodeOffsetCursor's own lower clamp. */
function forgeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url")
}

describe("decodeOffsetCursor", () => {
  it("round-trips a normal offset", () => {
    expect(decodeOffsetCursor(encodeOffsetCursor(75))).toBe(75)
  })

  it("returns 0 for absent or malformed cursors", () => {
    expect(decodeOffsetCursor(undefined)).toBe(0)
    expect(decodeOffsetCursor(null)).toBe(0)
    expect(decodeOffsetCursor("not-base64url-json")).toBe(0)
    expect(decodeOffsetCursor(forgeCursor(Number.NaN))).toBe(0)
  })

  it("clamps a negative offset up to 0", () => {
    expect(decodeOffsetCursor(forgeCursor(-5_000))).toBe(0)
  })

  it("clamps a forged huge offset down to ADMIN_MAX_OFFSET", () => {
    expect(decodeOffsetCursor(forgeCursor(50_000_000))).toBe(ADMIN_MAX_OFFSET)
    expect(decodeOffsetCursor(forgeCursor(Number.MAX_SAFE_INTEGER))).toBe(ADMIN_MAX_OFFSET)
    expect(decodeOffsetCursor(forgeCursor(Number.POSITIVE_INFINITY))).toBe(0)
  })
})
