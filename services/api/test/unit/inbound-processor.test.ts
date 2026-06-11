import { describe, expect, it } from "vitest"
import { FakeInboundMail, FakeStorage } from "@civfix/shared/fakes"
import type { InboundMail } from "@civfix/shared/interfaces"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { InMemoryInboundRepository } from "../../src/services/admin/inbound-repository.memory.js"
import {
  processInboundObject,
  resolveMessageId,
  INBOUND_PENDING_PREFIX,
  type InboundProcessorDeps,
} from "../../src/services/admin/inbound-processor.js"
import type { Container } from "../../src/di.js"

/**
 * Unit tests for processInboundObject — the shared core of the webhook + sweep. Verifies routing
 * (reply -> mail_threads; no-token -> inbound_emails), idempotency on both paths, parse-failure parking,
 * the missing-object short-circuit, and that a consumed object is deleted.
 */

function rfc822(opts: { from: string; to: string; body?: string; messageId?: string }): Buffer {
  const lines = [`From: ${opts.from}`, `To: ${opts.to}`]
  if (opts.messageId !== undefined) lines.push(`Message-ID: ${opts.messageId}`)
  lines.push("", opts.body ?? "")
  return Buffer.from(lines.join("\n"), "utf8")
}

interface Ctx {
  container: Container
  deps: InboundProcessorDeps
  storage: FakeStorage
  mailRepo: InMemoryMailRepository
  inboundRepo: InMemoryInboundRepository
}

function ctx(inboundMail: InboundMail = new FakeInboundMail()): Ctx {
  const storage = new FakeStorage()
  const mailRepo = new InMemoryMailRepository()
  const inboundRepo = new InMemoryInboundRepository()
  const deps: InboundProcessorDeps = { storage, inboundMail, mailRepo, inboundRepo }
  const container = { env: {}, storage, inboundMail } as unknown as Container
  return { container, deps, storage, mailRepo, inboundRepo }
}

async function put(c: Ctx, key: string, eml: Buffer): Promise<void> {
  await c.storage.put(key, eml)
}

describe("processInboundObject: routing", () => {
  it("routes a reply+{token} message into mail_threads and deletes the object", async () => {
    const c = ctx()
    c.mailRepo.seedThread({ threadToken: "tok" })
    const key = `${INBOUND_PENDING_PREFIX}a.eml`
    await put(c, key, rfc822({ from: "c@city.gov", to: "reply+tok@civfix.org", body: "hi" }))
    const r = await processInboundObject(c.container, key, c.deps)
    expect(r.outcome).toBe("threaded")
    expect(c.mailRepo.messages).toHaveLength(1)
    expect(c.inboundRepo.rows).toHaveLength(0)
    expect(c.storage.get(key)).toBeNull()
  })

  it("routes a no-token message into inbound_emails and deletes the object", async () => {
    const c = ctx()
    const key = `${INBOUND_PENDING_PREFIX}b.eml`
    await put(c, key, rfc822({ from: "r@example.com", to: "support@civfix.org", body: "q" }))
    const r = await processInboundObject(c.container, key, c.deps)
    expect(r.outcome).toBe("inbox")
    expect(c.inboundRepo.rows).toHaveLength(1)
    expect(c.inboundRepo.rows[0]?.recipient).toBe("support@civfix.org")
    expect(c.mailRepo.threads.size).toBe(0)
    expect(c.storage.get(key)).toBeNull()
  })
})

describe("processInboundObject: idempotency", () => {
  it("threaded path dedups on message_id (replay inserts no second message)", async () => {
    const c = ctx()
    c.mailRepo.seedThread({ threadToken: "tok" })
    const eml = rfc822({ from: "c@city.gov", to: "reply+tok@civfix.org", body: "x", messageId: "<m1@city.gov>" })
    const key = `${INBOUND_PENDING_PREFIX}c.eml`
    await put(c, key, eml)
    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("threaded")
    await put(c, key, eml) // re-deliver the same object
    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("replay")
    expect(c.mailRepo.messages).toHaveLength(1)
  })

  it("inbox path dedups on the UNIQUE message_id", async () => {
    const c = ctx()
    const eml = rfc822({ from: "r@example.com", to: "hi@civfix.org", body: "x", messageId: "<m2@example.com>" })
    const key = `${INBOUND_PENDING_PREFIX}d.eml`
    await put(c, key, eml)
    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("inbox")
    await put(c, key, eml)
    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("replay")
    expect(c.inboundRepo.rows).toHaveLength(1)
  })
})

describe("processInboundObject: safety", () => {
  it("parks a parse-poisoned object under inbound/failed/ and does not delete the source on the failed path", async () => {
    const throwing: InboundMail = {
      parse: () => Promise.reject(new Error("bad mime")),
      extractThreadToken: () => null,
    }
    const c = ctx(throwing)
    const key = `${INBOUND_PENDING_PREFIX}e.eml`
    await put(c, key, Buffer.from("junk"))
    const r = await processInboundObject(c.container, key, c.deps)
    expect(r.outcome).toBe("failed")
    expect(c.storage.get(key)).toBeNull()
    expect(c.storage.get(key.replace("inbound/pending/", "inbound/failed/"))).not.toBeNull()
  })

  it("short-circuits (skipped) when the object is missing", async () => {
    const c = ctx()
    const r = await processInboundObject(c.container, `${INBOUND_PENDING_PREFIX}gone.eml`, c.deps)
    expect(r.outcome).toBe("skipped")
  })
})

describe("resolveMessageId", () => {
  it("prefers the Message-ID and derives a stable hash otherwise", async () => {
    const parser = new FakeInboundMail()
    const withId = await parser.parse(rfc822({ from: "a@b", to: "c@d", messageId: "<x@y>" }))
    expect(resolveMessageId(withId)).toBe("<x@y>")
    const noId = await parser.parse(rfc822({ from: "a@b", to: "c@d", body: "same" }))
    const noId2 = await parser.parse(rfc822({ from: "a@b", to: "c@d", body: "same" }))
    expect(resolveMessageId(noId)).toMatch(/^derived:[0-9a-f]{64}$/)
    expect(resolveMessageId(noId)).toBe(resolveMessageId(noId2))
  })
})
