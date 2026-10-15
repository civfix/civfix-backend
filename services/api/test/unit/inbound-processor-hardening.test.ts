import { afterEach, describe, expect, it, vi } from "vitest"
import { FakeInboundMail, FakeJobs, FakeStorage } from "@civfix/shared/fakes"
import type { InboundMail } from "@civfix/shared/interfaces"
import { CfInboundMail } from "../../src/adapters/inbound-mail.cf.js"
import { InMemoryMailRepository } from "../helpers/admin/mail-repository.memory.js"
import { InMemoryInboundRepository } from "../helpers/admin/inbound-repository.memory.js"
import {
  processInboundObject,
  INBOUND_PENDING_PREFIX,
  INBOUND_ATTACHMENT_MAX_COUNT,
  INBOUND_BODY_TEXT_MAX_CHARS,
  INBOUND_PARSE_TIMEOUT_MS,
  type InboundProcessorDeps,
} from "../../src/services/admin/inbound-processor.js"
import type { Container } from "../../src/di.js"
import { makeFakeSql, type FakeSqlControl, type SqlHandler } from "../helpers/fake-sql.js"

const TOKEN = "0123456789abcdef01234567"

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1)
}

function rfc822(opts: { from: string; to: string; body?: string; messageId?: string }): Buffer {
  const lines = [`From: ${opts.from}`, `To: ${opts.to}`]
  if (opts.messageId !== undefined) lines.push(`Message-ID: ${opts.messageId}`)
  lines.push(
    `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=${domainOf(opts.from)}`,
  )
  lines.push("", opts.body ?? "")
  return Buffer.from(lines.join("\n"), "utf8")
}

function multipartWithAttachments(n: number): Buffer {
  const parts: string[] = []
  for (let i = 0; i < n; i++) {
    parts.push(
      `--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="f${i}.bin"\r\n\r\nx\r\n`,
    )
  }
  return Buffer.from(
    `From: r@example.com\r\nTo: support@civfix.org\r\nSubject: many\r\nMessage-ID: <many-${n}@example.com>\r\n` +
      `Content-Type: multipart/mixed; boundary=b\r\n\r\n${parts.join("")}--b--\r\n`,
    "utf8",
  )
}

interface Ctx {
  container: Container
  deps: InboundProcessorDeps
  storage: FakeStorage
  mailRepo: InMemoryMailRepository
  inboundRepo: InMemoryInboundRepository
  jobs: FakeJobs
  db: FakeSqlControl
}

function ctx(
  inboundMail: InboundMail = new FakeInboundMail(),
  sqlHandlers: SqlHandler[] = [],
): Ctx {
  const storage = new FakeStorage()
  const mailRepo = new InMemoryMailRepository()
  const inboundRepo = new InMemoryInboundRepository()
  const jobs = new FakeJobs()
  const db = makeFakeSql(sqlHandlers)
  const deps: InboundProcessorDeps = { storage, inboundMail, mailRepo, inboundRepo }
  const container = {
    env: {},
    storage,
    inboundStorage: storage,
    inboundMail,
    jobs,
    getDb: () => ({ sql: db.sql }),
  } as unknown as Container
  return { container, deps, storage, mailRepo, inboundRepo, jobs, db }
}

describe("F101: inbound mail never MINTS a thread", () => {
  it("routes a DMARC-passing reply to an UNISSUED token into the Inbox and creates zero threads", async () => {
    const c = ctx()
    const unissued = "ffffffffffffffffffffffff"
    const key = `${INBOUND_PENDING_PREFIX}unissued.eml`
    await c.storage.put(
      key,
      rfc822({ from: "clerk@lacity.gov", to: `reply+${unissued}@civfix.org`, body: "hello" }),
    )
    const r = await processInboundObject(c.container, key, c.deps)
    expect(r.outcome).toBe("inbox")
    expect(c.mailRepo.threads.size).toBe(0)
    expect(c.inboundRepo.rows).toHaveLength(1)
  })

  it("still threads a reply to an EXISTING (issued) token", async () => {
    const c = ctx()
    c.mailRepo.seedThread({ threadToken: TOKEN })
    const key = `${INBOUND_PENDING_PREFIX}issued.eml`
    await c.storage.put(
      key,
      rfc822({ from: "clerk@lacity.gov", to: `reply+${TOKEN}@civfix.org`, body: "hi" }),
    )
    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("threaded")
  })
})

describe("F098: attachment COUNT + aggregate-bytes cap (real adapter)", () => {
  it("stores at most INBOUND_ATTACHMENT_MAX_COUNT attachments from a many-part message", async () => {
    const c = ctx(new CfInboundMail())
    const n = INBOUND_ATTACHMENT_MAX_COUNT + 20
    const key = `${INBOUND_PENDING_PREFIX}manyparts.eml`
    await c.storage.put(key, multipartWithAttachments(n))
    const r = await processInboundObject(c.container, key, c.deps)
    expect(r.outcome).toBe("inbox")
    const stored = c.inboundRepo.rows[0]?.attachments ?? []
    expect(stored.length).toBeLessThanOrEqual(INBOUND_ATTACHMENT_MAX_COUNT)
    expect(stored.length).toBeGreaterThan(0)
  }, 30000)
})

describe("F104: body_text and the stored headers are bounded at write time", () => {
  function bigPlainText(bodyChars: number): Buffer {
    return Buffer.from(
      [
        "From: r@example.com",
        "To: support@civfix.org",
        "Subject: big",
        "Message-ID: <big@example.com>",
        `X-Spam-Report: ${"s".repeat(200)}`,
        `X-Mailer: ${"m".repeat(200)}`,
        "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=example.com",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "a".repeat(bodyChars),
      ].join("\r\n"),
      "utf8",
    )
  }

  it("clips an oversized text body to INBOUND_BODY_TEXT_MAX_CHARS with an explicit marker", async () => {
    const c = ctx(new CfInboundMail())
    const key = `${INBOUND_PENDING_PREFIX}bigbody.eml`
    await c.storage.put(key, bigPlainText(INBOUND_BODY_TEXT_MAX_CHARS + 50_000))

    const r = await processInboundObject(c.container, key, c.deps)
    expect(r.outcome).toBe("inbox")
    const stored = c.inboundRepo.rows[0]?.bodyText ?? ""
    expect(stored.length).toBeLessThan(INBOUND_BODY_TEXT_MAX_CHARS + 100)
    expect(stored.endsWith("… [truncated]")).toBe(true)
    expect(stored.startsWith("a".repeat(1000))).toBe(true)
  }, 30000)

  it("stores only allowlisted headers, dropping attacker-supplied ones", async () => {
    const c = ctx(new CfInboundMail())
    const key = `${INBOUND_PENDING_PREFIX}headers.eml`
    await c.storage.put(key, bigPlainText(10))

    await processInboundObject(c.container, key, c.deps)
    const headers = c.inboundRepo.rows[0]?.headers ?? {}
    expect(Object.keys(headers)).toContain("from")
    expect(Object.keys(headers)).toContain("message-id")
    expect(Object.keys(headers)).toContain("x-civfix-auth-verdict")
    expect(Object.keys(headers)).not.toContain("x-spam-report")
    expect(Object.keys(headers)).not.toContain("x-mailer")
  }, 30000)
})

describe("F097: a parse that overruns the budget is parked as poison", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("times out a hanging parse and moves the object to inbound/failed/", async () => {
    vi.useFakeTimers()
    const hanging: InboundMail = {
      parse: () => new Promise(() => {}),
      extractThreadToken: () => null,
    }
    const c = ctx(hanging)
    const key = `${INBOUND_PENDING_PREFIX}hang.eml`
    await c.storage.put(key, Buffer.from("From: a@b\r\nTo: c@d\r\n\r\nx"))
    const pending = processInboundObject(c.container, key, c.deps)
    await vi.advanceTimersByTimeAsync(INBOUND_PARSE_TIMEOUT_MS + 1)
    const r = await pending
    expect(r.outcome).toBe("failed")
    expect(r.reason).toBe("parse-failed")
    expect(c.storage.get(key)).toBeNull()
    expect(c.storage.get(key.replace("inbound/pending/", "inbound/failed/"))).not.toBeNull()
  })
})

describe("F100: a bounce correlated to a thread we did NOT send that recipient on is Inbox-only", () => {
  it("records no bounced event, no status flip, and no directory mutation when ownership fails", async () => {
    const c = ctx(new FakeInboundMail(), [
      { match: /UPDATE\s+jurisdiction_contacts\s+SET\s+bounced_at/i, rows: [] },
      { match: /FROM\s+mail_messages/i, rows: [{ ok: false }] },
      { match: /SELECT\s+geoid\s+FROM\s+jurisdiction_contacts/i, rows: [{ geoid: "0644000" }] },
    ])
    const thread = c.mailRepo.seedThread({
      threadToken: TOKEN,
      jurisdictionGeoid: "0644000",
      status: "sent",
    })
    c.mailRepo.seedMessage({
      threadId: thread.id,
      direction: "out",
      toAddr: "clerk@lacity.gov",
      messageId: "<out-77@civfix.org>",
    })

    const key = `${INBOUND_PENDING_PREFIX}notowned.eml`
    const dsn = rfc822({
      from: "mailer-daemon@lacity.gov",
      to: "outreach@civfix.org",
      messageId: "<dsn-notowned@lacity.gov>",
      body: [
        "Your message could not be delivered.",
        "Final-Recipient: rfc822; someone-else@other.gov",
        "Original-Message-ID: <out-77@civfix.org>",
      ].join("\n"),
    })
    await c.storage.put(key, dsn)

    const r = await processInboundObject(c.container, key, c.deps)
    expect(r.outcome).toBe("inbox")
    expect(c.inboundRepo.rows).toHaveLength(1)
    expect(c.mailRepo.events.some((e) => e.type === "bounced")).toBe(false)
    expect((await c.mailRepo.getThreadRecord(thread.id))?.status).not.toBe("bounced")
    expect(
      c.db.statements.some((s) => /UPDATE\s+jurisdiction_contacts\s+SET\s+bounced_at/i.test(s.sql)),
    ).toBe(false)
    expect(c.jobs.jobsFor("jurisdiction.discovery")).toHaveLength(0)
  })
})
