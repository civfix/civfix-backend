import { afterEach, describe, expect, it } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { FakeInboundMail, FakeStorage } from "@civfix/shared/fakes"
import type { InboundMail, ParsedMail } from "@civfix/shared/interfaces"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import {
  registerInboundMailWebhook,
  CF_WEBHOOK_SECRET_HEADER,
  INBOUND_ATTACHMENT_MAX_BYTES,
} from "../../src/routes/webhooks/inbound-mail.routes.js"
import { makeErrorHandler } from "../../src/errors/http-mapper.js"
import type { Container } from "../../src/di.js"

/**
 * Offline unit tests for the inbound-mail webhook (POST /webhooks/inbound-mail) over a bare Fastify app
 * with the AppError -> HTTP mapper, the container's FakeInboundMail parser, an in-memory MailRepository,
 * and a FakeStorage (no DB, no R2, no Docker). They prove:
 *   - a VALID secret parses the RFC822 body, threads by reply+{token}, inserts the inbound message, marks
 *     the thread unread, records a mail_event, and streams attachments to R2 (key/filename/size);
 *   - a MISSING / WRONG secret is rejected (401) and writes nothing;
 *   - MALFORMED input (no token, unparseable body, empty body) is acknowledged with 202 and is safe (no
 *     thread/message created), so the Cloudflare worker never retry-loops a poison message;
 *   - an OVER-SIZE attachment is preserved (message stored, event flagged) but NOT streamed to R2.
 */

const SECRET = "cf-webhook-secret-value"
const encoder = new TextEncoder()

/** Build a minimal RFC822 message the FakeInboundMail subset parses (headers, blank line, body). */
function rfc822(opts: {
  from: string
  to: string
  subject?: string
  body?: string
  messageId?: string
}): Buffer {
  const lines = [`From: ${opts.from}`, `To: ${opts.to}`]
  if (opts.subject !== undefined) lines.push(`Subject: ${opts.subject}`)
  if (opts.messageId !== undefined) lines.push(`Message-ID: ${opts.messageId}`)
  lines.push("", opts.body ?? "")
  return Buffer.from(lines.join("\n"), "utf8")
}

/**
 * An InboundMail that delegates parsing to the FakeInboundMail subset but ATTACHES the given attachments
 * onto the parsed object, so the webhook's defensive attachment-streaming path is exercised (the Phase 2
 * ParsedMail shape does not model attachments; the webhook reads them structurally when present).
 */
class InboundMailWithAttachments implements InboundMail {
  private readonly base = new FakeInboundMail()
  constructor(
    private readonly attachments: { filename: string; content?: Uint8Array; size?: number }[],
  ) {}
  async parse(raw: Uint8Array): Promise<ParsedMail> {
    const mail = await this.base.parse(raw)
    return { ...mail, attachments: this.attachments } as ParsedMail
  }
  extractThreadToken(mail: ParsedMail): string | null {
    return this.base.extractThreadToken(mail)
  }
}

interface Harness {
  app: FastifyInstance
  repo: InMemoryMailRepository
  storage: FakeStorage
}

/** Build a bare Fastify app with the webhook registered against a stub container + in-memory deps. */
async function harness(opts?: {
  secret?: string | undefined
  inboundMail?: InboundMail
}): Promise<Harness> {
  const repo = new InMemoryMailRepository()
  const storage = new FakeStorage()
  const inboundMail = opts?.inboundMail ?? new FakeInboundMail()
  const secret = opts && "secret" in opts ? opts.secret : SECRET

  // The webhook only touches container.env.CF_EMAIL_WEBHOOK_SECRET + container.inboundMail (repo/storage
  // come from the route override below), so a narrow stub container suffices.
  const container = {
    env: { CF_EMAIL_WEBHOOK_SECRET: secret },
    inboundMail,
  } as unknown as Container

  const app = Fastify()
  app.setErrorHandler(makeErrorHandler())
  app.decorate("inboundMailOverrides", { repo, storage })
  await registerInboundMailWebhook(app, container)
  await app.ready()
  return { app, repo, storage }
}

afterEach(() => {
  // Each test builds + closes its own app; nothing global to reset.
})

describe("inbound-mail webhook: authentication", () => {
  it("rejects a missing secret header with 401 and writes nothing", async () => {
    const { app, repo } = await harness()
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/inbound-mail",
      headers: { "content-type": "message/rfc822" },
      payload: rfc822({ from: "clerk@city.gov", to: "reply+tok1@civfix.org" }),
    })
    expect(res.statusCode).toBe(401)
    expect(repo.threads.size).toBe(0)
    expect(repo.messages).toHaveLength(0)
    await app.close()
  })

  it("rejects a wrong secret with 401", async () => {
    const { app, repo } = await harness()
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/inbound-mail",
      headers: { "content-type": "message/rfc822", [CF_WEBHOOK_SECRET_HEADER]: "wrong" },
      payload: rfc822({ from: "clerk@city.gov", to: "reply+tok1@civfix.org" }),
    })
    expect(res.statusCode).toBe(401)
    expect(repo.threads.size).toBe(0)
    await app.close()
  })

  it("rejects every call (401) when the webhook secret is not configured", async () => {
    const { app } = await harness({ secret: undefined })
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/inbound-mail",
      headers: { "content-type": "message/rfc822", [CF_WEBHOOK_SECRET_HEADER]: SECRET },
      payload: rfc822({ from: "clerk@city.gov", to: "reply+tok1@civfix.org" }),
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})

describe("inbound-mail webhook: valid ingest", () => {
  it("parses, threads by reply+{token}, inserts the inbound message, marks unread, records an event", async () => {
    const { app, repo } = await harness()
    // Seed the outbound thread the reply belongs to (token tok-la).
    const thread = repo.seedThread({ threadToken: "tok-la", jurisdictionGeoid: "0644000", org: "City of LA" })

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/inbound-mail",
      headers: { "content-type": "message/rfc822", [CF_WEBHOOK_SECRET_HEADER]: SECRET },
      payload: rfc822({
        from: "clerk@lacity.gov",
        to: "reply+tok-la@civfix.org",
        subject: "Re: Pothole",
        body: "We are on it.",
        messageId: "<abc@lacity.gov>",
      }),
    })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ accepted: true, threaded: true, threadId: thread.id })

    // Threaded onto the SAME thread (no new thread minted).
    expect(repo.threads.size).toBe(1)
    const dto = await repo.getThread(thread.id)
    expect(dto?.messages).toHaveLength(1)
    expect(dto?.messages[0]?.dir).toBe("in")
    expect(dto?.messages[0]?.from).toBe("clerk@lacity.gov")
    expect(dto?.messages[0]?.body).toBe("We are on it.")
    // Inbound message marks the thread unread.
    expect((await repo.getThreadRecord(thread.id))?.unread).toBe(true)
    // A deliverability event was recorded, marked inbound-derived.
    expect(repo.events).toHaveLength(1)
    expect(repo.events[0]?.type).toBe("delivered")
    expect(repo.events[0]?.meta).toMatchObject({ direction: "in", from: "clerk@lacity.gov" })
    await app.close()
  })

  it("mints a fresh thread when the reply token is unknown (a stray inbound is not lost)", async () => {
    const { app, repo } = await harness()
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/inbound-mail",
      headers: { "content-type": "message/rfc822", [CF_WEBHOOK_SECRET_HEADER]: SECRET },
      payload: rfc822({ from: "someone@city.gov", to: "reply+unknown-tok@civfix.org", body: "hi" }),
    })
    expect(res.statusCode).toBe(202)
    expect(repo.threads.size).toBe(1)
    const created = [...repo.threads.values()][0]!
    expect(created.threadToken).toBe("unknown-tok")
    expect(created.unread).toBe(true)
    await app.close()
  })

  it("streams an attachment to R2 (key + filename + size) and stores it on the message", async () => {
    const bytes = encoder.encode("PDF-BYTES-HERE")
    const inboundMail = new InboundMailWithAttachments([
      { filename: "notice.pdf", content: bytes, size: bytes.byteLength },
    ])
    const { app, repo, storage } = await harness({ inboundMail })
    repo.seedThread({ threadToken: "tok-att" })

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/inbound-mail",
      headers: { "content-type": "message/rfc822", [CF_WEBHOOK_SECRET_HEADER]: SECRET },
      payload: rfc822({ from: "clerk@city.gov", to: "reply+tok-att@civfix.org", body: "see attached" }),
    })
    expect(res.statusCode).toBe(202)

    const created = [...repo.threads.values()][0]!
    const dto = await repo.getThread(created.id)
    const att = dto?.messages[0]?.attachments ?? []
    expect(att).toHaveLength(1)
    expect(att[0]?.filename).toBe("notice.pdf")
    expect(att[0]?.size).toBe(bytes.byteLength)
    // The bytes actually landed in storage under the recorded key.
    expect(storage.get(att[0]!.key)).not.toBeNull()
    await app.close()
  })

  it("preserves an OVER-SIZE attachment by reference (flagged on the event, not stored in R2)", async () => {
    const inboundMail = new InboundMailWithAttachments([
      { filename: "huge.zip", size: INBOUND_ATTACHMENT_MAX_BYTES + 1 },
    ])
    const { app, repo, storage } = await harness({ inboundMail })
    repo.seedThread({ threadToken: "tok-big" })

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/inbound-mail",
      headers: { "content-type": "message/rfc822", [CF_WEBHOOK_SECRET_HEADER]: SECRET },
      payload: rfc822({ from: "clerk@city.gov", to: "reply+tok-big@civfix.org", body: "big file" }),
    })
    expect(res.statusCode).toBe(202)

    const created = [...repo.threads.values()][0]!
    const dto = await repo.getThread(created.id)
    // The message is still stored (body preserved), but with NO stored attachment.
    expect(dto?.messages[0]?.body).toBe("big file")
    expect(dto?.messages[0]?.attachments).toHaveLength(0)
    // The event flags the over-size attachment by name, and nothing was written to storage.
    expect(repo.events[0]?.meta).toMatchObject({ oversizeAttachments: ["huge.zip"] })
    expect(storage.objects.size).toBe(0)
    await app.close()
  })
})

describe("inbound-mail webhook: malformed input is safe", () => {
  it("acknowledges (202) and writes nothing when there is no thread token", async () => {
    const { app, repo } = await harness()
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/inbound-mail",
      headers: { "content-type": "message/rfc822", [CF_WEBHOOK_SECRET_HEADER]: SECRET },
      // A plain To with no reply+{token} -> no token extractable.
      payload: rfc822({ from: "clerk@city.gov", to: "info@city.gov", body: "hello" }),
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ accepted: true, threaded: false, reason: "no-thread-token" })
    expect(repo.threads.size).toBe(0)
    expect(repo.messages).toHaveLength(0)
    await app.close()
  })

  it("acknowledges (202) when the parser throws (poison body does not retry-loop)", async () => {
    const throwingParser: InboundMail = {
      parse: () => Promise.reject(new Error("bad mime")),
      extractThreadToken: () => null,
    }
    const { app, repo } = await harness({ inboundMail: throwingParser })
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/inbound-mail",
      headers: { "content-type": "message/rfc822", [CF_WEBHOOK_SECRET_HEADER]: SECRET },
      payload: Buffer.from("not a real message", "utf8"),
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ accepted: true, threaded: false, reason: "parse-failed" })
    expect(repo.threads.size).toBe(0)
    await app.close()
  })

  it("acknowledges (202) with reason empty-body for an empty payload", async () => {
    const { app, repo } = await harness()
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/inbound-mail",
      headers: { "content-type": "message/rfc822", [CF_WEBHOOK_SECRET_HEADER]: SECRET },
      payload: Buffer.alloc(0),
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ accepted: true, threaded: false, reason: "empty-body" })
    expect(repo.threads.size).toBe(0)
    await app.close()
  })
})
