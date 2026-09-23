import { describe, expect, it } from "vitest"
import { derivePendingKey } from "../src/index"

const BACKEND_PENDING_KEY_RE = /^inbound\/pending\/[^/]+\.eml$/

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer
}

function withMessageId(messageId: string): Headers {
  return new Headers({ "message-id": messageId })
}

describe("derivePendingKey", () => {
  it("gives Message-IDs that slug alike distinct keys when their bytes differ", async () => {
    const plus = await derivePendingKey(withMessageId("<a+b@x.example>"), bytes("city reply"))
    const equals = await derivePendingKey(withMessageId("<a=b@x.example>"), bytes("other mail"))
    expect(plus).not.toBe(equals)
  })

  it("gives a reused Message-ID with different bytes a different key", async () => {
    const original = await derivePendingKey(withMessageId("<city@lacity.gov>"), bytes("original"))
    const reused = await derivePendingKey(withMessageId("<city@lacity.gov>"), bytes("forged"))
    expect(original).not.toBe(reused)
  })

  it("maps a byte-identical redelivery onto the same key", async () => {
    const first = await derivePendingKey(withMessageId("<same@x.example>"), bytes("same body"))
    const again = await derivePendingKey(withMessageId("<same@x.example>"), bytes("same body"))
    expect(first).toBe(again)
  })

  it("stays inside the backend's pending-key shape for hostile or huge Message-IDs", async () => {
    for (const messageId of ["<a/b/../c@x>", `<${"x".repeat(5000)}@x>`, "", "<>"]) {
      const key = await derivePendingKey(withMessageId(messageId), bytes("body"))
      expect(key).toMatch(BACKEND_PENDING_KEY_RE)
      expect(key.length).toBeLessThanOrEqual(256)
    }
  })

  it("keeps a readable Message-ID slug in the key", async () => {
    const key = await derivePendingKey(withMessageId("<test-001@example.gov>"), bytes("body"))
    expect(key.startsWith("inbound/pending/test-001@example.gov.")).toBe(true)
  })

  it("falls back to the content hash alone when there is no Message-ID", async () => {
    const key = await derivePendingKey(new Headers(), bytes("body"))
    expect(key).toMatch(/^inbound\/pending\/[0-9a-f]{64}\.eml$/)
  })
})
