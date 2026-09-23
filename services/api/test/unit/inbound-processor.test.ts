import { describe, expect, it } from "vitest"
import { FakeInboundMail, FakeJobs, FakeStorage } from "@civfix/shared/fakes"
import type { InboundMail } from "@civfix/shared/interfaces"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { InMemoryInboundRepository } from "../../src/services/admin/inbound-repository.memory.js"
import { InMemoryAdminReportRepository } from "../../src/services/admin/admin-report-repository.memory.js"
import { RecordingNotifier } from "../helpers/notifications.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"
import {
  processInboundObject,
  resolveMessageId,
  detectBounce,
  INBOUND_PENDING_PREFIX,
  type InboundProcessorDeps,
} from "../../src/services/admin/inbound-processor.js"
import type { Container } from "../../src/di.js"
import { makeFakeSql, type FakeSqlControl, type SqlHandler } from "../helpers/fake-sql.js"
import {
  parseMessageIdList,
  cityReplyChatBody,
  stripQuotedHistory,
  JURISDICTION_REPLY_NOTE,
  JURISDICTION_REPLY_NOTIFICATION_BODY,
  MESSAGE_ID_LIST_CAP,
} from "../../src/services/admin/inbound-thread-correlation.js"
import { MESSAGE_BODY_MAX } from "@civfix/shared"
import type { ReportTimelineEvent } from "../../src/services/report-timeline-event.js"
import { CfInboundMail } from "../../src/adapters/inbound-mail.cf.js"


const TOKEN = "0123456789abcdef01234567"

function rfc822(opts: {
  from: string
  to: string
  body?: string
  messageId?: string
  inReplyTo?: string
  headers?: Record<string, string>
  authenticated?: boolean
}): Buffer {
  const lines = [`From: ${opts.from}`, `To: ${opts.to}`]
  if (opts.messageId !== undefined) lines.push(`Message-ID: ${opts.messageId}`)
  if (opts.inReplyTo !== undefined) lines.push(`In-Reply-To: ${opts.inReplyTo}`)
  const headers = opts.headers ?? {}
  if (opts.authenticated !== false && headers["Authentication-Results"] === undefined) {
    lines.push(`Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=${domainOf(opts.from)}`)
  }
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`)
  lines.push("", opts.body ?? "")
  return Buffer.from(lines.join("\n"), "utf8")
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1)
}

function htmlOnlyParser(opts: { from: string; to: string; html: string }): InboundMail {
  const real = new FakeInboundMail()
  return {
    async parse(raw: Uint8Array) {
      const mail = await real.parse(raw)
      return { ...mail, text: null, html: opts.html }
    },
    extractThreadToken: (mail) => real.extractThreadToken(mail),
  }
}

function seedContact(c: Ctx, threadId: string, contact: string): void {
  c.mailRepo.seedMessage({ threadId, direction: "out", toAddr: contact })
}

interface Ctx {
  container: Container
  deps: InboundProcessorDeps
  storage: FakeStorage
  mailRepo: InMemoryMailRepository
  inboundRepo: InMemoryInboundRepository
  adminReportRepo: InMemoryAdminReportRepository
  cleanupRepo: InMemoryCleanupRepository
  notifier: RecordingNotifier
  jobs: FakeJobs
  db: FakeSqlControl
  chatEvents: ReportTimelineEvent[]
}

function ctx(inboundMail: InboundMail = new FakeInboundMail(), sqlHandlers: SqlHandler[] = []): Ctx {
  const storage = new FakeStorage()
  const mailRepo = new InMemoryMailRepository()
  const inboundRepo = new InMemoryInboundRepository()
  const adminReportRepo = new InMemoryAdminReportRepository()
  const cleanupRepo = new InMemoryCleanupRepository()
  const notifier = new RecordingNotifier()
  const jobs = new FakeJobs()
  const db = makeFakeSql(sqlHandlers)
  const chatEvents: ReportTimelineEvent[] = []
  const deps: InboundProcessorDeps = {
    storage,
    inboundMail,
    mailRepo,
    inboundRepo,
    adminReportRepo,
    cleanupRepo,
    notifications: notifier,
    chatEmitter: {
      emit: (event) => {
        chatEvents.push(event)
        return Promise.resolve()
      },
    },
  }
  const container = {
    env: {},
    storage,
    inboundStorage: storage,
    inboundMail,
    jobs,
    getDb: () => ({ sql: db.sql }),
  } as unknown as Container
  return {
    container,
    deps,
    storage,
    mailRepo,
    inboundRepo,
    adminReportRepo,
    cleanupRepo,
    notifier,
    jobs,
    db,
    chatEvents,
  }
}

async function put(c: Ctx, key: string, eml: Buffer): Promise<void> {
  await c.storage.put(key, eml)
}

describe("processInboundObject: routing", () => {
  it("routes a reply+{token} message into mail_threads and deletes the object", async () => {
    const c = ctx()
    c.mailRepo.seedThread({ threadToken: TOKEN })
    const key = `${INBOUND_PENDING_PREFIX}a.eml`
    await put(c, key, rfc822({ from: "c@city.gov", to: `reply+${TOKEN}@civfix.org`, body: "hi" }))
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
    c.mailRepo.seedThread({ threadToken: TOKEN })
    const eml = rfc822({
      from: "c@city.gov",
      to: `reply+${TOKEN}@civfix.org`,
      body: "x",
      messageId: "<m1@city.gov>",
    })
    const key = `${INBOUND_PENDING_PREFIX}c.eml`
    await put(c, key, eml)
    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("threaded")
    await put(c, key, eml)
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

describe("processInboundObject: jurisdiction reply -> report side-effects (#40)", () => {
  it("advances a published report to in_progress, writes a timeline row, notifies the reporter, flips thread -> replied", async () => {
    const reportId = "report-1"
    const reporterId = "user-1"
    const c = ctx()
    c.adminReportRepo.seedReport({
      id: reportId,
      status: "published",
      reporter: {
        id: reporterId,
        name: "Jane",
        handle: "jane",
        emailVerified: true,
        hasOauth: false,
        joinedAt: new Date("2025-01-01T00:00:00Z"),
      },
    })
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, reportId, status: "sent" })
    seedContact(c, thread.id, "publicworks@lacity.gov")

    const key = `${INBOUND_PENDING_PREFIX}reply.eml`
    await put(
      c,
      key,
      rfc822({
        from: "clerk@lacity.gov",
        to: `reply+${TOKEN}@civfix.org`,
        body: "We have scheduled a crew for next week.",
        messageId: "<reply-1@lacity.gov>",
      }),
    )

    const r = await processInboundObject(c.container, key, c.deps)
    expect(r.outcome).toBe("threaded")

    expect(c.mailRepo.messagesOf(thread.id).filter((m) => m.direction === "in")).toHaveLength(1)
    expect((await c.mailRepo.getThreadRecord(thread.id))?.status).toBe("replied")

    expect(c.adminReportRepo.reports.get(reportId)?.record.status).toBe("in_progress")
    expect(
      (c.adminReportRepo.timeline.get(reportId) ?? []).some(
        (t) => t.note === JURISDICTION_REPLY_NOTE,
      ),
    ).toBe(true)
    expect(
      c.notifier.sent.some((n) => n.userId === reporterId && n.link === `/reports/${reportId}`),
    ).toBe(true)
  })

  it("records a system 'reply' timeline row WITHOUT a status change for an already-resolved report", async () => {
    const reportId = "report-2"
    const c = ctx()
    c.adminReportRepo.seedReport({ id: reportId, status: "resolved", reporter: null })
    const thread2 = c.mailRepo.seedThread({ threadToken: TOKEN, reportId, status: "sent" })
    seedContact(c, thread2.id, "publicworks@lacity.gov")

    const key = `${INBOUND_PENDING_PREFIX}reply2.eml`
    await put(c, key, rfc822({ from: "clerk@lacity.gov", to: `reply+${TOKEN}@civfix.org`, body: "Done." }))
    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("threaded")

    expect(c.adminReportRepo.reports.get(reportId)?.record.status).toBe("resolved")
    expect(
      (c.adminReportRepo.timeline.get(reportId) ?? []).some(
        (t) => t.note === JURISDICTION_REPLY_NOTE,
      ),
    ).toBe(true)
    expect(c.notifier.sent).toHaveLength(0)
  })

  it("a side-effect failure (report repo throws) never breaks routing / the delete", async () => {
    const c = ctx()
    c.adminReportRepo.getReport = () => Promise.reject(new Error("db down"))
    const thread3 = c.mailRepo.seedThread({ threadToken: TOKEN, reportId: "report-x", status: "sent" })
    seedContact(c, thread3.id, "publicworks@lacity.gov")
    const key = `${INBOUND_PENDING_PREFIX}reply3.eml`
    await put(c, key, rfc822({ from: "clerk@lacity.gov", to: `reply+${TOKEN}@civfix.org`, body: "hi" }))
    const r = await processInboundObject(c.container, key, c.deps)
    expect(r.outcome).toBe("threaded")
    expect(c.storage.get(key)).toBeNull()
  })

  it("publishes the city's reply text into the report chat while the timeline and push stay body-less", async () => {
    const reportId = "report-full"
    const reporterId = "user-full"
    const c = ctx()
    c.adminReportRepo.seedReport({
      id: reportId,
      status: "published",
      reporter: {
        id: reporterId,
        name: "Jane",
        handle: "jane",
        emailVerified: true,
        hasOauth: false,
        joinedAt: new Date("2025-01-01T00:00:00Z"),
      },
    })
    const threadFull = c.mailRepo.seedThread({ threadToken: TOKEN, reportId, status: "sent" })
    seedContact(c, threadFull.id, "publicworks@lacity.gov")
    const calls: { kind?: string; body?: string | null; note: string }[] = []
    const orig = c.adminReportRepo.setStatus.bind(c.adminReportRepo)
    c.adminReportRepo.setStatus = (id, input) => {
      calls.push({ kind: input.kind, body: input.body, note: input.note })
      return orig(id, input)
    }
    const reply = "A crew is scheduled for Tuesday."
    const key = `${INBOUND_PENDING_PREFIX}reply-full.eml`
    await put(c, key, rfc822({ from: "clerk@lacity.gov", to: `reply+${TOKEN}@civfix.org`, body: reply }))
    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("threaded")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.kind).toBe("reply")
    expect(calls[0]?.body).toBeNull()
    expect(calls[0]?.note).toBe(JURISDICTION_REPLY_NOTE)
    expect(calls[0]?.note).not.toContain("Tuesday")

    expect(c.adminReportRepo.reports.get(reportId)?.record.status).toBe("in_progress")
    const timeline = c.adminReportRepo.timeline.get(reportId) ?? []
    expect(timeline).toHaveLength(1)
    expect(JSON.stringify(timeline)).not.toContain("Tuesday")

    expect(c.chatEvents).toHaveLength(1)
    expect(c.chatEvents[0]).toMatchObject({
      reportId,
      kind: "reply",
      note: JURISDICTION_REPLY_NOTE,
      body: reply,
      status: "in_progress",
    })

    const bell = c.notifier.sent.find((n) => n.userId === reporterId)
    expect(bell).toBeDefined()
    expect(bell?.body).toBe(JURISDICTION_REPLY_NOTIFICATION_BODY)
    expect(JSON.stringify(bell)).not.toContain("Tuesday")

    expect(c.mailRepo.messagesOf(threadFull.id).some((m) => m.body === reply)).toBe(true)
  })

  it("drops the quoted history from the chat body and falls back to note-only when nothing is left", async () => {
    const reportId = "report-quoted"
    const c = ctx()
    c.adminReportRepo.seedReport({ id: reportId, status: "published", reporter: null })
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, reportId, status: "sent" })
    seedContact(c, thread.id, "publicworks@lacity.gov")

    const key = `${INBOUND_PENDING_PREFIX}reply-quoted.eml`
    await put(
      c,
      key,
      rfc822({
        from: "clerk@lacity.gov",
        to: `reply+${TOKEN}@civfix.org`,
        body: [
          "Ticket 4821 is open.",
          "",
          "On Mon, Sep 21, 2026 at 9:02 AM civfix Reports <report-x@civfix.org> wrote:",
          "> A resident reported a graffiti issue.",
          "> civfix reference ABC123",
        ].join("\n"),
      }),
    )
    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("threaded")

    expect(c.chatEvents).toHaveLength(1)
    expect(c.chatEvents[0]?.body).toBe("Ticket 4821 is open.")
    expect(c.chatEvents[0]?.body).not.toContain("civfix reference ABC123")
  })

  it("H6: an HTML-only city reply lands on the thread as TEXT and reaches the chat as text", async () => {
    const reportId = "report-html"
    const html = "<p>Crew dispatched to 42 Elm St</p>"
    const c = ctx(
      htmlOnlyParser({ from: "clerk@lacity.gov", to: `reply+${TOKEN}@civfix.org`, html }),
    )
    c.adminReportRepo.seedReport({ id: reportId, status: "published", reporter: null })
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, reportId, status: "sent" })
    seedContact(c, thread.id, "publicworks@lacity.gov")
    const calls: { kind?: string; body?: string | null; note: string }[] = []
    const orig = c.adminReportRepo.setStatus.bind(c.adminReportRepo)
    c.adminReportRepo.setStatus = (id, input) => {
      calls.push({ kind: input.kind, body: input.body, note: input.note })
      return orig(id, input)
    }

    const key = `${INBOUND_PENDING_PREFIX}reply-html.eml`
    await put(
      c,
      key,
      rfc822({ from: "clerk@lacity.gov", to: `reply+${TOKEN}@civfix.org`, body: "ignored" }),
    )
    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("threaded")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toBeNull()
    expect(calls[0]?.note).toBe(JURISDICTION_REPLY_NOTE)
    const timeline = c.adminReportRepo.timeline.get(reportId) ?? []
    expect(timeline).toHaveLength(1)
    expect(JSON.stringify(timeline)).not.toContain("Elm St")

    const stored = c.mailRepo.messagesOf(thread.id).find((m) => m.direction === "in")
    expect(stored?.body).toContain("Crew dispatched to 42 Elm St")
    expect(stored?.body).not.toContain("<p>")

    expect(c.chatEvents).toHaveLength(1)
    expect(c.chatEvents[0]?.body).toContain("Crew dispatched to 42 Elm St")
    expect(c.chatEvents[0]?.body).not.toContain("<p>")
  })
})

describe("cityReplyChatBody (what a city reply publishes into the report chat)", () => {
  it("keeps the city's own text, trimmed", () => {
    expect(cityReplyChatBody("  A crew is scheduled.  \n")).toBe("A crew is scheduled.")
  })

  it("drops everything from the first attribution line onward", () => {
    const body = [
      "Ticket 4821 is open.",
      "Thanks,",
      "Clerk",
      "",
      "On Mon, Sep 21, 2026 at 9:02 AM civfix <report-x@civfix.org> wrote:",
      "> A resident reported a graffiti issue.",
    ].join("\n")
    expect(cityReplyChatBody(body)).toBe("Ticket 4821 is open.\nThanks,\nClerk")
  })

  it("drops a trailing run of quoted lines with no attribution line", () => {
    expect(cityReplyChatBody("Open.\n\n> prior mail\n> more prior mail\n")).toBe("Open.")
  })

  it("keeps a quote that is not trailing", () => {
    expect(cityReplyChatBody("> their words\nOur answer.")).toBe("> their words\nOur answer.")
  })

  it("returns null for an empty, missing or fully-quoted body", () => {
    expect(cityReplyChatBody(null)).toBeNull()
    expect(cityReplyChatBody("")).toBeNull()
    expect(cityReplyChatBody("   \n\n ")).toBeNull()
    expect(cityReplyChatBody("> nothing but quoted history")).toBeNull()
    expect(cityReplyChatBody("On Mon, Sep 21, 2026 at 9:02 AM civfix wrote:\n> quoted")).toBeNull()
  })

  it("clips to MESSAGE_BODY_MAX so the chat validator accepts it", () => {
    const out = cityReplyChatBody("x".repeat(MESSAGE_BODY_MAX + 500))
    expect(out).toHaveLength(MESSAGE_BODY_MAX)
  })

  it("normalizes CRLF before looking for the quoted history", () => {
    expect(stripQuotedHistory("Open.\r\n\r\nOn Mon wrote:\r\n> old")).toBe("Open.")
  })

  it("keeps prose that merely contains 'wrote:' mid-sentence", () => {
    const body = "On Tuesday our crew wrote: the curb is clear now.\nTicket closed."
    expect(cityReplyChatBody(body)).toBe(body)
  })

  it("keeps a line ending in 'wrote:' that is not an attribution only when it is not one", () => {
    expect(cityReplyChatBody("Our inspector wrote: see attached.")).toBe(
      "Our inspector wrote: see attached.",
    )
  })

  it("drops everything from an Outlook -----Original Message----- separator onward", () => {
    const body = [
      "Work order raised.",
      "",
      "-----Original Message-----",
      "From: civfix <report-x@civfix.org>",
      "Sent: Monday, September 21, 2026 9:02 AM",
      "A resident reported a graffiti issue.",
    ].join("\n")
    expect(cityReplyChatBody(body)).toBe("Work order raised.")
  })

  it("tolerates a different dash count on the Outlook separator", () => {
    expect(cityReplyChatBody("Noted.\n\n--Original Message--\nold text")).toBe("Noted.")
  })

  it("drops an unquoted Outlook header block (From: followed by Sent:/Date:/To:)", () => {
    for (const follow of ["Sent: Monday", "Date: Mon, 21 Sep 2026", "To: ops@lacity.gov"]) {
      const body = ["Crew assigned.", "", "From: civfix <report-x@civfix.org>", follow, "old body"].join(
        "\n",
      )
      expect(cityReplyChatBody(body)).toBe("Crew assigned.")
    }
  })

  it("treats a From: header as a cut point when the follow header is two lines below", () => {
    const body = ["Done.", "", "From: civfix <x@civfix.org>", "", "Sent: Monday", "old"].join("\n")
    expect(cityReplyChatBody(body)).toBe("Done.")
  })

  it("keeps a reply that OPENS with a From:/To: header block, never returning an empty body", () => {
    const body = [
      "From: Public Works Ticketing",
      "To: reports@civfix.org",
      "Your request has been assigned to crew 12.",
    ].join("\n")
    const out = cityReplyChatBody(body)
    expect(out).not.toBeNull()
    expect(out).toContain("Your request has been assigned to crew 12.")
  })

  it("keeps a header block that only blank or quoted lines precede", () => {
    const body = ["", "> earlier", "From: Public Works", "Sent: Monday", "Crew 12 assigned."].join(
      "\n",
    )
    const out = cityReplyChatBody(body)
    expect(out).not.toBeNull()
    expect(out).toContain("Crew 12 assigned.")
  })

  it("still cuts a From: header block that real reply text precedes", () => {
    const body = ["Crew 12 assigned.", "", "From: civfix <x@civfix.org>", "Sent: Monday", "old"].join(
      "\n",
    )
    expect(cityReplyChatBody(body)).toBe("Crew 12 assigned.")
  })

  it("keeps a bare From: line that no Sent/Date/To header follows", () => {
    const body = "From: the front desk\nWe will send someone tomorrow."
    expect(cityReplyChatBody(body)).toBe(body)
  })

  it("keeps a From: line whose follow header is more than two lines below", () => {
    const body = ["From: the desk", "", "", "To: whoever"].join("\n")
    expect(cityReplyChatBody(body)).toBe(body)
  })

  it("ignores a QUOTED Outlook header block, which the trailing-quote sweep already removes", () => {
    expect(cityReplyChatBody("Open.\n\n> From: civfix\n> Sent: Monday")).toBe("Open.")
  })

  it("cuts at the EARLIEST cut point when a reply carries more than one", () => {
    const body = [
      "Closed.",
      "",
      "-----Original Message-----",
      "On Mon, Sep 21, 2026 at 9:02 AM civfix wrote:",
      "> old",
    ].join("\n")
    expect(cityReplyChatBody(body)).toBe("Closed.")
  })

  it("clips on a grapheme boundary so the cut cannot split a surrogate pair", () => {
    const out = cityReplyChatBody("\u{1F600}".repeat(MESSAGE_BODY_MAX))
    expect(out).not.toBeNull()
    expect(out!.length).toBeLessThanOrEqual(MESSAGE_BODY_MAX)
    expect(out).toBe("\u{1F600}".repeat(MESSAGE_BODY_MAX / 2))
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it("clips a body whose cut lands mid-emoji without emitting a lone surrogate", () => {
    const out = cityReplyChatBody(`${"x".repeat(MESSAGE_BODY_MAX - 1)}\u{1F600}x`)
    expect(out).toBe("x".repeat(MESSAGE_BODY_MAX - 1))
  })
})

describe("processInboundObject: unaffiliated thread joiners (H5)", () => {
  it("stores a vendor-domain reply echoing a valid In-Reply-To as UNAFFILIATED, with no side effects", async () => {
    const reportId = "report-vendor"
    const c = ctx()
    c.adminReportRepo.seedReport({ id: reportId, status: "published", reporter: null })
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, reportId, status: "sent" })
    c.mailRepo.seedMessage({
      threadId: thread.id,
      direction: "out",
      toAddr: "publicworks@lacity.gov",
      messageId: "<out-77@civfix.org>",
    })

    const key = `${INBOUND_PENDING_PREFIX}vendor.eml`
    await put(
      c,
      key,
      rfc822({
        from: "sales@vendor.example",
        to: "outreach@civfix.org",
        body: "Please send the resident's full details.",
        inReplyTo: "<out-77@civfix.org>",
      }),
    )

    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("threaded")

    const stored = c.mailRepo.messagesOf(thread.id).filter((m) => m.direction === "in")
    expect(stored).toHaveLength(1)
    expect(stored[0]?.unaffiliated).toBe(true)
    expect(stored[0]?.effectsAppliedAt).toBeNull()

    expect(c.adminReportRepo.reports.get(reportId)?.record.status).toBe("published")
    expect(c.adminReportRepo.timeline.get(reportId) ?? []).toHaveLength(0)
    expect((await c.mailRepo.getThreadRecord(thread.id))?.status).not.toBe("replied")

    expect(await c.mailRepo.getLastOutboundRecipient(thread.id)).toBe("publicworks@lacity.gov")
  })

  it("marks a reply from the jurisdiction contact as AFFILIATED and applies its effects once", async () => {
    const reportId = "report-affiliated"
    const c = ctx()
    c.adminReportRepo.seedReport({ id: reportId, status: "published", reporter: null })
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, reportId, status: "sent" })
    seedContact(c, thread.id, "publicworks@lacity.gov")

    const key = `${INBOUND_PENDING_PREFIX}affiliated.eml`
    await put(
      c,
      key,
      rfc822({ from: "clerk@lacity.gov", to: `reply+${TOKEN}@civfix.org`, body: "On it." }),
    )
    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("threaded")

    const stored = c.mailRepo.messagesOf(thread.id).find((m) => m.direction === "in")
    expect(stored?.unaffiliated).toBe(false)
    expect(stored?.effectsAppliedAt).not.toBeNull()
    expect(c.adminReportRepo.reports.get(reportId)?.record.status).toBe("in_progress")
  })
})

describe("processInboundObject: EVENT reply -> cleanup_timeline (D13/D19)", () => {
  it("writes a 'city_reply' cleanup_timeline row (actor null, full body) for a reply from the event's jurisdiction contact", async () => {
    const cleanupId = "cleanup-evt-1"
    const c = ctx()
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, cleanupId, status: "sent" })
    seedContact(c, thread.id, "events@lacity.gov")
    const fullBody = "Yes, we can supply 20 bags and gloves; pick them up at the depot Friday morning."
    const key = `${INBOUND_PENDING_PREFIX}evt-reply.eml`
    await put(c, key, rfc822({ from: "events@lacity.gov", to: `reply+${TOKEN}@civfix.org`, body: fullBody }))

    const r = await processInboundObject(c.container, key, c.deps)
    expect(r.outcome).toBe("threaded")
    expect((await c.mailRepo.getThreadRecord(thread.id))?.status).toBe("replied")

    const row = c.cleanupRepo.timeline.find((t) => t.cleanupId === cleanupId && t.kind === "city_reply")
    expect(row).toBeDefined()
    expect(row?.actorId).toBeNull()
    expect(row?.note).toBe(fullBody)
  })

  it("FILES a DMARC-passing reply with NO city_reply row when the thread has no known contact (fail closed)", async () => {
    const cleanupId = "cleanup-evt-2"
    const c = ctx()
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, cleanupId, status: "sent" })
    const key = `${INBOUND_PENDING_PREFIX}evt-reply-unknown.eml`
    await put(
      c,
      key,
      rfc822({
        from: "events@lacity.gov",
        to: `reply+${TOKEN}@civfix.org`,
        body: "We can supply 20 bags and gloves.",
      }),
    )

    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("threaded")
    expect(c.mailRepo.messagesOf(thread.id).filter((m) => m.direction === "in")).toHaveLength(1)
    expect(c.cleanupRepo.timeline.filter((t) => t.kind === "city_reply")).toHaveLength(0)
    expect((await c.mailRepo.getThreadRecord(thread.id))?.status).not.toBe("replied")
  })

  it("FILES a DMARC-passing reply with NO city_reply row when From is not the event's jurisdiction contact", async () => {
    const cleanupId = "cleanup-evt-3"
    const c = ctx()
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, cleanupId, status: "sent" })
    seedContact(c, thread.id, "events@lacity.gov")
    const key = `${INBOUND_PENDING_PREFIX}evt-reply-forged.eml`
    await put(
      c,
      key,
      rfc822({
        from: "attacker@evil.example",
        to: `reply+${TOKEN}@civfix.org`,
        body: "The city has cancelled your cleanup; meet us here instead.",
      }),
    )

    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("threaded")
    expect(c.mailRepo.messagesOf(thread.id).filter((m) => m.direction === "in")).toHaveLength(1)
    expect(c.cleanupRepo.timeline.filter((t) => t.kind === "city_reply")).toHaveLength(0)
    expect((await c.mailRepo.getThreadRecord(thread.id))?.status).not.toBe("replied")
  })

  it("writes the city_reply row for a SUBDOMAIN of the event's jurisdiction contact (relaxed alignment)", async () => {
    const cleanupId = "cleanup-evt-4"
    const c = ctx()
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, cleanupId, status: "sent" })
    seedContact(c, thread.id, "events@lacity.gov")
    const fullBody = "Depot pickup confirmed for Friday."
    const key = `${INBOUND_PENDING_PREFIX}evt-reply-subdomain.eml`
    await put(
      c,
      key,
      rfc822({ from: "crew@mail.lacity.gov", to: `reply+${TOKEN}@civfix.org`, body: fullBody }),
    )

    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("threaded")
    const row = c.cleanupRepo.timeline.find((t) => t.cleanupId === cleanupId && t.kind === "city_reply")
    expect(row?.note).toBe(fullBody)
    expect(row?.actorId).toBeNull()
    expect((await c.mailRepo.getThreadRecord(thread.id))?.status).toBe("replied")
  })
})

describe("processInboundObject: self-originated mail (loop guard)", () => {
  it("drops our own outbound mail looping back instead of threading or inboxing it", async () => {
    const c = ctx()
    Object.assign(c.container, {
      env: { MAIL_FROM_OUTREACH: "outreach@civfix.org", MAIL_REPLY_DOMAIN: "civfix.org" },
    })
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, reportId: "loop", status: "sent" })
    c.mailRepo.seedMessage({ threadId: thread.id, direction: "out", messageId: "<out-1@civfix.org>" })
    const copies = [
      rfc822({
        from: "outreach@civfix.org",
        to: "contact@civfix.org",
        messageId: "<out-2@civfix.org>",
        inReplyTo: "<out-1@civfix.org>",
      }),
      rfc822({ from: `report-${TOKEN}@civfix.org`, to: `report-${TOKEN}@civfix.org` }),
    ]
    for (const [i, eml] of copies.entries()) {
      const key = `${INBOUND_PENDING_PREFIX}loop-${i}.eml`
      await put(c, key, eml)
      expect(await processInboundObject(c.container, key, c.deps)).toEqual({
        outcome: "skipped",
        reason: "self-originated",
      })
      expect(c.storage.get(key)).toBeNull()
    }
    expect(c.mailRepo.messagesOf(thread.id).filter((m) => m.direction === "in")).toHaveLength(0)
    expect(c.inboundRepo.rows).toHaveLength(0)
  })
})

describe("processInboundObject: In-Reply-To fallback (#40)", () => {
  it("correlates a NO-token reply to its thread via In-Reply-To matching an OUT message_id", async () => {
    const c = ctx()
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, status: "sent" })
    c.mailRepo.seedMessage({
      threadId: thread.id,
      direction: "out",
      messageId: "<out-42@civfix.org>",
    })

    const key = `${INBOUND_PENDING_PREFIX}fallback.eml`
    await put(
      c,
      key,
      rfc822({
        from: "clerk@lacity.gov",
        to: "outreach@civfix.org",
        body: "Re: your message",
        inReplyTo: "<out-42@civfix.org>",
      }),
    )
    const r = await processInboundObject(c.container, key, c.deps)
    expect(r.outcome).toBe("threaded")
    expect(c.inboundRepo.rows).toHaveLength(0)
    expect(c.mailRepo.messagesOf(thread.id).some((m) => m.direction === "in")).toBe(true)
  })

  it("falls through to the Inbox when neither a token NOR an In-Reply-To correlates", async () => {
    const c = ctx()
    c.mailRepo.seedThread({ threadToken: TOKEN, status: "sent" })
    const key = `${INBOUND_PENDING_PREFIX}nomatch.eml`
    await put(
      c,
      key,
      rfc822({
        from: "clerk@lacity.gov",
        to: "outreach@civfix.org",
        body: "hello",
        inReplyTo: "<unknown@elsewhere>",
      }),
    )
    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("inbox")
    expect(c.inboundRepo.rows).toHaveLength(1)
  })
})

describe("processInboundObject: DSN/bounce handling (#40)", () => {
  it("flags the contact (bounced_at), records a 'bounced' event, flips the thread, and STILL files the bounce in the Inbox", async () => {
    const failed = "clerk@lacity.gov"
    const geoid = "0644000"
    const c = ctx(new FakeInboundMail(), [
      { match: /UPDATE\s+jurisdiction_contacts\s+SET\s+bounced_at/i, rows: [] },
      { match: /FROM\s+mail_messages/i, rows: [{ ok: true }] },
      { match: /SELECT\s+geoid\s+FROM\s+jurisdiction_contacts/i, rows: [{ geoid }] },
    ])
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, jurisdictionGeoid: geoid, status: "sent" })
    c.mailRepo.seedMessage({
      threadId: thread.id,
      direction: "out",
      messageId: "<out-99@civfix.org>",
    })

    const key = `${INBOUND_PENDING_PREFIX}bounce.eml`
    const dsn = rfc822({
      from: "mailer-daemon@lacity.gov",
      to: "outreach@civfix.org",
      messageId: "<dsn-bounce-1@lacity.gov>",
      headers: { "X-Failed-Recipients": failed },
      body: ["Your message could not be delivered.", `Original-Message-ID: <out-99@civfix.org>`].join("\n"),
    })
    await put(c, key, dsn)

    const r = await processInboundObject(c.container, key, c.deps)
    expect(r.outcome).toBe("inbox")
    expect(c.inboundRepo.rows).toHaveLength(1)
    expect(c.storage.get(key)).toBeNull()

    expect(c.mailRepo.events.some((e) => e.type === "bounced")).toBe(true)
    expect((await c.mailRepo.getThreadRecord(thread.id))?.status).toBe("bounced")

    const flag = c.db.statements.find((s) => /UPDATE\s+jurisdiction_contacts\s+SET\s+bounced_at/i.test(s.sql))
    expect(flag).toBeDefined()
    expect(flag?.values).toContain(failed)

    const enq = c.jobs.jobsFor("jurisdiction.discovery")
    expect(enq).toHaveLength(1)
    expect(enq[0]?.data).toMatchObject({ geoid })

    const key2 = `${INBOUND_PENDING_PREFIX}bounce-redeliver.eml`
    await put(c, key2, dsn)
    const r2 = await processInboundObject(c.container, key2, c.deps)
    expect(r2.outcome).toBe("replay")
    expect(c.mailRepo.events.filter((e) => e.type === "bounced")).toHaveLength(1)
    expect(
      c.db.statements.filter((s) => /UPDATE\s+jurisdiction_contacts\s+SET\s+bounced_at/i.test(s.sql)),
    ).toHaveLength(1)
    expect(c.jobs.jobsFor("jurisdiction.discovery")).toHaveLength(1)
  })

  it("does NOT mutate directory state for a spoofed DSN with no correlated outbound thread", async () => {
    const c = ctx(new FakeInboundMail(), [
      { match: /UPDATE\s+jurisdiction_contacts\s+SET\s+bounced_at/i, rows: [] },
      { match: /FROM\s+mail_messages/i, rows: [{ ok: true }] },
      { match: /SELECT\s+geoid\s+FROM\s+jurisdiction_contacts/i, rows: [{ geoid: "0644000" }] },
    ])
    const key = `${INBOUND_PENDING_PREFIX}spoof.eml`
    const dsn = rfc822({
      from: "mailer-daemon@evil.example",
      to: "outreach@civfix.org",
      messageId: "<spoof-1@evil.example>",
      headers: { "X-Failed-Recipients": "publicworks@city.gov" },
      body: "Original-Message-ID: <out-never-sent@civfix.org>",
    })
    await put(c, key, dsn)

    const r = await processInboundObject(c.container, key, c.deps)
    expect(r.outcome).toBe("inbox")
    expect(c.inboundRepo.rows).toHaveLength(1)
    expect(c.mailRepo.events.some((e) => e.type === "bounced")).toBe(false)
    expect(
      c.db.statements.some((s) => /UPDATE\s+jurisdiction_contacts\s+SET\s+bounced_at/i.test(s.sql)),
    ).toBe(false)
    expect(c.jobs.jobsFor("jurisdiction.discovery")).toHaveLength(0)
  })
})

describe("detectBounce (pure)", () => {
  it("flags a mailer-daemon From + recovers the failed recipient + original Message-ID", async () => {
    const parser = new FakeInboundMail()
    const mail = await parser.parse(
      rfc822({
        from: "mailer-daemon@lacity.gov",
        to: "outreach@civfix.org",
        headers: { "X-Failed-Recipients": "clerk@lacity.gov" },
        body: "Original-Message-ID: <out-7@civfix.org>",
      }),
    )
    const b = detectBounce(mail)
    expect(b.isBounce).toBe(true)
    expect(b.failedRecipient).toBe("clerk@lacity.gov")
    expect(b.originalMessageId).toBe("<out-7@civfix.org>")
  })

  it("is NOT a bounce for an ordinary inbound message", async () => {
    const parser = new FakeInboundMail()
    const mail = await parser.parse(rfc822({ from: "clerk@lacity.gov", to: "outreach@civfix.org", body: "hi" }))
    expect(detectBounce(mail).isBounce).toBe(false)
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

describe("parseMessageIdList", () => {
  it("caps an oversized References header to MESSAGE_ID_LIST_CAP ids", () => {
    const header = Array.from({ length: 100 }, (_, i) => `<id-${i}@host>`).join(" ")
    const ids = parseMessageIdList(header)
    expect(ids).toHaveLength(MESSAGE_ID_LIST_CAP)
    expect(ids[0]).toBe("<id-0@host>")
  })

  it("returns all ids when under the cap", () => {
    expect(parseMessageIdList("<a@x> <b@y>")).toEqual(["<a@x>", "<b@y>"])
  })

  it("caps the bare @-token fallback too", () => {
    const header = Array.from({ length: 50 }, (_, i) => `id${i}@host`).join(" ")
    expect(parseMessageIdList(header)).toHaveLength(MESSAGE_ID_LIST_CAP)
  })
})

describe("processInboundObject: message authentication gate (M7)", () => {
  it("files an UNAUTHENTICATED token-addressed reply on its thread as UNAFFILIATED, with no public effects", async () => {
    const c = ctx()
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, reportId: "report-auth", status: "sent" })
    seedContact(c, thread.id, "publicworks@lacity.gov")
    c.adminReportRepo.seedReport({ id: "report-auth", status: "published", reporter: null })

    const key = `${INBOUND_PENDING_PREFIX}forged.eml`
    await put(
      c,
      key,
      rfc822({
        from: "clerk@lacity.gov",
        to: `reply+${TOKEN}@civfix.org`,
        body: "Crew dispatched.",
        authenticated: false,
      }),
    )

    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("threaded")
    const stored = c.mailRepo.messagesOf(thread.id).filter((m) => m.direction === "in")
    expect(stored).toHaveLength(1)
    expect(stored[0]?.unaffiliated).toBe(true)
    expect(c.mailRepo.events.at(-1)?.meta).toMatchObject({ authVerdict: "unknown", unaffiliated: true })
    expect(c.inboundRepo.rows).toHaveLength(0)
    expect(c.adminReportRepo.reports.get("report-auth")?.record.status).toBe("published")
    expect(c.chatEvents).toHaveLength(0)
    expect(c.notifier.sent).toHaveLength(0)
  })

  it("files a DMARC-FAIL token-addressed reply as unaffiliated even when From matches the contact", async () => {
    const c = ctx()
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, reportId: "report-fail", status: "sent" })
    seedContact(c, thread.id, "publicworks@lacity.gov")
    c.adminReportRepo.seedReport({ id: "report-fail", status: "published", reporter: null })
    const key = `${INBOUND_PENDING_PREFIX}dmarcfail.eml`
    await put(
      c,
      key,
      rfc822({
        from: "clerk@lacity.gov",
        to: `reply+${TOKEN}@civfix.org`,
        body: "spoofed",
        headers: { "Authentication-Results": "mx.cloudflare.net; spf=pass; dmarc=fail header.from=lacity.gov" },
      }),
    )

    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("threaded")
    expect(c.mailRepo.messagesOf(thread.id).find((m) => m.direction === "in")?.unaffiliated).toBe(true)
    expect(c.mailRepo.events.at(-1)?.meta).toMatchObject({ authVerdict: "fail" })
    expect(c.adminReportRepo.reports.get("report-fail")?.record.status).toBe("published")
    expect(c.chatEvents).toHaveLength(0)
  })

  it("keeps an unauthenticated reply that only echoes an In-Reply-To in the Inbox", async () => {
    const c = ctx()
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, reportId: "report-ref", status: "sent" })
    c.mailRepo.seedMessage({ threadId: thread.id, direction: "out", messageId: "<out-9@civfix.org>" })
    const key = `${INBOUND_PENDING_PREFIX}refonly.eml`
    await put(
      c,
      key,
      rfc822({
        from: "clerk@lacity.gov",
        to: "outreach@civfix.org",
        inReplyTo: "<out-9@civfix.org>",
        authenticated: false,
      }),
    )

    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("inbox")
    expect(c.mailRepo.messagesOf(thread.id).filter((m) => m.direction === "in")).toHaveLength(0)
    expect(c.inboundRepo.rows[0]?.headers?.["x-civfix-auth-verdict"]).toBe("unknown")
  })

  it("threads a dmarc=none reply with an aligned DKIM pass and publishes it", async () => {
    const reportId = "report-nodmarc"
    const c = ctx()
    c.adminReportRepo.seedReport({ id: reportId, status: "published", reporter: null })
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, reportId, status: "sent" })
    seedContact(c, thread.id, "publicworks@lacity.gov")
    const key = `${INBOUND_PENDING_PREFIX}nodmarc.eml`
    await put(
      c,
      key,
      rfc822({
        from: "clerk@lacity.gov",
        to: `report-${TOKEN}@civfix.org`,
        body: "Crew scheduled for Tuesday.",
        headers: {
          "Authentication-Results":
            "mx.cloudflare.net; dkim=pass header.d=lacity.gov header.s=sig1; dmarc=none header.from=lacity.gov policy.dmarc=none",
        },
      }),
    )

    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("threaded")
    expect(c.mailRepo.messagesOf(thread.id).find((m) => m.direction === "in")?.unaffiliated).toBe(false)
    expect(c.adminReportRepo.reports.get(reportId)?.record.status).toBe("in_progress")
    expect(c.chatEvents.map((e) => e.body)).toEqual(["Crew scheduled for Tuesday."])
  })

  it("sends a token-addressed message with two From headers to the Inbox", async () => {
    const c = ctx(new CfInboundMail({ replyDomain: "civfix.org" }))
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, reportId: "report-twofrom", status: "sent" })
    seedContact(c, thread.id, "publicworks@lacity.gov")
    const key = `${INBOUND_PENDING_PREFIX}twofrom.eml`
    await put(
      c,
      key,
      rfc822({
        from: "x@attacker.example",
        to: `reply+${TOKEN}@civfix.org`,
        headers: {
          "Authentication-Results": "mx.cloudflare.net; dmarc=pass header.from=attacker.example",
          From: "clerk@lacity.gov",
        },
      }),
    )

    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("inbox")
    expect(c.mailRepo.messagesOf(thread.id).filter((m) => m.direction === "in")).toHaveLength(0)
  })

  it("a sender-supplied X-Civfix-Auth-Verdict header cannot forge the stored verdict", async () => {
    const c = ctx()
    const key = `${INBOUND_PENDING_PREFIX}fakeverdict.eml`
    await put(
      c,
      key,
      rfc822({
        from: "r@example.com",
        to: "support@civfix.org",
        body: "hi",
        authenticated: false,
        headers: { "X-Civfix-Auth-Verdict": "pass" },
      }),
    )

    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("inbox")
    expect(c.inboundRepo.rows[0]?.headers?.["x-civfix-auth-verdict"]).toBe("unknown")
  })

  it("threads a DMARC-passing reply but fires NO side effects when From is not the jurisdiction contact", async () => {
    const reportId = "report-wrongsender"
    const c = ctx()
    c.adminReportRepo.seedReport({ id: reportId, status: "published", reporter: null })
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, reportId, status: "sent" })
    seedContact(c, thread.id, "publicworks@lacity.gov")

    const key = `${INBOUND_PENDING_PREFIX}wrongsender.eml`
    await put(
      c,
      key,
      rfc822({
        from: "attacker@evil.example",
        to: `reply+${TOKEN}@civfix.org`,
        body: "Your report has been resolved, please send payment.",
      }),
    )

    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("threaded")
    expect(c.mailRepo.messagesOf(thread.id).filter((m) => m.direction === "in")).toHaveLength(1)
    expect(c.adminReportRepo.reports.get(reportId)?.record.status).toBe("published")
    expect(c.adminReportRepo.timeline.get(reportId) ?? []).toHaveLength(0)
    expect(c.notifier.sent).toHaveLength(0)
    expect((await c.mailRepo.getThreadRecord(thread.id))?.status).not.toBe("replied")
  })

  it("fires side effects for a subdomain of the jurisdiction contact (relaxed alignment)", async () => {
    const reportId = "report-subdomain"
    const c = ctx()
    c.adminReportRepo.seedReport({ id: reportId, status: "published", reporter: null })
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, reportId, status: "sent" })
    seedContact(c, thread.id, "publicworks@lacity.gov")

    const key = `${INBOUND_PENDING_PREFIX}subdomain.eml`
    await put(
      c,
      key,
      rfc822({ from: "crew@mail.lacity.gov", to: `reply+${TOKEN}@civfix.org`, body: "On it." }),
    )

    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("threaded")
    expect(c.adminReportRepo.reports.get(reportId)?.record.status).toBe("in_progress")
  })
})
