import { describe, expect, it } from "vitest"
import {
  mintDonationStatusToken,
  verifyDonationStatusToken,
} from "../../../src/services/payments/donation-status-token.js"

const KEY = "a-test-donation-status-token-key-32-chars"
const OTHER_KEY = "a-different-donation-status-token-key-32"
const DONATION = "11111111-2222-4333-8444-555555555555"
const OTHER_DONATION = "99999999-8888-4777-8666-555555555555"

describe("donation status token", () => {
  it("is deterministic, so it is byte-identical across processes and a blue/green swap", () => {
    expect(mintDonationStatusToken(KEY, DONATION)).toBe(mintDonationStatusToken(KEY, DONATION))
  })

  it("is bound to the donation id", () => {
    expect(mintDonationStatusToken(KEY, DONATION)).not.toBe(
      mintDonationStatusToken(KEY, OTHER_DONATION),
    )
    expect(verifyDonationStatusToken(KEY, OTHER_DONATION, mintDonationStatusToken(KEY, DONATION))).toBe(
      false,
    )
  })

  it("is bound to the key", () => {
    expect(
      verifyDonationStatusToken(OTHER_KEY, DONATION, mintDonationStatusToken(KEY, DONATION)),
    ).toBe(false)
  })

  it("accepts the token it minted", () => {
    expect(verifyDonationStatusToken(KEY, DONATION, mintDonationStatusToken(KEY, DONATION))).toBe(true)
  })

  it("rejects a missing, empty, truncated or forged token identically", () => {
    const good = mintDonationStatusToken(KEY, DONATION)
    for (const presented of [
      undefined,
      null,
      "",
      good.slice(0, -1),
      `${good}x`,
      "v1.notarealmac",
      good.replace("v1.", "v2."),
    ]) {
      expect(verifyDonationStatusToken(KEY, DONATION, presented)).toBe(false)
    }
  })

  it("carries a version prefix so the format can change without silently accepting old tokens", () => {
    expect(mintDonationStatusToken(KEY, DONATION).startsWith("v1.")).toBe(true)
  })
})
