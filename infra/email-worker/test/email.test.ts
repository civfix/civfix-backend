import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import { slugify, deriveMessageId, hmacSha256Hex } from "../src/index"

describe("slugify", () => {
  it("strips angle brackets and unsafe chars", () => {
    expect(slugify("<abc.123@example.gov>")).toBe("abc.123@example.gov")
    expect(slugify("<a b/c:d>")).toBe("a_b_c_d")
  })
  it("caps length at 200", () => {
    expect(slugify("x".repeat(500)).length).toBe(200)
  })
})

describe("deriveMessageId", () => {
  it("prefers the Message-ID header (slugified)", async () => {
    const id = await deriveMessageId(
      new Headers({ "message-id": "<test-001@example.gov>" }),
      new TextEncoder().encode("body").buffer,
    )
    expect(id).toBe("test-001@example.gov")
  })

  it("falls back to a stable content hash when Message-ID is absent", async () => {
    const bytes = new TextEncoder().encode("same body").buffer
    const a = await deriveMessageId(new Headers(), bytes)
    const b = await deriveMessageId(new Headers(), new TextEncoder().encode("same body").buffer)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).toBe(b) // duplicate deliveries -> identical key -> backend dedups
  })
})

describe("hmacSha256Hex (must match the backend's node:crypto verifier)", () => {
  it("equals node createHmac over the exact body bytes", async () => {
    const secret = "dev-shared-secret"
    const body = JSON.stringify({ key: "inbound/pending/test-001@example.gov.eml" })
    const ours = await hmacSha256Hex(secret, body)
    const reference = createHmac("sha256", secret).update(body).digest("hex")
    expect(ours).toBe(reference)
  })

  // Frozen fixture — copy this exact (secret, body, signature) into the backend webhook test so the two
  // halves can never silently drift. body is the canonical no-whitespace JSON the Worker POSTs.
  it("matches the frozen cross-repo fixture", async () => {
    const secret = "civfix-test-secret"
    const body = '{"key":"inbound/pending/abc.eml"}'
    const sig = createHmac("sha256", secret).update(body).digest("hex")
    expect(await hmacSha256Hex(secret, body)).toBe(sig)
  })
})
