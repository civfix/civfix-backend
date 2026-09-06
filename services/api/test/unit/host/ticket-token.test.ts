import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import {
  makeTicketTokenSigner,
  normalizeTicketToken,
  TICKET_TOKEN_LENGTH,
} from "../../../src/services/host/ticket-token.js"

const SECRET = "a-test-ticket-token-secret-that-is-long-enough"
const SEAT = "11111111-1111-1111-1111-111111111111"

describe("ticket tokens", () => {
  const signer = makeTicketTokenSigner(SECRET)

  it("is a 26-character base32 group derived from the seat id", () => {
    const token = signer.tokenFor(SEAT)
    expect(token).toHaveLength(TICKET_TOKEN_LENGTH)
    expect(token).toMatch(/^[A-Z2-7]+$/u)
  })

  it("is deterministic for one seat and different for another", () => {
    expect(signer.tokenFor(SEAT)).toBe(signer.tokenFor(SEAT))
    expect(signer.tokenFor(SEAT)).not.toBe(
      signer.tokenFor("22222222-2222-2222-2222-222222222222"),
    )
  })

  it("changes completely when the secret rotates", () => {
    const other = makeTicketTokenSigner(`${SECRET}-rotated`)
    expect(other.tokenFor(SEAT)).not.toBe(signer.tokenFor(SEAT))
  })

  it("stores only the sha256 of the token", () => {
    const token = signer.tokenFor(SEAT)
    expect(signer.hashFor(SEAT)).toBe(createHash("sha256").update(token).digest("hex"))
    expect(signer.hashFor(SEAT)).not.toContain(token)
  })

  it("verifies a token round trip and rejects a forgery", () => {
    expect(signer.verify(SEAT, signer.tokenFor(SEAT))).toBe(true)
    expect(signer.verify(SEAT, "AAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(false)
    expect(signer.verify("22222222-2222-2222-2222-222222222222", signer.tokenFor(SEAT))).toBe(
      false,
    )
  })

  it("normalizes the scanner's spacing and case before hashing", () => {
    const token = signer.tokenFor(SEAT)
    const grouped = `${token.slice(0, 4)}-${token.slice(4, 8)} ${token.slice(8)}`.toLowerCase()
    expect(normalizeTicketToken(grouped)).toBe(token)
    expect(signer.hashOf(grouped)).toBe(signer.hashFor(SEAT))
    expect(signer.verify(SEAT, grouped)).toBe(true)
  })

  it("refuses to build a signer with an empty secret", () => {
    expect(() => makeTicketTokenSigner("")).toThrow(/TICKET_TOKEN_SECRET/u)
  })
})
