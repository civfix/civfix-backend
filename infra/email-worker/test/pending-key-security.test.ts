import { afterEach, describe, expect, it, vi } from "vitest"
import worker, { derivePendingKey, type Env } from "../src/index"

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

interface Stored {
  key: string
  messageId: string | undefined
}

async function receive(headers: Headers, raw: string): Promise<Stored[]> {
  const stored: Stored[] = []
  const env = {
    R2_BUCKET: {
      put: (key: string, _body: unknown, opts?: { customMetadata?: Record<string, string> }) => {
        stored.push({ key, messageId: opts?.customMetadata?.messageId })
        return Promise.resolve(null)
      },
    },
    BACKEND_WEBHOOK_URL: "https://api.example.test/webhooks/inbound-mail",
    CF_EMAIL_WEBHOOK_SECRET: "test-secret",
  } as unknown as Env
  const message = {
    raw: new Response(raw).body,
    headers,
    from: "clerk@example.gov",
    to: "reply@civfix.org",
    rawSize: raw.length,
    setReject: () => {},
  } as unknown as ForwardableEmailMessage
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext
  await worker.email(message, env, ctx)
  await Promise.all(pending)
  return stored
}

describe("the email handler hashes each message once", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function countDigests() {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(null, { status: 202 })))
    return vi.spyOn(crypto.subtle, "digest")
  }

  it("derives the fallback id and the pending key from one digest when there is no Message-ID", async () => {
    const digest = countDigests()

    const stored = await receive(new Headers(), "no id body")

    expect(digest).toHaveBeenCalledTimes(1)
    expect(stored).toHaveLength(1)
    expect(stored[0]!.messageId).toMatch(/^[0-9a-f]{64}$/)
    expect(stored[0]!.key).toBe(`inbound/pending/${stored[0]!.messageId}.eml`)
    expect(stored[0]!.key).toBe(await derivePendingKey(new Headers(), bytes("no id body")))
  })

  it("hashes once and keeps the slug-plus-digest key when a Message-ID is present", async () => {
    const digest = countDigests()
    const headers = withMessageId("<test-001@example.gov>")

    const stored = await receive(headers, "body")

    expect(digest).toHaveBeenCalledTimes(1)
    expect(stored[0]!.messageId).toBe("test-001@example.gov")
    expect(stored[0]!.key).toBe(await derivePendingKey(headers, bytes("body")))
  })
})
