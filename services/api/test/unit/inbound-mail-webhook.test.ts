import { createHmac } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify"
import { FakeInboundMail, FakeStorage } from "@civfix/shared/fakes"
import type { InboundMail, ParsedMail } from "@civfix/shared/interfaces"
import { InMemoryMailRepository } from "../helpers/admin/mail-repository.memory.js"
import { InMemoryInboundRepository } from "../helpers/admin/inbound-repository.memory.js"
import {
  assertSignature,
  registerInboundMailWebhook,
  CF_WEBHOOK_SIGNATURE_HEADER,
  CF_WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_MAX_CLOCK_SKEW_SEC,
} from "../../src/routes/webhooks/inbound-mail.routes.js"
import {
  INBOUND_ATTACHMENT_MAX_BYTES,
  INBOUND_PENDING_PREFIX,
} from "../../src/services/admin/inbound-processor.js"
import { makeErrorHandler } from "../../src/errors/http-mapper.js"
import type { Container } from "../../src/di.js"

/**
 * Offline unit tests for the pointer + HMAC inbound-mail webhook (POST /webhooks/inbound-mail). The
 * Cloudflare Email Worker writes the raw .eml to R2 and POSTs { key } signed with x-cf-signature; the
 * webhook verifies the HMAC and hands the key to processInboundObject. These run over a bare Fastify app
 * with a FakeStorage (seeded with the raw bytes), the FakeInboundMail parser, an in-memory mail repo,
 * and an in-memory inbound repo (no DB, no R2, no Docker). They prove:
 *   - a VALID signature processes the object: a reply+{token} threads into mail_threads; a no-token
 *     message lands in inbound_emails; the pending object is DELETED on success;
 *   - a MISSING / WRONG signature, or an unconfigured secret, is rejected (401) and writes nothing;
 *   - a bad key / missing object / parse failure is ACKed (202) and never retry-loops (parse failures
 *     are parked under inbound/failed/);
 *   - a re-delivered reply (same message_id) is a no-op (idempotent), and attachments stream to R2.
 */

const SECRET = "cf-webhook-secret-value"
const encoder = new TextEncoder()
let counter = 0

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex")
}

/**
 * Build a minimal RFC822 message the FakeInboundMail subset parses (headers, blank line, body).
 *
 * A DMARC-pass Authentication-Results header is stamped by default. The processor only lets
 * DMARC-aligned mail reach the threaded path, so a fixture without one is Inbox-only by design.
 */
function rfc822(opts: {
  from: string
  to: string
  subject?: string
  body?: string
  messageId?: string
  /** Set false to omit Authentication-Results (the "unknown verdict" case). */
  authenticated?: boolean
}): Buffer {
  const lines = [`From: ${opts.from}`, `To: ${opts.to}`]
  if (opts.subject !== undefined) lines.push(`Subject: ${opts.subject}`)
  if (opts.messageId !== undefined) lines.push(`Message-ID: ${opts.messageId}`)
  if (opts.authenticated !== false) {
    const domain = opts.from.slice(opts.from.lastIndexOf("@") + 1)
    lines.push(`Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=${domain}`)
  }
  lines.push("", opts.body ?? "")
  return Buffer.from(lines.join("\n"), "utf8")
}

/** An InboundMail that delegates to FakeInboundMail but attaches the given attachments to the parsed mail. */
class InboundMailWithAttachments implements InboundMail {
  private readonly base = new FakeInboundMail()
  constructor(
    private readonly attachments: { filename: string; content?: Uint8Array; size?: number }[],
  ) {}
  async parse(raw: Uint8Array): Promise<ParsedMail> {
    const mail = await this.base.parse(raw)
    return { ...mail, attachments: this.attachments }
  }
  extractThreadToken(mail: ParsedMail): string | null {
    return this.base.extractThreadToken(mail)
  }
}

interface Harness {
  app: FastifyInstance
  mailRepo: InMemoryMailRepository
  inboundRepo: InMemoryInboundRepository
  storage: FakeStorage
  secret: string | undefined
}

async function harness(opts?: {
  secret?: string | undefined
  inboundMail?: InboundMail
}): Promise<Harness> {
  const mailRepo = new InMemoryMailRepository()
  const inboundRepo = new InMemoryInboundRepository()
  const storage = new FakeStorage()
  const inboundMail = opts?.inboundMail ?? new FakeInboundMail()
  const secret = opts && "secret" in opts ? opts.secret : SECRET
  const container = {
    env: { CF_EMAIL_WEBHOOK_SECRET: secret },
    inboundMail,
  } as unknown as Container

  const app = Fastify()
  app.setErrorHandler(makeErrorHandler())
  app.decorate("inboundMailOverrides", { storage, inboundMail, mailRepo, inboundRepo })
  await registerInboundMailWebhook(app, container)
  await app.ready()
  return { app, mailRepo, inboundRepo, storage, secret }
}

/** Seed the raw .eml at an inbound/pending key, then POST a signed { key } nudge. */
async function ingest(
  h: Harness,
  opts: { eml?: Buffer; key?: string; seed?: boolean; signature?: string; signBody?: string },
): Promise<{ res: Awaited<ReturnType<FastifyInstance["inject"]>>; key: string }> {
  const key = opts.key ?? `${INBOUND_PENDING_PREFIX}m-${counter++}.eml`
  if (opts.seed !== false && opts.eml) await h.storage.put(key, opts.eml)
  const body = JSON.stringify({ key })
  const signature = opts.signature ?? sign(opts.signBody ?? body, SECRET)
  const res = await h.app.inject({
    method: "POST",
    url: "/webhooks/inbound-mail",
    headers: { "content-type": "application/json", [CF_WEBHOOK_SIGNATURE_HEADER]: signature },
    payload: body,
  })
  return { res, key }
}

describe("inbound-mail webhook: authentication", () => {
  it("rejects a missing signature with 401 and writes nothing", async () => {
    const h = await harness()
    await h.storage.put(
      `${INBOUND_PENDING_PREFIX}x.eml`,
      rfc822({ from: "a@b.gov", to: "reply+t@civfix.org" }),
    )
    const res = await h.app.inject({
      method: "POST",
      url: "/webhooks/inbound-mail",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ key: `${INBOUND_PENDING_PREFIX}x.eml` }),
    })
    expect(res.statusCode).toBe(401)
    expect(h.mailRepo.threads.size).toBe(0)
    await h.app.close()
  })

  it("rejects a wrong signature with 401", async () => {
    const h = await harness()
    const { res } = await ingest(h, {
      eml: rfc822({ from: "a@b.gov", to: "reply+t@civfix.org" }),
      signature: "deadbeef",
    })
    expect(res.statusCode).toBe(401)
    expect(h.mailRepo.threads.size).toBe(0)
    await h.app.close()
  })

  it("rejects every call (401) when the webhook secret is not configured", async () => {
    const h = await harness({ secret: undefined })
    const { res } = await ingest(h, { eml: rfc822({ from: "a@b.gov", to: "reply+t@civfix.org" }) })
    expect(res.statusCode).toBe(401)
    await h.app.close()
  })
})

describe("inbound-mail webhook: reply threading (token present)", () => {
  it("threads onto an existing thread, marks unread, records an event, and deletes the pending object", async () => {
    const h = await harness()
    const thread = h.mailRepo.seedThread({
      threadToken: "0a0a0a0a0a0a0a0a0a0a0a0a",
      org: "City of LA",
    })
    const { res, key } = await ingest(h, {
      eml: rfc822({
        from: "clerk@lacity.gov",
        to: "reply+0a0a0a0a0a0a0a0a0a0a0a0a@civfix.org",
        subject: "Re: Pothole",
        body: "We are on it.",
        messageId: "<abc@lacity.gov>",
      }),
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ accepted: true, outcome: "threaded" })

    expect(h.mailRepo.threads.size).toBe(1)
    const dto = await h.mailRepo.getThread(thread.id)
    expect(dto?.messages).toHaveLength(1)
    expect(dto?.messages[0]?.dir).toBe("in")
    expect(dto?.messages[0]?.body).toBe("We are on it.")
    expect((await h.mailRepo.getThreadRecord(thread.id))?.unread).toBe(true)
    expect(h.mailRepo.events[0]?.type).toBe("delivered")
    // Pending object consumed (deleted) on success.
    expect(h.storage.get(key)).toBeNull()
    await h.app.close()
  })

  it("an UNKNOWN reply token mints no thread; it lands in inbound_emails (finding #37)", async () => {
    const h = await harness()
    const { res } = await ingest(h, {
      eml: rfc822({
        from: "x@city.gov",
        to: "reply+0b0b0b0b0b0b0b0b0b0b0b0b@civfix.org",
        body: "hi",
      }),
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ accepted: true, outcome: "inbox" })
    expect(h.mailRepo.threads.size).toBe(0)
    expect(h.inboundRepo.rows).toHaveLength(1)
    await h.app.close()
  })

  it("is idempotent: a re-delivered reply (same message-id) does not insert a second message", async () => {
    const h = await harness()
    h.mailRepo.seedThread({ threadToken: "0c0c0c0c0c0c0c0c0c0c0c0c" })
    const eml = rfc822({
      from: "c@city.gov",
      to: "reply+0c0c0c0c0c0c0c0c0c0c0c0c@civfix.org",
      body: "first",
      messageId: "<dup-1@city.gov>",
    })
    const first = await ingest(h, { eml, key: `${INBOUND_PENDING_PREFIX}dup.eml` })
    expect(first.res.json()).toMatchObject({ outcome: "threaded" })
    // Re-seed the SAME object + key (as if the worker re-delivered) and process again.
    const second = await ingest(h, { eml, key: `${INBOUND_PENDING_PREFIX}dup.eml` })
    expect(second.res.json()).toMatchObject({ outcome: "replay" })
    expect(h.mailRepo.messages).toHaveLength(1)
    await h.app.close()
  })

  it("streams an attachment to R2 and stores it on the message", async () => {
    const bytes = encoder.encode("PDF-BYTES-HERE")
    const h = await harness({
      inboundMail: new InboundMailWithAttachments([
        { filename: "notice.pdf", content: bytes, size: bytes.byteLength },
      ]),
    })
    h.mailRepo.seedThread({ threadToken: "0d0d0d0d0d0d0d0d0d0d0d0d" })
    const { res } = await ingest(h, {
      eml: rfc822({
        from: "c@city.gov",
        to: "reply+0d0d0d0d0d0d0d0d0d0d0d0d@civfix.org",
        body: "see attached",
      }),
    })
    expect(res.statusCode).toBe(202)
    const att =
      (await h.mailRepo.getThread([...h.mailRepo.threads.values()][0]!.id))?.messages[0]
        ?.attachments ?? []
    expect(att).toHaveLength(1)
    expect(att[0]?.filename).toBe("notice.pdf")
    expect(h.storage.get(att[0]!.key)).not.toBeNull()
    await h.app.close()
  })

  it("preserves an OVER-SIZE attachment by reference (flagged, not stored)", async () => {
    const h = await harness({
      inboundMail: new InboundMailWithAttachments([
        { filename: "huge.zip", size: INBOUND_ATTACHMENT_MAX_BYTES + 1 },
      ]),
    })
    h.mailRepo.seedThread({ threadToken: "0e0e0e0e0e0e0e0e0e0e0e0e" })
    const { res } = await ingest(h, {
      eml: rfc822({
        from: "c@city.gov",
        to: "reply+0e0e0e0e0e0e0e0e0e0e0e0e@civfix.org",
        body: "big",
      }),
    })
    expect(res.statusCode).toBe(202)
    const dto = await h.mailRepo.getThread([...h.mailRepo.threads.values()][0]!.id)
    expect(dto?.messages[0]?.attachments).toHaveLength(0)
    expect(h.mailRepo.events[0]?.meta).toMatchObject({ oversizeAttachments: ["huge.zip"] })
    await h.app.close()
  })
})

describe("inbound-mail webhook: catch-all (no token) -> inbox", () => {
  it("inserts a no-token message into inbound_emails and deletes the pending object", async () => {
    const h = await harness()
    const { res, key } = await ingest(h, {
      eml: rfc822({
        from: "resident@example.com",
        to: "support@civfix.org",
        subject: "Help",
        body: "question",
      }),
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ accepted: true, outcome: "inbox" })
    expect(h.inboundRepo.rows).toHaveLength(1)
    expect(h.inboundRepo.rows[0]?.recipient).toBe("support@civfix.org")
    expect(h.mailRepo.threads.size).toBe(0)
    expect(h.storage.get(key)).toBeNull()
    await h.app.close()
  })

  it("is idempotent: a re-delivered catch-all message inserts one inbox row", async () => {
    const h = await harness()
    const eml = rfc822({
      from: "r@example.com",
      to: "hello@civfix.org",
      body: "x",
      messageId: "<inbox-1@example.com>",
    })
    await ingest(h, { eml, key: `${INBOUND_PENDING_PREFIX}ib.eml` })
    const second = await ingest(h, { eml, key: `${INBOUND_PENDING_PREFIX}ib.eml` })
    expect(second.res.json()).toMatchObject({ outcome: "replay" })
    expect(h.inboundRepo.rows).toHaveLength(1)
    await h.app.close()
  })
})

describe("inbound-mail webhook: malformed / safe handling", () => {
  it("ACKs (202, bad-key) when the key is not an inbound/pending .eml key", async () => {
    const h = await harness()
    const body = JSON.stringify({ key: "secrets/passwords.txt" })
    const res = await h.app.inject({
      method: "POST",
      url: "/webhooks/inbound-mail",
      headers: {
        "content-type": "application/json",
        [CF_WEBHOOK_SIGNATURE_HEADER]: sign(body, SECRET),
      },
      payload: body,
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ accepted: true, reason: "bad-key" })
    await h.app.close()
  })

  it("ACKs (202, skipped) when the object is missing from R2", async () => {
    const h = await harness()
    const { res } = await ingest(h, { key: `${INBOUND_PENDING_PREFIX}gone.eml`, seed: false })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ accepted: true, outcome: "skipped" })
    await h.app.close()
  })

  it("ACKs (202) and parks a poison body under inbound/failed/ (no retry loop)", async () => {
    const throwingParser: InboundMail = {
      parse: () => Promise.reject(new Error("bad mime")),
      extractThreadToken: () => null,
    }
    const h = await harness({ inboundMail: throwingParser })
    const { res, key } = await ingest(h, { eml: Buffer.from("not a real message", "utf8") })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ accepted: true, outcome: "failed" })
    // Moved out of pending into failed.
    expect(h.storage.get(key)).toBeNull()
    expect(h.storage.get(key.replace("inbound/pending/", "inbound/failed/"))).not.toBeNull()
    await h.app.close()
  })
})

/**
 * The HMAC used to cover the body ALONE, with no timestamp and no nonce, so a captured
 * (body, signature) pair stayed valid forever. The signed payload is now `<timestamp>.<body>` and the
 * timestamp must be fresh.
 */
describe("inbound-mail webhook: signature replay window (L17)", () => {
  function signTimestamped(ts: number, body: string): string {
    return createHmac("sha256", SECRET).update(`${ts}.`).update(body).digest("hex")
  }

  async function postSigned(
    h: Harness,
    key: string,
    ts: number,
    signature?: string,
  ): Promise<Awaited<ReturnType<FastifyInstance["inject"]>>> {
    const body = JSON.stringify({ key })
    return h.app.inject({
      method: "POST",
      url: "/webhooks/inbound-mail",
      headers: {
        "content-type": "application/json",
        [CF_WEBHOOK_SIGNATURE_HEADER]: signature ?? signTimestamped(ts, body),
        [CF_WEBHOOK_TIMESTAMP_HEADER]: String(ts),
      },
      payload: body,
    })
  }

  it("accepts a fresh timestamped signature", async () => {
    const h = await harness()
    const key = `${INBOUND_PENDING_PREFIX}ts-ok.eml`
    await h.storage.put(key, rfc822({ from: "a@b.gov", to: "support@civfix.org", body: "x" }))
    const res = await postSigned(h, key, Math.floor(Date.now() / 1000))
    expect(res.statusCode).toBe(202)
    await h.app.close()
  })

  it("rejects a CAPTURED pair replayed outside the window (401), even though the MAC is valid", async () => {
    const h = await harness()
    const key = `${INBOUND_PENDING_PREFIX}ts-stale.eml`
    await h.storage.put(key, rfc822({ from: "a@b.gov", to: "support@civfix.org", body: "x" }))
    const stale = Math.floor(Date.now() / 1000) - (WEBHOOK_MAX_CLOCK_SKEW_SEC + 60)
    const res = await postSigned(h, key, stale)
    expect(res.statusCode).toBe(401)
    expect(h.inboundRepo.rows).toHaveLength(0)
    await h.app.close()
  })

  it("rejects a far-FUTURE timestamp (401)", async () => {
    const h = await harness()
    const key = `${INBOUND_PENDING_PREFIX}ts-future.eml`
    await h.storage.put(key, rfc822({ from: "a@b.gov", to: "support@civfix.org", body: "x" }))
    const future = Math.floor(Date.now() / 1000) + (WEBHOOK_MAX_CLOCK_SKEW_SEC + 60)
    expect((await postSigned(h, key, future)).statusCode).toBe(401)
    await h.app.close()
  })

  it("rejects a fresh timestamp paired with a body-only (legacy) signature: the ts is INSIDE the MAC", async () => {
    const h = await harness()
    const key = `${INBOUND_PENDING_PREFIX}ts-mixed.eml`
    await h.storage.put(key, rfc822({ from: "a@b.gov", to: "support@civfix.org", body: "x" }))
    const ts = Math.floor(Date.now() / 1000)
    const bodyOnly = sign(JSON.stringify({ key }), SECRET)
    expect((await postSigned(h, key, ts, bodyOnly)).statusCode).toBe(401)
    await h.app.close()
  })
})

describe("inbound-mail webhook: rejected nudges are logged", () => {
  it("warns with the reason and a count at most once a minute, never the secret or the key", () => {
    const warn = vi.fn()
    const now = Math.floor(Date.now() / 1000) + 10_000
    const body = Buffer.from(JSON.stringify({ key: `${INBOUND_PENDING_PREFIX}private-key.eml` }))
    const request = {
      headers: { [CF_WEBHOOK_SIGNATURE_HEADER]: "bad", [CF_WEBHOOK_TIMESTAMP_HEADER]: String(now) },
      log: { warn },
    } as unknown as FastifyRequest
    for (const at of [now, now + 1, now + 59, now + 60]) {
      expect(() => assertSignature(request, body, SECRET, at)).toThrow(/signature/)
    }
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ reason: "mismatch" })
    expect(warn.mock.calls[1]?.[0]).toEqual({ reason: "mismatch", rejected: 3 })
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(new RegExp(`${SECRET}|private-key`))
  })
})
