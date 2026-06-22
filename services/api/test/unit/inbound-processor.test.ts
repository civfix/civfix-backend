import { describe, expect, it } from "vitest"
import { FakeInboundMail, FakeJobs, FakeStorage } from "@civfix/shared/fakes"
import type { InboundMail } from "@civfix/shared/interfaces"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { InMemoryInboundRepository } from "../../src/services/admin/inbound-repository.memory.js"
import { InMemoryAdminReportRepository } from "../../src/services/admin/admin-report-repository.memory.js"
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
  adminReportRepo: InMemoryAdminReportRepository
  cleanupRepo: InMemoryCleanupRepository
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
  const adminReportRepo = new InMemoryAdminReportRepository()
  const cleanupRepo = new InMemoryCleanupRepository()
  const jobs = new FakeJobs()
  const db = makeFakeSql(sqlHandlers)
  const deps: InboundProcessorDeps = {
    storage,
    inboundMail,
    mailRepo,
    inboundRepo,
    adminReportRepo,
    cleanupRepo,
  }
  const container = {
    env: {},
    storage,
    inboundStorage: storage,
    inboundMail,
    jobs,
    getDb: () => ({ sql: db.sql }),
  } as unknown as Container
  return { container, deps, storage, mailRepo, inboundRepo, adminReportRepo, cleanupRepo, jobs, db }
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
    const c = ctx()
    // Seed the report (published, claimed reporter) into the INJECTED in-memory report repo so the
    // side-effects run against it — no fake-sql for the report path.
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

    // The report was advanced to in_progress.
    expect(c.adminReportRepo.reports.get(reportId)?.record.status).toBe("in_progress")
    // A timeline row carrying the reply preview note was written.
    expect(
      (c.adminReportRepo.timeline.get(reportId) ?? []).some((t) =>
        (t.note ?? "").includes("Jurisdiction replied"),
      ),
    ).toBe(true)
    // The reporter was notified (bound to the reporter's user id + the report link).
    expect(
      c.adminReportRepo.notifications.some(
        (n) => n.userId === reporterId && n.link === `/reports/${reportId}`,
      ),
    ).toBe(true)
  })

  it("records a system 'reply' timeline row WITHOUT a status change for an already-resolved report", async () => {
    const reportId = "report-2"
    const c = ctx()
    c.adminReportRepo.seedReport({ id: reportId, status: "resolved", reporter: null })
    c.mailRepo.seedThread({ threadToken: TOKEN, reportId, status: "sent" })

    const key = `${INBOUND_PENDING_PREFIX}reply2.eml`
    await put(c, key, rfc822({ from: "clerk@lacity.gov", to: `reply+${TOKEN}@civfix.org`, body: "Done." }))
    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("threaded")

    // Status unchanged (resolved is past acknowledged) — only a system 'reply' timeline row is added.
    expect(c.adminReportRepo.reports.get(reportId)?.record.status).toBe("resolved")
    expect(
      (c.adminReportRepo.timeline.get(reportId) ?? []).some((t) =>
        (t.note ?? "").includes("Jurisdiction replied"),
      ),
    ).toBe(true)
    // No reporter on the report -> no notification.
    expect(c.adminReportRepo.notifications).toHaveLength(0)
  })

  it("a side-effect failure (report repo throws) never breaks routing / the delete", async () => {
    // The injected report repo's getReport rejects: onJurisdictionReply throws internally and is swallowed.
    const c = ctx()
    c.adminReportRepo.getReport = () => Promise.reject(new Error("db down"))
    c.mailRepo.seedThread({ threadToken: TOKEN, reportId: "report-x", status: "sent" })
    const key = `${INBOUND_PENDING_PREFIX}reply3.eml`
    await put(c, key, rfc822({ from: "clerk@lacity.gov", to: `reply+${TOKEN}@civfix.org`, body: "hi" }))
    const r = await processInboundObject(c.container, key, c.deps)
    expect(r.outcome).toBe("threaded")
    expect(c.storage.get(key)).toBeNull() // the pending object was still consumed
  })

  it("persists the FULL reply body + kind='reply' on the timeline (D13), not just the preview", async () => {
    const reportId = "report-full"
    const c = ctx()
    c.adminReportRepo.seedReport({ id: reportId, status: "published", reporter: null })
    c.mailRepo.seedThread({ threadToken: TOKEN, reportId, status: "sent" })
    // Spy on the repo's setStatus (the live-report path) to capture the kind + full body it persists.
    const calls: { kind?: string; body?: string | null; note: string }[] = []
    const orig = c.adminReportRepo.setStatus.bind(c.adminReportRepo)
    c.adminReportRepo.setStatus = (id, input) => {
      calls.push({ kind: input.kind, body: input.body, note: input.note })
      return orig(id, input)
    }
    const fullBody = "Hello — we have scheduled a crew for next week and will follow up after the visit."
    const key = `${INBOUND_PENDING_PREFIX}reply-full.eml`
    await put(c, key, rfc822({ from: "clerk@lacity.gov", to: `reply+${TOKEN}@civfix.org`, body: fullBody }))
    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("threaded")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.kind).toBe("reply")
    expect(calls[0]?.body).toBe(fullBody) // full untruncated text
    expect(calls[0]?.note).toContain("Jurisdiction replied") // the short preview note stays
  })
})

describe("processInboundObject: EVENT reply -> cleanup_timeline (D13/D19)", () => {
  it("writes a 'city_reply' cleanup_timeline row (actor null, full body) for an event thread", async () => {
    const cleanupId = "cleanup-evt-1"
    const c = ctx()
    // An event thread (cleanup_id set, NO report_id) on a 24-hex token.
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, cleanupId, status: "sent" })
    const fullBody = "Yes, we can supply 20 bags and gloves; pick them up at the depot Friday morning."
    const key = `${INBOUND_PENDING_PREFIX}evt-reply.eml`
    await put(c, key, rfc822({ from: "events@lacity.gov", to: `reply+${TOKEN}@civfix.org`, body: fullBody }))

    const r = await processInboundObject(c.container, key, c.deps)
    expect(r.outcome).toBe("threaded")
    // Threaded onto the event thread + flipped to 'replied'; NO report side-effects ran.
    expect((await c.mailRepo.getThreadRecord(thread.id))?.status).toBe("replied")

    const row = c.cleanupRepo.timeline.find((t) => t.cleanupId === cleanupId && t.kind === "city_reply")
    expect(row).toBeDefined()
    expect(row?.actorId).toBeNull()
    expect(row?.note).toBe(fullBody)
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
