import { describe, expect, it } from "vitest"
import { FakeInboundMail, FakeJobs, FakeStorage } from "@civfix/shared/fakes"
import type { InboundMail } from "@civfix/shared/interfaces"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { InMemoryInboundRepository } from "../../src/services/admin/inbound-repository.memory.js"
import {
  processInboundObject,
  resolveMessageId,
  detectBounce,
  INBOUND_PENDING_PREFIX,
  type InboundProcessorDeps,
} from "../../src/services/admin/inbound-processor.js"
import type { Container } from "../../src/di.js"
import { makeFakeSql, type FakeSqlControl, type SqlHandler } from "../helpers/fake-sql.js"

/**
 * Unit tests for processInboundObject — the shared core of the webhook + sweep. Verifies routing
 * (reply -> mail_threads; no-token -> inbound_emails), idempotency on both paths, parse-failure parking,
 * the missing-object short-circuit, a consumed object's delete, AND the issue-#40 reply/bounce/fallback
 * side-effects (a jurisdiction reply advances the report + notifies the reporter; a no-token reply still
 * correlates by In-Reply-To; a DSN bounce flags the contact + records a 'bounced' event).
 */

/** A 24-hex thread token (the minted shape the real + fake inbound adapters now SHAPE-VALIDATE). */
const TOKEN = "0123456789abcdef01234567"

function rfc822(opts: {
  from: string
  to: string
  body?: string
  messageId?: string
  inReplyTo?: string
  headers?: Record<string, string>
}): Buffer {
  const lines = [`From: ${opts.from}`, `To: ${opts.to}`]
  if (opts.messageId !== undefined) lines.push(`Message-ID: ${opts.messageId}`)
  if (opts.inReplyTo !== undefined) lines.push(`In-Reply-To: ${opts.inReplyTo}`)
  for (const [k, v] of Object.entries(opts.headers ?? {})) lines.push(`${k}: ${v}`)
  lines.push("", opts.body ?? "")
  return Buffer.from(lines.join("\n"), "utf8")
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

/**
 * Build a test context. `sqlHandlers` script the raw-SQL repos the inbound side-effects reach through
 * `container.getDb().sql` (the admin report repo + the bounce contact UPDATE) — see test/helpers/fake-sql.
 * The container exposes `getDb()` + `jobs` (for the bounce discovery re-enqueue) on top of the seams the
 * routing tests already use.
 */
function ctx(inboundMail: InboundMail = new FakeInboundMail(), sqlHandlers: SqlHandler[] = []): Ctx {
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

async function put(c: Ctx, key: string, eml: Buffer): Promise<void> {
  await c.storage.put(key, eml)
}

/** A scripted report SELECT row for the admin report repo's getReport (status + reporter configurable). */
function reportRow(over: {
  id: string
  status: string
  reporterId?: string | null
}): Record<string, unknown> {
  return {
    id: over.id,
    category: "trash",
    status: over.status,
    flagged: false,
    title: "Pothole",
    place: "City of LA",
    address: "Main St",
    description: "desc",
    lat: 34,
    lng: -118,
    confirmations: "0",
    has_photo: false,
    created_at: new Date("2026-06-01T00:00:00Z"),
    reporter_id: over.reporterId ?? null,
    reporter_name: over.reporterId ? "Jane" : null,
    reporter_handle: over.reporterId ? "jane" : null,
    reporter_email_verified: true,
    reporter_has_oauth: false,
    reporter_joined: over.reporterId ? new Date("2025-01-01T00:00:00Z") : null,
  }
}

/** The handlers that satisfy the admin report repo's getReport / setStatus / notify / timeline + audits. */
function reportSqlHandlers(row: Record<string, unknown>): SqlHandler[] {
  return [
    // getReport's reportSelect: the only SELECT that reads FROM reports with an r.id predicate.
    { match: /FROM\s+reports\s+r[\s\S]*r\.id\s*=\s*\?/i, rows: [row] },
    // setStatus's UPDATE … RETURNING id (a non-empty result means the row was found + updated).
    { match: /UPDATE\s+reports\s+SET\s+status/i, rows: [{ id: row["id"] }] },
    // writeAudit's audit_log insert returns the new id.
    { match: /INSERT\s+INTO\s+audit_log/i, rows: [{ id: "audit-1" }] },
    // timeline + notification inserts return nothing.
    { match: /INSERT\s+INTO\s+report_timeline/i, rows: [] },
    { match: /INSERT\s+INTO\s+notifications/i, rows: [] },
  ]
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

describe("processInboundObject: jurisdiction reply -> report side-effects (#40)", () => {
  it("advances a published report to in_progress, writes a timeline row, notifies the reporter, flips thread -> replied", async () => {
    const reportId = "report-1"
    const reporterId = "user-1"
    const row = reportRow({ id: reportId, status: "published", reporterId })
    const c = ctx(new FakeInboundMail(), reportSqlHandlers(row))
    // A per-report outreach thread (report_id set) on a 24-hex token.
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, reportId, status: "sent" })

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

    // The reply was persisted on the thread, and the thread flipped to 'replied' (memory repo).
    expect(c.mailRepo.messages).toHaveLength(1)
    expect((await c.mailRepo.getThreadRecord(thread.id))?.status).toBe("replied")

    // The report was advanced to in_progress (setStatus UPDATE carried 'in_progress').
    const update = c.db.statements.find((s) => /UPDATE\s+reports\s+SET\s+status/i.test(s.sql))
    expect(update).toBeDefined()
    expect(update?.values).toContain("in_progress")
    // A timeline row was inserted carrying the reply preview note.
    const timeline = c.db.statements.find((s) => /INSERT\s+INTO\s+report_timeline/i.test(s.sql))
    expect(timeline).toBeDefined()
    expect(timeline?.values.some((v) => typeof v === "string" && v.includes("Jurisdiction replied"))).toBe(
      true,
    )
    // The reporter was notified (notifications insert bound to the reporter's user id + report link).
    const notify = c.db.statements.find((s) => /INSERT\s+INTO\s+notifications/i.test(s.sql))
    expect(notify).toBeDefined()
    expect(notify?.values).toContain(reporterId)
    expect(notify?.values).toContain(`/reports/${reportId}`)
  })

  it("records a system 'reply' timeline row WITHOUT a status change for an already-resolved report", async () => {
    const reportId = "report-2"
    const row = reportRow({ id: reportId, status: "resolved", reporterId: null })
    const c = ctx(new FakeInboundMail(), reportSqlHandlers(row))
    c.mailRepo.seedThread({ threadToken: TOKEN, reportId, status: "sent" })

    const key = `${INBOUND_PENDING_PREFIX}reply2.eml`
    await put(c, key, rfc822({ from: "clerk@lacity.gov", to: `reply+${TOKEN}@civfix.org`, body: "Done." }))
    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("threaded")

    // No reports UPDATE (resolved is past acknowledged) — only a system timeline INSERT … SELECT row.
    expect(c.db.statements.some((s) => /UPDATE\s+reports\s+SET\s+status/i.test(s.sql))).toBe(false)
    expect(c.db.statements.some((s) => /INSERT\s+INTO\s+report_timeline/i.test(s.sql))).toBe(true)
    // No reporter to notify (reporter_id null) -> no notifications insert.
    expect(c.db.statements.some((s) => /INSERT\s+INTO\s+notifications/i.test(s.sql))).toBe(false)
  })

  it("a side-effect failure (report repo throws) never breaks routing / the delete", async () => {
    // No SQL handlers + a getDb whose sql rejects: onJurisdictionReply throws internally and is swallowed.
    const c = ctx()
    c.container = {
      ...c.container,
      getDb: () => ({
        sql: () => Promise.reject(new Error("db down")),
      }),
    } as unknown as Container
    c.mailRepo.seedThread({ threadToken: TOKEN, reportId: "report-x", status: "sent" })
    const key = `${INBOUND_PENDING_PREFIX}reply3.eml`
    await put(c, key, rfc822({ from: "clerk@lacity.gov", to: `reply+${TOKEN}@civfix.org`, body: "hi" }))
    const r = await processInboundObject(c.container, key, c.deps)
    expect(r.outcome).toBe("threaded")
    expect(c.storage.get(key)).toBeNull() // the pending object was still consumed
  })
})

describe("processInboundObject: In-Reply-To fallback (#40)", () => {
  it("correlates a NO-token reply to its thread via In-Reply-To matching an OUT message_id", async () => {
    const c = ctx()
    // A per-report thread whose OUT message carries the RFC822 Message-ID we will reply to.
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, status: "sent" })
    c.mailRepo.seedMessage({
      threadId: thread.id,
      direction: "out",
      messageId: "<out-42@civfix.org>",
    })

    const key = `${INBOUND_PENDING_PREFIX}fallback.eml`
    // No reply+{token}@ recipient; only an In-Reply-To pointing at our OUT message.
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
    // The IN reply landed on the SAME thread (not the Inbox).
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
    // The bounce correlates to an OUT thread by the original Message-ID; the contact lookup yields a geoid.
    const c = ctx(new FakeInboundMail(), [
      { match: /UPDATE\s+jurisdiction_contacts\s+SET\s+bounced_at/i, rows: [] },
      { match: /SELECT\s+geoid\s+FROM\s+jurisdiction_contacts/i, rows: [{ geoid }] },
    ])
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, jurisdictionGeoid: geoid, status: "sent" })
    c.mailRepo.seedMessage({
      threadId: thread.id,
      direction: "out",
      messageId: "<out-99@civfix.org>",
    })

    const key = `${INBOUND_PENDING_PREFIX}bounce.eml`
    // A DSN: from a mailer-daemon, with an X-Failed-Recipients header + the original Message-ID in the body.
    // Its own Message-ID is fixed so a re-delivery (below) dedups to the same row.
    const dsn = rfc822({
      from: "mailer-daemon@lacity.gov",
      to: "outreach@civfix.org",
      messageId: "<dsn-bounce-1@lacity.gov>",
      headers: { "X-Failed-Recipients": failed },
      body: ["Your message could not be delivered.", `Original-Message-ID: <out-99@civfix.org>`].join("\n"),
    })
    await put(c, key, dsn)

    const r = await processInboundObject(c.container, key, c.deps)
    // The bounce is STILL filed in the Inbox for operator visibility.
    expect(r.outcome).toBe("inbox")
    expect(c.inboundRepo.rows).toHaveLength(1)
    expect(c.storage.get(key)).toBeNull()

    // A 'bounced' event was recorded on the correlated thread + the thread flipped to 'bounced'.
    expect(c.mailRepo.events.some((e) => e.type === "bounced")).toBe(true)
    expect((await c.mailRepo.getThreadRecord(thread.id))?.status).toBe("bounced")

    // The contact was flagged (UPDATE … bounced_at) bound to the failed recipient.
    const flag = c.db.statements.find((s) => /UPDATE\s+jurisdiction_contacts\s+SET\s+bounced_at/i.test(s.sql))
    expect(flag).toBeDefined()
    expect(flag?.values).toContain(failed)

    // Discovery was re-opened: the jurisdiction.discovery job was enqueued for the contact's geoid.
    const enq = c.jobs.jobsFor("jurisdiction.discovery")
    expect(enq).toHaveLength(1)
    expect(enq[0]?.data).toMatchObject({ geoid })

    // IDEMPOTENCY: a re-delivered DSN (same bytes -> same Message-ID, e.g. webhook+sweep race / MTA retry)
    // arriving under a fresh pending key must NOT double-fire the bounce side-effects. routeInbox dedups on
    // message_id ('replay'), and handleBounce runs ONLY when routeInbox actually inserted ('inbox').
    const key2 = `${INBOUND_PENDING_PREFIX}bounce-redeliver.eml`
    await put(c, key2, dsn)
    const r2 = await processInboundObject(c.container, key2, c.deps)
    expect(r2.outcome).toBe("replay")
    // No second 'bounced' event, no second contact UPDATE, no second discovery enqueue.
    expect(c.mailRepo.events.filter((e) => e.type === "bounced")).toHaveLength(1)
    expect(
      c.db.statements.filter((s) => /UPDATE\s+jurisdiction_contacts\s+SET\s+bounced_at/i.test(s.sql)),
    ).toHaveLength(1)
    expect(c.jobs.jobsFor("jurisdiction.discovery")).toHaveLength(1)
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
