import { describe, expect, it } from "vitest"
import {
  SIGNUP_SEAT_BACKFILL_MAX_BATCH,
  parseSignupSeatBatchArg,
} from "../../src/db/backfill-signup-seats.js"

describe("backfill-signup-seats --batch", () => {
  it("is absent when the flag is not passed", () => {
    expect(parseSignupSeatBatchArg(["--yes"])).toBeUndefined()
  })

  it("accepts a positive integer up to the cap", () => {
    expect(parseSignupSeatBatchArg(["--yes", "--batch", "200"])).toBe(200)
    expect(parseSignupSeatBatchArg(["--batch", String(SIGNUP_SEAT_BACKFILL_MAX_BATCH)])).toBe(
      SIGNUP_SEAT_BACKFILL_MAX_BATCH,
    )
  })

  it("rejects a missing, non-numeric, fractional, zero or oversized value instead of LIMIT NaN", () => {
    for (const argv of [
      ["--batch"],
      ["--batch", "--yes"],
      ["--batch", "abc"],
      ["--batch", "2.5"],
      ["--batch", "0"],
      ["--batch", String(SIGNUP_SEAT_BACKFILL_MAX_BATCH + 1)],
    ]) {
      expect(parseSignupSeatBatchArg(argv), argv.join(" ")).toBeNull()
    }
  })
})
