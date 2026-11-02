/**
 * GH#173's city-mail correlator (D11) at the inbound processor: fixture messages with an
 * Authentication-Results verdict, parsed by the real adapter, over the memory repositories.
 */

import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { FakeJobs, FakeStorage, type EnqueueOptions } from "@civfix/seams"
import { CfInboundMail } from "../../src/adapters/inbound-mail.cf.js"
import type { Container } from "../../src/di.js"
import {
  INBOUND_PENDING_PREFIX,
  processInboundObject,
  type InboundProcessorDeps,
} from "../../src/services/admin/inbound-processor.js"
import { runInboundSweep } from "../../src/services/admin/inbound-sweep.js"
import {
  applyInboundEffects,
  inboundEffectDeps,
  JURISDICTION_REPLY_NOTIFICATION_BODY,
} from "../../src/services/admin/inbound-thread-correlation.js"
import { makeMailReplyPublishService } from "../../src/services/admin/mail-reply-publish-service.js"
import type { FilingRecord } from "../../src/services/filings/filing-types.js"
import { FILING_CLASSIFY_JOB } from "../../src/services/filings/filings-worker.js"
import type { ReportTimelineEvent } from "../../src/services/report-timeline-event.js"
import { InMemoryInboundRepository } from "../helpers/admin/inbound-repository.memory.js"
import { InMemoryMailRepository } from "../helpers/admin/mail-repository.memory.js"
import {
  filingHarness,
  J_GEOID,
  PORTAL_HOST,
  PORTAL_URL,
} from "../helpers/filings/filing-harness.js"
import { InMemoryFilingIngestSql } from "../helpers/filings/filing-ingest-sql.memory.js"

const INBOX = "filings@civfix.org"
const CODE = "GR-42-000123"
const OTHER_CODE = "GR-42-000124"
const L = `Reported by a resident via CivFix · ref ${CODE}`
const BURBANK = "0608954"
const E_CONTACT = "311@burbankca.gov"
const G_CONTACT = "burbank311@gmail.com"
const E_CASE = "BUR-55501"
const G_CASE = "BUR-55502"
const DAY_MS = 24 * 60 * 60 * 1000

/** pg-boss's "short" policy: a send whose singletonKey matches a job still waiting adds no job. */
class ShortPolicyJobs extends FakeJobs {
  failNext = false

  override async enqueue(name: string, data: unknown, opts?: EnqueueOptions): Promise<string> {
    if (this.failNext) {
      this.failNext = false
      throw new Error("queue unavailable")
    }
    const key = opts?.singletonKey
    const waiting = this.enqueued.find(
      (j) =>
        j.name === name &&
        j.state === "created" &&
        key !== undefined &&
        j.opts?.singletonKey === key,
    )
    if (waiting !== undefined) return waiting.id
    return super.enqueue(name, data, opts)
  }
}

interface Eml {
  from: string
  to?: string
  cc?: string
  subject?: string
  body: string
  auth?: "pass" | "fail"
  messageId?: string
  headers?: string[]
}

function eml(o: Eml): Buffer {
  const fromDomain = o.from.slice(o.from.lastIndexOf("@") + 1)
  const lines = [
    `From: ${o.from}`,
    `To: ${o.to ?? INBOX}`,
    ...(o.cc !== undefined ? [`Cc: ${o.cc}`] : []),
    `Subject: ${o.subject ?? "Service request update"}`,
    `Message-ID: ${o.messageId ?? `<${randomUUID()}@${fromDomain}>`}`,
    "Date: Sun, 25 Oct 2026 10:00:00 +0000",
    `Authentication-Results: mx.cloudflare.net; dmarc=${o.auth ?? "pass"} header.from=${fromDomain}`,
    ...(o.headers ?? []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    o.body,
  ]
  return Buffer.from(lines.join("\n"), "utf8")
}

async function world(opts: { inbox?: string; automatic?: boolean } = {}) {
  const h = filingHarness()
  h.filings.jurisdictions.set(BURBANK, "Burbank")
  const ingest = new InMemoryFilingIngestSql(h.filings, h.reports)
  const mailRepo = new InMemoryMailRepository()
  const inboundRepo = new InMemoryInboundRepository()
  const storage = new FakeStorage()
  const jobs = new ShortPolicyJobs()
  const inboundMail = new CfInboundMail()
  const chatEvents: ReportTimelineEvent[] = []
  const record = () => {}
  const deps: InboundProcessorDeps = {
    logger: { warn: record, error: record },
    storage,
    inboundMail,
    mailRepo,
    inboundRepo,
    adminReportRepo: h.reports,
    notifications: h.notifier,
    chatEmitter: {
      emit: (event) => {
        chatEvents.push(event)
        return Promise.resolve()
      },
    },
    filings: h.filings,
    filingIngest: ingest,
  }
  const container = {
    env: {
      FILING_INBOX_ADDRESS: opts.inbox ?? INBOX,
      FILING_AUTOMATIC_ENABLED: opts.automatic ?? true,
    },
    inboundStorage: storage,
    inboundMail,
    jobs,
    getDb: () => {
      throw new Error("no database in this test")
    },
  } as unknown as Container

  await h.filings.replaceRoutes(J_GEOID, [
    {
      category: "graffiti",
      channel: "portal",
      formUrl: PORTAL_URL,
      statusSenderDomains: ["lacity.org"],
    },
  ])

  const R = h.seed({ referenceCode: CODE, status: "acknowledged" })
  const F = await h.addFiling(
    R.record.id,
    { channel: "portal", routeCategory: "graffiti", portalHost: PORTAL_HOST },
    { status: "submitted", method: "script", submittedAt: new Date() },
  )

  async function emailFiling(contact: string, caseId: string) {
    const report = h.seed({ geoid: BURBANK, status: "acknowledged", category: "trash" })
    const thread = mailRepo.seedThread({ reportId: report.record.id, jurisdictionGeoid: BURBANK })
    mailRepo.seedMessage({ threadId: thread.id, direction: "out", toAddr: contact })
    const filing = await h.addFiling(
      report.record.id,
      { geoid: BURBANK, category: "trash", channel: "email", mailThreadId: thread.id },
      { status: "submitted", method: "email", submittedAt: new Date(), caseId },
    )
    return { report, thread, filing }
  }
  const E = await emailFiling(E_CONTACT, E_CASE)
  const G = await emailFiling(G_CONTACT, G_CASE)

  /** A submitted portal filing of a report of its own, with `caseId`. */
  async function otherFiling(
    caseId: string | null,
    extra: { referenceCode?: string; submittedAt?: Date; status?: FilingRecord["status"] } = {},
  ): Promise<FilingRecord> {
    const report = h.seed({
      status: "acknowledged",
      ...(extra.referenceCode !== undefined ? { referenceCode: extra.referenceCode } : {}),
    })
    return h.addFiling(
      report.record.id,
      { channel: "portal", routeCategory: "graffiti", portalHost: PORTAL_HOST },
      {
        status: extra.status ?? "submitted",
        method: "script",
        submittedAt: extra.submittedAt ?? new Date(),
        caseId,
      },
    )
  }

  function key(): string {
    return `${INBOUND_PENDING_PREFIX}${randomUUID()}.eml`
  }

  async function deliver(raw: Buffer, at = key()) {
    await storage.put(at, raw)
    return processInboundObject(container, at, deps)
  }

  return {
    h,
    ingest,
    mailRepo,
    inboundRepo,
    storage,
    jobs,
    deps,
    container,
    chatEvents,
    R,
    F,
    E,
    G,
    otherFiling,
    key,
    deliver,
    rows: () => h.filings.messages,
    classifyJobs: () => jobs.jobsFor(FILING_CLASSIFY_JOB),
  }
}

describe("filings-inbox hook", () => {
  it("T1: with FILING_INBOX_ADDRESS empty, mail To filings@ with the framing line stays an inbox row only", async () => {
    const w = await world({ inbox: "" })

    const r = await w.deliver(eml({ from: "noreply@lacity.org", body: L }))

    expect(r.outcome).toBe("inbox")
    expect(w.inboundRepo.rows).toHaveLength(1)
    expect(w.rows()).toHaveLength(0)
  })

  it("T2: To Filings@CivFix.org with L, auth pass from noreply@lacity.org links F, trusted, keeps the inbox row and enqueues one classify job", async () => {
    const w = await world()

    const r = await w.deliver(
      eml({ from: "noreply@lacity.org", to: "Filings@CivFix.org", body: L }),
    )

    expect(r.outcome).toBe("inbox")
    expect(w.rows()).toHaveLength(1)
    expect(w.rows()[0]).toMatchObject({
      filingId: w.F.id,
      inboundEmailId: r.id,
      mailMessageId: null,
      trusted: true,
      flagged: false,
    })
    expect(w.inboundRepo.rows.map((row) => row.id)).toEqual([r.id])
    expect(w.classifyJobs()).toHaveLength(1)
  })

  it("T3: To another address with Cc: CivFix Filings <filings@civfix.org> links F", async () => {
    const w = await world()

    await w.deliver(
      eml({
        from: "noreply@lacity.org",
        to: "support@civfix.org",
        cc: "CivFix Filings <filings@civfix.org>",
        body: L,
      }),
    )

    expect(w.rows().map((m) => m.filingId)).toEqual([w.F.id])
  })

  it("T4: To and Cc other addresses (filings@ only in the envelope) links nothing", async () => {
    const w = await world()

    await w.deliver(
      eml({ from: "noreply@lacity.org", to: "support@civfix.org", cc: "ops@civfix.org", body: L }),
    )

    expect(w.rows()).toHaveLength(0)
  })

  it("T35: a filings-inbox message creates no mail_threads row and no report-chat message", async () => {
    const w = await world()
    const threadsBefore = w.mailRepo.threads.size

    await w.deliver(eml({ from: "noreply@lacity.org", body: L }))

    expect(w.rows()).toHaveLength(1)
    expect(w.mailRepo.threads.size).toBe(threadsBefore)
    expect(w.chatEvents).toHaveLength(0)
  })

  it("T41: a bounce To filings@ that quotes L goes down the bounce path and links nothing", async () => {
    const w = await world()

    const r = await w.deliver(
      eml({
        from: "mailer-daemon@lacity.org",
        headers: ["X-Failed-Recipients: 311@lacity.org"],
        body: `Delivery to 311@lacity.org failed.\n\n> ${L}`,
      }),
    )

    expect(r.outcome).toBe("inbox")
    expect(w.inboundRepo.rows).toHaveLength(1)
    expect(w.rows()).toHaveLength(0)
  })
})

describe("step 1: the framing line", () => {
  it("T5: L twice links F", async () => {
    const w = await world()

    await w.deliver(eml({ from: "noreply@lacity.org", body: `${L}\n\n${L}` }))

    expect(w.rows().map((m) => m.filingId)).toEqual([w.F.id])
  })

  it("T5b: L for a report whose only filing is needs_human falls to step 2 and links the one filing whose caseId the body holds", async () => {
    const w = await world()
    const pending = w.h.seed({ referenceCode: "GR-42-000777", status: "published" })
    await w.h.addFiling(pending.record.id, { status: "needs_human", reason: "captcha" })
    const other = await w.otherFiling("1-2345678901")

    await w.deliver(
      eml({
        from: "noreply@lacity.org",
        body: "Reported by a resident via CivFix · ref GR-42-000777\nRequest 1-2345678901",
      }),
    )

    expect(w.rows().map((m) => m.filingId)).toEqual([other.id])
  })

  it("T6: L plus a second framing line naming another report's filed code links nothing", async () => {
    const w = await world()
    await w.otherFiling(null, { referenceCode: OTHER_CODE })

    await w.deliver(
      eml({
        from: "noreply@lacity.org",
        body: `${L}\nReported by a resident via CivFix · ref ${OTHER_CODE}`,
      }),
    )

    expect(w.rows()).toHaveLength(0)
  })

  it("T7: a bare code without the phrase and no case-id match links nothing", async () => {
    const w = await world()

    await w.deliver(eml({ from: "noreply@lacity.org", body: `see ${CODE}` }))

    expect(w.rows()).toHaveLength(0)
  })

  it("T8: F has caseId 1-111 and the message lacks it: linked, flagged, no classify job", async () => {
    const w = await world()
    w.h.filings.filings.set(w.F.id, { ...w.h.filings.filings.get(w.F.id)!, caseId: "1-111" })

    await w.deliver(eml({ from: "noreply@lacity.org", body: L }))

    expect(w.rows()).toHaveLength(1)
    expect(w.rows()[0]).toMatchObject({ filingId: w.F.id, flagged: true })
    expect(w.classifyJobs()).toHaveLength(0)
  })

  it("T9: F has caseId 1-111 and the message carries it: linked, trusted", async () => {
    const w = await world()
    w.h.filings.filings.set(w.F.id, { ...w.h.filings.filings.get(w.F.id)!, caseId: "1-111" })

    await w.deliver(eml({ from: "noreply@lacity.org", body: `${L}\nRequest 1-111` }))

    expect(w.rows()).toHaveLength(1)
    expect(w.rows()[0]).toMatchObject({ filingId: w.F.id, trusted: true, flagged: false })
  })

  it("T38: other case and `-` as the separator still link F, trusted", async () => {
    const w = await world()

    await w.deliver(
      eml({ from: "noreply@lacity.org", body: `REPORTED BY A RESIDENT VIA CIVFIX - ref ${CODE}` }),
    )

    expect(w.rows()).toHaveLength(1)
    expect(w.rows()[0]).toMatchObject({ filingId: w.F.id, trusted: true })
  })

  it("T39: L plus a bare `ref <other filed code>` line links F: only framing lines count", async () => {
    const w = await world()
    await w.otherFiling(null, { referenceCode: OTHER_CODE })

    await w.deliver(eml({ from: "noreply@lacity.org", body: `${L}\nref ${OTHER_CODE}` }))

    expect(w.rows().map((m) => m.filingId)).toEqual([w.F.id])
  })
})

describe("step 2: a case id", () => {
  it("T10: no L; the body holds the caseId of exactly one filing submitted 179 days ago: linked to it", async () => {
    const w = await world()
    const old = await w.otherFiling("1-2345678901", {
      submittedAt: new Date(Date.now() - 179 * DAY_MS),
    })

    await w.deliver(
      eml({ from: "noreply@lacity.org", body: "Your request 1-2345678901 was updated" }),
    )

    expect(w.rows().map((m) => m.filingId)).toEqual([old.id])
  })

  it("T11: two filings with the caseId, the only one 181 days old, or the body holding 1-2345678901x: no row each time", async () => {
    const twice = await world()
    await twice.otherFiling("1-2345678901")
    await twice.otherFiling("1-2345678901")
    await twice.deliver(eml({ from: "noreply@lacity.org", body: "Request 1-2345678901" }))
    expect(twice.rows()).toHaveLength(0)

    const stale = await world()
    await stale.otherFiling("1-2345678901", { submittedAt: new Date(Date.now() - 181 * DAY_MS) })
    await stale.deliver(eml({ from: "noreply@lacity.org", body: "Request 1-2345678901" }))
    expect(stale.rows()).toHaveLength(0)

    const longer = await world()
    await longer.otherFiling("1-2345678901")
    await longer.deliver(eml({ from: "noreply@lacity.org", body: "Request 1-2345678901x" }))
    expect(longer.rows()).toHaveLength(0)
  })
})

describe("replays", () => {
  it("T12: the same message delivered twice makes one row and one classify job", async () => {
    const w = await world()
    const raw = eml({ from: "noreply@lacity.org", body: L, messageId: "<twice@lacity.org>" })

    await w.deliver(raw)
    await w.deliver(raw)

    expect(w.rows()).toHaveLength(1)
    expect(w.classifyJobs()).toHaveLength(1)
  })

  it("T12b: a classify enqueue that throws leaves the object for the sweep, whose replay makes one row and one job", async () => {
    const w = await world()
    const at = w.key()
    w.jobs.failNext = true

    await expect(w.deliver(eml({ from: "noreply@lacity.org", body: L }), at)).rejects.toThrow()
    expect(w.storage.get(at)).not.toBeNull()

    await runInboundSweep(w.container, { deps: w.deps })

    expect(w.rows()).toHaveLength(1)
    expect(w.classifyJobs()).toHaveLength(1)
    expect(w.storage.get(at)).toBeNull()
  })
})

describe("filings-inbox trust", () => {
  it("T13: pass from noreply@lacity.org is trusted; pass from x@mail.lacity.org and fail from noreply@lacity.org are untrusted and flagged", async () => {
    const w = await world()

    await w.deliver(eml({ from: "noreply@lacity.org", body: L }))
    await w.deliver(eml({ from: "x@mail.lacity.org", body: L }))
    await w.deliver(eml({ from: "noreply@lacity.org", auth: "fail", body: L }))

    expect(w.rows().map((m) => ({ trusted: m.trusted, flagged: m.flagged }))).toEqual([
      { trusted: true, flagged: false },
      { trusted: false, flagged: true },
      { trusted: false, flagged: true },
    ])
  })

  it("T14: mail linking E by its caseId is trusted from notify@burbankca.gov and untrusted from notify@lacity.org", async () => {
    const w = await world()

    await w.deliver(eml({ from: "notify@burbankca.gov", body: `Case ${E_CASE} updated` }))
    await w.deliver(eml({ from: "notify@lacity.org", body: `Case ${E_CASE} updated` }))

    expect(w.rows().map((m) => ({ filingId: m.filingId, trusted: m.trusted }))).toEqual([
      { filingId: w.E.filing.id, trusted: true },
      { filingId: w.E.filing.id, trusted: false },
    ])
  })

  it("T14b: mail linking G by its caseId is trusted only from the exact consumer mailbox it was sent to", async () => {
    const w = await world()

    await w.deliver(eml({ from: G_CONTACT, body: `Case ${G_CASE} updated` }))
    await w.deliver(eml({ from: "someone@gmail.com", body: `Case ${G_CASE} updated` }))

    expect(w.rows().map((m) => ({ filingId: m.filingId, trusted: m.trusted }))).toEqual([
      { filingId: w.G.filing.id, trusted: true },
      { filingId: w.G.filing.id, trusted: false },
    ])
  })

  it("T40: a route with no sender domains, or a portal filing with no route row, is never trusted", async () => {
    const empty = await world()
    await empty.h.filings.replaceRoutes(J_GEOID, [
      { category: "graffiti", channel: "portal", formUrl: PORTAL_URL, statusSenderDomains: [] },
    ])
    await empty.deliver(eml({ from: "noreply@lacity.org", to: "Filings@CivFix.org", body: L }))
    expect(empty.rows()).toHaveLength(1)
    expect(empty.rows()[0]).toMatchObject({ filingId: empty.F.id, trusted: false, flagged: true })
    expect(empty.classifyJobs()).toHaveLength(0)

    const none = await world()
    none.h.filings.routes = []
    await none.deliver(eml({ from: "noreply@lacity.org", to: "Filings@CivFix.org", body: L }))
    expect(none.rows()).toHaveLength(1)
    expect(none.rows()[0]).toMatchObject({ filingId: none.F.id, trusted: false, flagged: true })
    expect(none.classifyJobs()).toHaveLength(0)
  })
})

describe("classify enqueue", () => {
  it("T15: as T2 with automatic filing off: the row exists and no classify job", async () => {
    const w = await world({ automatic: false })

    await w.deliver(eml({ from: "noreply@lacity.org", to: "Filings@CivFix.org", body: L }))

    expect(w.rows()).toHaveLength(1)
    expect(w.classifyJobs()).toHaveLength(0)
  })

  it("T16: a 50,000-character body sends its first 20,000 characters", async () => {
    const w = await world()
    const filler = Array.from({ length: 1000 }, (_, i) => `line ${i} `.padEnd(79, "x")).join("\n")
    const body = `${L}\n${filler}`.slice(0, 50_000)
    expect(body).toHaveLength(50_000)

    await w.deliver(eml({ from: "noreply@lacity.org", subject: "Update", body }))

    expect(w.classifyJobs()).toHaveLength(1)
    const data = w.classifyJobs()[0]!.data as {
      filingMessageId: string
      subject: string
      text: string
    }
    expect(data).toEqual({
      filingMessageId: w.rows()[0]!.id,
      subject: "Update",
      text: body.slice(0, 20_000),
    })
  })
})

describe("email-channel replies", () => {
  it("T17: a reply on T from the jurisdiction's sender links E by mail_message_id, trusted, enqueues one job and keeps today's effects", async () => {
    const w = await world()
    const reporter = w.E.report.record.reporter!.id

    const r = await w.deliver(
      eml({
        from: "clerk@burbankca.gov",
        to: `reply-${w.E.thread.threadToken}@civfix.org`,
        body: "We have received your request.",
      }),
    )

    expect(r.outcome).toBe("threaded")
    const inbound = w.mailRepo.messages.find((m) => m.direction === "in")!
    expect(w.rows()).toHaveLength(1)
    expect(w.rows()[0]).toMatchObject({
      filingId: w.E.filing.id,
      mailMessageId: inbound.id,
      inboundEmailId: null,
      trusted: true,
      flagged: false,
    })
    expect(w.classifyJobs()).toHaveLength(1)
    expect(w.h.reports.reports.get(w.E.report.record.id)!.record.status).toBe("in_progress")
    expect(w.chatEvents.map((e) => ({ reportId: e.reportId, kind: e.kind }))).toEqual([
      { reportId: w.E.report.record.id, kind: "reply" },
    ])
    expect(w.h.notifier.sent.map((n) => ({ userId: n.userId, body: n.body }))).toEqual([
      { userId: reporter, body: JURISDICTION_REPLY_NOTIFICATION_BODY },
    ])
  })

  it("T18: a reply on R's resident @city discussion thread gets no filing_messages row", async () => {
    const w = await world()
    const discussion = w.mailRepo.seedThread({
      reportId: w.R.record.id,
      jurisdictionGeoid: J_GEOID,
    })
    w.mailRepo.seedMessage({ threadId: discussion.id, direction: "out", toAddr: "311@lacity.org" })

    const r = await w.deliver(
      eml({
        from: "clerk@lacity.org",
        to: `reply-${discussion.threadToken}@civfix.org`,
        body: "Thanks for the note.",
      }),
    )

    expect(r.outcome).toBe("threaded")
    expect(w.rows()).toHaveLength(0)
  })

  it("T19: a withheld reply on T is linked untrusted and flagged, and neither its arrival nor its publishing enqueues a job", async () => {
    const w = await world()

    await w.deliver(
      eml({
        from: "someone@example.net",
        to: `reply-${w.E.thread.threadToken}@civfix.org`,
        body: "Your request is closed.",
      }),
    )

    expect(w.rows()).toHaveLength(1)
    expect(w.rows()[0]).toMatchObject({ filingId: w.E.filing.id, trusted: false, flagged: true })
    expect(w.classifyJobs()).toHaveLength(0)

    const withheld = w.mailRepo.messages.find((m) => m.direction === "in")!
    const publish = makeMailReplyPublishService({
      repo: w.mailRepo,
      applyEffects: (thread, message, publishedBy) =>
        applyInboundEffects(w.container, inboundEffectDeps(w.deps), w.mailRepo, thread, message, {
          publishedBy,
        }),
      logger: { warn: () => {} },
    })
    const published = await publish.publish({
      threadId: w.E.thread.id,
      messageId: withheld.id,
      actorId: "op-1",
    })

    expect(published).toEqual({ publication: "published" })
    expect(w.rows()).toHaveLength(1)
    expect(w.rows()[0]).toMatchObject({ trusted: false, flagged: true })
    expect(w.classifyJobs()).toHaveLength(0)
  })
})
