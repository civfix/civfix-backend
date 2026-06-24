import { describe, it, expect } from "vitest"
import { isReservedHandle } from "../../src/auth/reserved-handles.js"

describe("isReservedHandle", () => {
  it("reserves the reviewer-OTP bypass handle (case-insensitively) so no real user can take it", () => {
    expect(isReservedHandle("reviewer")).toBe(true)
    expect(isReservedHandle("Reviewer")).toBe(true)
    expect(isReservedHandle("  REVIEWER  ")).toBe(true)
  })

  it("does not reserve an ordinary handle", () => {
    expect(isReservedHandle("janedoe")).toBe(false)
  })
})
