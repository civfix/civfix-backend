import { describe, expect, it } from "vitest"
import {
  UNSUBSCRIBE_TOKEN_TTL_DAYS,
  mintUnsubscribeToken,
  unsubscribeExpiryFrom,
  verifyUnsubscribeToken,
} from "../../src/services/host/broadcast-capability-token.js"

const KEY = "unsubscribe-signing-key-for-tests-0123456789"
const OTHER_KEY = "a-different-unsubscribe-signing-key-9876543210"
const NOW = Date.UTC(2026, 0, 1)

function mint(overrides: Partial<Parameters<typeof mintUnsubscribeToken>[0]> = {}): string {
  return mintUnsubscribeToken(
    {
      subjectKind: "user",
      subjectId: "11111111-1111-1111-1111-111111111111",
      cleanupId: "22222222-2222-2222-2222-222222222222",
      expiresAtMs: unsubscribeExpiryFrom(NOW),
      ...overrides,
    },
    KEY,
  )
}

describe("unsubscribe capability token", () => {
  it("round-trips a valid token", () => {
    const capability = verifyUnsubscribeToken(mint(), KEY, NOW)
    expect(capability).not.toBeNull()
    expect(capability?.subjectKind).toBe("user")
    expect(capability?.subjectId).toBe("11111111-1111-1111-1111-111111111111")
    expect(capability?.cleanupId).toBe("22222222-2222-2222-2222-222222222222")
  })

  it("carries no contact detail in the payload", () => {
    const token = mint()
    const payload = Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")
    expect(payload).not.toMatch(/@/)
    expect(payload).not.toMatch(/email/i)
  })

  it("rejects a token signed with another key", () => {
    expect(verifyUnsubscribeToken(mint(), OTHER_KEY, NOW)).toBeNull()
  })

  it("rejects a tampered payload", () => {
    const [version, body, signature] = mint().split(".") as [string, string, string]
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      i: string
    }
    decoded.i = "33333333-3333-3333-3333-333333333333"
    const forged = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url")
    expect(verifyUnsubscribeToken(`${version}.${forged}.${signature}`, KEY, NOW)).toBeNull()
  })

  it("rejects an expired token", () => {
    const token = mint({ expiresAtMs: NOW + 1000 })
    expect(verifyUnsubscribeToken(token, KEY, NOW + 2000)).toBeNull()
  })

  it("expires 400 days after the send", () => {
    expect(unsubscribeExpiryFrom(NOW) - NOW).toBe(UNSUBSCRIBE_TOKEN_TTL_DAYS * 86_400_000)
  })

  it("is total on garbage input", () => {
    for (const garbage of ["", "x", "u1", "u1.", "u1..", "a.b.c", "u2.aaa.bbb", "....."]) {
      expect(verifyUnsubscribeToken(garbage, KEY, NOW)).toBeNull()
    }
  })
})
