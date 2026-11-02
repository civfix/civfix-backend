import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { ErrorCode } from "@civfix/contract"
import {
  FakeMailer,
  FakeStorage,
  MailSendError,
  type OutboundEmail,
  type SentMail,
} from "@civfix/seams"
import { renderMessage } from "../../src/i18n/renderMessage.js"
import type { MessageKey } from "../../src/i18n/messages/en.js"
import { mapOutreachStatus } from "../../src/services/admin/admin-report-repository.drizzle.js"
import type {
  OutreachOptions,
  ReportOutreachState,
} from "../../src/services/admin/admin-report-repository.js"
import {
  makeOutboundMailService,
  outboundPayloadBytes,
} from "../../src/services/admin/outbound-mail-service.js"
import {
  OUTBOUND_PAYLOAD_BUDGET_BYTES,
  ROUTE_DEADLINE_INFLIGHT_SECONDS,
} from "../../src/services/admin/outbound-send-policy.js"
import { makeFilingEmailHandler } from "../../src/services/filings/filing-email-jobs.js"
import type { FilingRecord } from "../../src/services/filings/filing-types.js"
import { InMemoryMailRepository } from "../helpers/admin/mail-repository.memory.js"
import type { SeededReport } from "../helpers/admin/admin-report-repository.memory.js"
import {
  filingHarness,
  J_CONTACT,
  J_NAME,
  type FilingHarness,
} from "../helpers/filings/filing-harness.js"

const MiB = 1024 * 1024
const SECOND_MS = 1000
const INFLIGHT_MS = ROUTE_DEADLINE_INFLIGHT_SECONDS * SECOND_MS
const MAIL_ENV = { MAIL_FROM_OUTREACH: "outreach@civfix.org", MAIL_REPLY_DOMAIN: "civfix.org" }
const FRAMED_TICKET = "Pothole\n\nReported by a resident via CivFix"

/**
 * The report's outreach as `getOutreach` reads it from mail_messages and mail_events (packetSent,
 * sendFailedExpr, sendInFlightExpr), over the mail twin the worker writes to.
 */
function outreachFromMail(
  mail: InMemoryMailRepository,
  reportId: string,
  opts: OutreachOptions = {},
): ReportOutreachState {
  const thread = [...mail.threads.values()]
    .filter((t) => t.reportId === reportId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
  if (thread === undefined) {
    return {
      status: "not_sent",
      threadId: null,
      routedTo: null,
      routedAt: null,
      packetSent: false,
      sendFailed: false,
      sendInFlight: false,
    }
  }
  const since = opts.packetsSince?.getTime() ?? Number.NEGATIVE_INFINITY
  const messages = mail.messagesOf(thread.id)
  const outs = messages.filter((m) => m.direction === "out")
  const recent = outs.filter((m) => m.createdAt.getTime() >= since)
  const eventsOf = (id: string) => mail.events.filter((e) => e.messageId === id)
  const young = (d: Date) => d.getTime() > Date.now() - INFLIGHT_MS
  const isDeadline = (meta: Record<string, unknown> | null) => meta?.reason === "deadline"
  const sentSince = recent.some((m) => eventsOf(m.id).some((e) => e.type === "sent"))
  let sendFailed = false
  let sendInFlight = false
  const latest = recent.at(-1)
  if (latest !== undefined) {
    const own = eventsOf(latest.id)
    const failed = own.filter((e) => e.type === "failed")
    const youngDeadline = failed.some((e) => isDeadline(e.meta) && young(e.createdAt))
    const definite = failed.some((e) => !isDeadline(e.meta))
    sendFailed =
      !sentSince &&
      (definite ? true : youngDeadline ? false : failed.length > 0 || !young(latest.createdAt))
    sendInFlight =
      !own.some((e) => e.type === "sent") &&
      (youngDeadline || (failed.length === 0 && young(latest.createdAt)))
  }
  return {
    status: mapOutreachStatus(
      thread.status,
      messages.some((m) => m.direction === "in"),
    ),
    threadId: thread.id,
    routedTo: outs.filter((m) => m.toAddr !== null && m.toAddr !== "").at(-1)?.toAddr ?? null,
    routedAt: outs[0]?.createdAt.toISOString() ?? null,
    packetSent: recent.some((m) => (m.kind ?? "packet") === "packet"),
    sendFailed,
    sendInFlight,
  }
}

/** A FakeMailer whose sends can wait on a gate, run a hook first, or fail. */
class ScriptedMailer extends FakeMailer {
  calls = 0
  before: (() => Promise<void>) | null = null
  fail: Error | null = null

  override async sendOutbound(email: OutboundEmail): Promise<SentMail> {
    this.calls += 1
    if (this.before !== null) await this.before()
    if (this.fail !== null) throw this.fail
    return super.sendOutbound(email)
  }
}

interface EmailWorld extends FilingHarness {
  mail: InMemoryMailRepository
  mailer: ScriptedMailer
  storage: FakeStorage
  run(filingId: string, retryCount?: number): Promise<void>
}

function emailWorld(opts: { sendDeadlineMs?: number } = {}): EmailWorld {
  const h = filingHarness()
  const mail = new InMemoryMailRepository()
  // The twin stamps rows from its own clock; the filing twin uses the real one.
  Object.defineProperty(mail, "now", { get: () => new Date() })
  h.reports.getOutreach = (id, o) => Promise.resolve(outreachFromMail(mail, id, o))
  const mailer = new ScriptedMailer()
  const storage = new FakeStorage()
  const outboundMail = makeOutboundMailService({
    repo: mail,
    mailer,
    env: MAIL_ENV,
    logger: { warn: () => {} },
    ...(opts.sendDeadlineMs !== undefined ? { sendDeadlineMs: opts.sendDeadlineMs } : {}),
  })
  const handler = makeFilingEmailHandler({
    filings: h.filings,
    reports: h.reports,
    mail,
    outboundMail,
    storage,
    presignPacketMedia: (key) => Promise.resolve(`https://media.test/${key}`),
    filingService: h.svc,
    logger: { warn: (...args: unknown[]) => void h.warnings.push(args) },
  })
  return {
    ...h,
    mail,
    mailer,
    storage,
    run: (filingId, retryCount = 0) =>
      handler({ id: `job-${filingId}`, data: { filingId }, retryCount, retryLimit: 2 }),
  }
}

async function addMedia(
  w: EmailWorld,
  report: SeededReport,
  kind: "image" | "video",
  bytes: number | null,
): Promise<void> {
  const id = randomUUID()
  const r2Key = `media/${id}`
  report.media.push({ id, kind, r2Key, thumbKey: null })
  if (bytes !== null) await w.storage.put(r2Key, new Uint8Array(bytes))
}

async function queuedFiling(
  w: EmailWorld,
  report: SeededReport,
  note: string | null = null,
): Promise<FilingRecord> {
  const out = await w.svc.create({ reportId: report.record.id, actorId: "op-1", note })
  if (out.kind !== "created") throw new Error(`filing not created: ${out.kind}`)
  expect(out.filing).toMatchObject({ status: "queued", channel: "email" })
  return out.filing
}

function filing(w: EmailWorld, id: string): FilingRecord {
  const f = w.filings.filings.get(id)
  if (f === undefined) throw new Error(`no filing ${id}`)
  return f as FilingRecord
}

function sentEmails(w: EmailWorld): OutboundEmail[] {
  return w.mailer.sent.flatMap((s) => (s.outbound === undefined ? [] : [s.outbound]))
}

function routeEntries(w: EmailWorld, reportId: string): (string | null)[] {
  return (w.reports.timeline.get(reportId) ?? [])
    .filter((r) => r.kind === "route")
    .map((r) => r.note)
}

function linkLabels(text: string): string[] {
  return [...text.matchAll(/^\s+((?:Photo|Video) \d+): https:/gm)].map((m) => m[1] as string)
}

/** The body's last paragraph before the footer rule. */
function lastParagraph(text: string): string {
  const parts = text.split("\n\n")
  return parts[parts.lastIndexOf("--") - 1] ?? ""
}

function notificationText(n: { titleKey?: MessageKey; vars?: Record<string, unknown> }): string {
  if (n.titleKey === undefined) throw new Error("notification has no titleKey")
  return renderMessage("en", n.titleKey, n.vars as Record<string, string>)
}

function ago(ms: number): Date {
  return new Date(Date.now() - ms)
}

/** A packet to J on the report's thread, created at `at`, with its `sent` event. */
function deliveredPacket(w: EmailWorld, reportId: string, at: Date): string {
  const thread = w.mail.seedThread({ reportId, createdAt: new Date(at.getTime() - 1) })
  const message = w.mail.seedMessage({
    threadId: thread.id,
    direction: "out",
    toAddr: J_CONTACT,
    kind: "packet",
    body: "the earlier packet",
    createdAt: at,
  })
  w.mail.seedEvent({ threadId: thread.id, messageId: message.id, type: "sent", createdAt: at })
  return thread.id
}

describe("filing.email: what it sends", () => {
  it("E4: ref LA-7, note and two 1 MiB photos: both attached, the closing paragraph, and the success effects", async () => {
    const w = emailWorld()
    const r = w.seed({ contact: J_CONTACT, referenceCode: "LA-7" })
    await addMedia(w, r, "image", MiB)
    await addMedia(w, r, "image", MiB)
    const f = await queuedFiling(w, r, "Corner of 5th")

    await w.run(f.id)

    const emails = sentEmails(w)
    expect(emails).toHaveLength(1)
    const email = emails[0] as OutboundEmail
    expect(email.attachments?.map((a) => [a.filename, a.contentType])).toEqual([
      ["photo-1.jpg", "image/jpeg"],
      ["photo-2.jpg", "image/jpeg"],
    ])
    const closing = lastParagraph(email.text)
    expect(closing).toContain("Reported by a resident via CivFix · ref LA-7")
    expect(closing).toContain("Note from CivFix: Corner of 5th")
    expect(linkLabels(email.text)).toEqual([])
    expect(filing(w, f.id)).toMatchObject({
      status: "submitted",
      method: "email",
      mailThreadId: expect.any(String),
    })
    expect(r.record.status).toBe("acknowledged")
    expect(routeEntries(w, r.record.id)).toEqual([`Filed with ${J_NAME}`])
    expect(w.notifier.sent.map(notificationText)).toEqual([`Your report was sent to ${J_NAME}`])
  })

  it("E5: photos of 3, 3 and 1 MiB then a video: the first and third attached, the rest linked, within the budget", async () => {
    const w = emailWorld()
    const r = w.seed({ contact: J_CONTACT })
    await addMedia(w, r, "image", 3 * MiB)
    await addMedia(w, r, "image", 3 * MiB)
    await addMedia(w, r, "image", MiB)
    await addMedia(w, r, "video", 2 * MiB)
    const f = await queuedFiling(w, r)

    await w.run(f.id)

    const email = sentEmails(w)[0] as OutboundEmail
    expect(email.attachments?.map((a) => [a.filename, a.content.byteLength])).toEqual([
      ["photo-1.jpg", 3 * MiB],
      ["photo-2.jpg", MiB],
    ])
    expect(linkLabels(email.text)).toEqual(["Photo 2", "Video 1"])
    expect(
      outboundPayloadBytes({
        body: email.text,
        html: email.html,
        attachments: email.attachments ?? [],
      }),
    ).toBeLessThanOrEqual(OUTBOUND_PAYLOAD_BUDGET_BYTES)
  })

  it("E6: six 0.5 MiB photos: five attached, only Photo 6 linked", async () => {
    const w = emailWorld()
    const r = w.seed({ contact: J_CONTACT })
    for (let i = 0; i < 6; i++) await addMedia(w, r, "image", MiB / 2)
    const f = await queuedFiling(w, r)

    await w.run(f.id)

    const email = sentEmails(w)[0] as OutboundEmail
    expect(email.attachments?.map((a) => a.filename)).toEqual([
      "photo-1.jpg",
      "photo-2.jpg",
      "photo-3.jpg",
      "photo-4.jpg",
      "photo-5.jpg",
    ])
    expect(linkLabels(email.text)).toEqual(["Photo 6"])
  })

  it("E7: a photo whose served object is missing is linked, not attached", async () => {
    const w = emailWorld()
    const r = w.seed({ contact: J_CONTACT })
    await addMedia(w, r, "image", null)
    const f = await queuedFiling(w, r)

    await w.run(f.id)

    const email = sentEmails(w)[0] as OutboundEmail
    expect(email.attachments ?? []).toEqual([])
    expect(linkLabels(email.text)).toEqual(["Photo 1"])
  })
})

describe("filing.email: outcomes", () => {
  it("E8: a MailSendError on every try: queued after tries 1 and 2, portal_error on the last, one packet row", async () => {
    const w = emailWorld()
    const message = "Email not sent: the recipient address was permanently rejected (SMTP 550)"
    w.mailer.fail = new MailSendError(ErrorCode.CONFLICT, message, { responseCode: 550 })
    const r = w.seed({ contact: J_CONTACT })
    const f = await queuedFiling(w, r)

    await expect(w.run(f.id, 0)).rejects.toThrow(message)
    expect(filing(w, f.id).status).toBe("queued")
    await expect(w.run(f.id, 1)).rejects.toThrow(message)
    expect(filing(w, f.id).status).toBe("queued")
    await expect(w.run(f.id, 2)).resolves.toBeUndefined()

    const after = filing(w, f.id)
    expect(after).toMatchObject({
      status: "needs_human",
      reason: "portal_error",
      reasonDetail: message,
    })
    expect(w.mailer.calls).toBe(3)
    const packets = w.mail.messages.filter(
      (m) => m.threadId === after.mailThreadId && m.direction === "out" && m.kind === "packet",
    )
    expect(packets).toHaveLength(1)
  })

  it("E9: a send that hits its deadline goes to uncertain_submission and the handler completes", async () => {
    const w = emailWorld({ sendDeadlineMs: 5 })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    w.mailer.before = () => gate
    const r = w.seed({ contact: J_CONTACT })
    const f = await queuedFiling(w, r)

    await expect(w.run(f.id)).resolves.toBeUndefined()
    expect(filing(w, f.id)).toMatchObject({ status: "needs_human", reason: "uncertain_submission" })
    release()
  })

  it("E10: when the mail server answers after the deadline, the filing becomes submitted with one entry", async () => {
    const w = emailWorld({ sendDeadlineMs: 5 })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    w.mailer.before = () => gate
    const r = w.seed({ contact: J_CONTACT })
    const f = await queuedFiling(w, r)
    await w.run(f.id)
    expect(filing(w, f.id).status).toBe("needs_human")

    release()

    await vi.waitFor(() => expect(filing(w, f.id).status).toBe("submitted"), { timeout: 2000 })
    expect(filing(w, f.id)).toMatchObject({ method: "email", mailThreadId: expect.any(String) })
    expect(routeEntries(w, r.record.id)).toEqual([`Filed with ${J_NAME}`])
  })

  it("E11: a packet delivered after the filing records it with no second email; one from before it does not", async () => {
    const w = emailWorld()
    const r = w.seed({ contact: J_CONTACT })
    const queued = await queuedFiling(w, r)
    // Created an hour ago, so the packet after it is still before the filing made below.
    const f = { ...filing(w, queued.id), createdAt: ago(60 * 60 * SECOND_MS) }
    w.filings.filings.set(f.id, f)
    const threadId = deliveredPacket(w, r.record.id, new Date(f.createdAt.getTime() + SECOND_MS))

    await w.run(f.id)

    expect(filing(w, f.id)).toMatchObject({
      status: "submitted",
      method: "email",
      mailThreadId: threadId,
    })
    expect(w.mailer.calls).toBe(0)
    expect(r.record.status).toBe("acknowledged")
    expect(routeEntries(w, r.record.id)).toEqual([`Filed with ${J_NAME}`])

    // The city closes its request and an operator files again: the earlier packet is now before it.
    await w.filings.transition(f.id, { from: ["submitted"], set: { cityClosedAt: new Date() } })
    const again = await queuedFiling(w, r)
    await w.run(again.id)

    expect(w.mailer.calls).toBe(1)
    expect(filing(w, again.id)).toMatchObject({ status: "submitted", mailThreadId: threadId })
  })

  it("E12: no recipient at send time: needs_human / no_route and the handler completes", async () => {
    const w = emailWorld()
    const r = w.seed({ contact: J_CONTACT })
    const f = await queuedFiling(w, r)
    if (r.routing === null) throw new Error("seeded without routing")
    r.routing.contact = null

    await expect(w.run(f.id)).resolves.toBeUndefined()

    expect(filing(w, f.id)).toMatchObject({ status: "needs_human", reason: "no_route" })
    expect(w.mailer.calls).toBe(0)
  })

  it("E13: paused leaves it queued; a rejected verdict cancels it; a cancelled filing is a no-op", async () => {
    const w = emailWorld()
    const paused = await queuedFiling(w, w.seed({ contact: J_CONTACT }))
    await w.filings.setPaused(true)
    await w.run(paused.id)
    expect(w.mailer.calls).toBe(0)
    expect(filing(w, paused.id).status).toBe("queued")
    await w.filings.setPaused(false)

    const rejectedReport = w.seed({ contact: J_CONTACT })
    const rejected = await queuedFiling(w, rejectedReport)
    rejectedReport.record.verificationVerdict = "rejected"
    await w.run(rejected.id)
    expect(filing(w, rejected.id).status).toBe("cancelled")
    expect(w.mailer.calls).toBe(0)

    const cancelled = await queuedFiling(w, w.seed({ contact: J_CONTACT }))
    await w.filings.transition(cancelled.id, { from: ["queued"], set: { status: "cancelled" } })
    const before = { ...filing(w, cancelled.id) }
    await w.run(cancelled.id)
    expect(filing(w, cancelled.id)).toEqual(before)
    expect(w.mailer.calls).toBe(0)
    expect(w.warnings).toEqual([])
  })

  it("E14: two deliveries of one job: the second's claim returns null, one email, one entry", async () => {
    const w = emailWorld()
    const r = w.seed({ contact: J_CONTACT })
    const f = await queuedFiling(w, r)
    const claims: unknown[] = []
    const claim = w.filings.claim.bind(w.filings)
    w.filings.claim = async (id, attempt) => {
      const out = await claim(id, attempt)
      claims.push(out)
      return out
    }

    await Promise.all([w.run(f.id), w.run(f.id)])

    expect(claims).toEqual([{ runId: expect.any(String) }, null])
    expect(sentEmails(w)).toHaveLength(1)
    expect(routeEntries(w, r.record.id)).toHaveLength(1)
  })

  it("E15: the filing moved out of running before the success write: a warning, no entry, no notification", async () => {
    const w = emailWorld()
    const r = w.seed({ contact: J_CONTACT })
    const f = await queuedFiling(w, r)
    w.mailer.before = async () => {
      await w.filings.transition(f.id, { from: ["running"], set: { status: "cancelled" } })
    }

    await w.run(f.id)

    expect(sentEmails(w)).toHaveLength(1)
    expect(filing(w, f.id).status).toBe("cancelled")
    expect(w.warnings.some((args) => JSON.stringify(args).includes(f.id))).toBe(true)
    expect(routeEntries(w, r.record.id)).toEqual([])
    expect(w.notifier.sent).toEqual([])
  })
})

describe("filing.sweep: stuck email filings", () => {
  it("E18: a stuck running email filing is requeued and recorded on its delivered packet; a young one and a portal one stay", async () => {
    const w = emailWorld()
    const ra = w.seed({ contact: J_CONTACT })
    const a = await w.addFiling(
      ra.record.id,
      { channel: "email", status: "queued", ticketText: FRAMED_TICKET },
      { status: "running", attempts: 1, createdAt: ago(60 * 60 * SECOND_MS) },
    )
    const threadId = deliveredPacket(w, ra.record.id, new Date(a.createdAt.getTime() + SECOND_MS))
    const rb = w.seed({ contact: J_CONTACT })
    const b = await w.addFiling(
      rb.record.id,
      { channel: "email", status: "queued", ticketText: FRAMED_TICKET },
      { status: "running", attempts: 1 },
    )
    const rc = w.seed({ contact: J_CONTACT })
    const c = await w.addFiling(
      rc.record.id,
      { channel: "portal", status: "queued", ticketText: FRAMED_TICKET },
      { status: "running", attempts: 1 },
    )
    // Written last: the twin stamps updated_at on every write.
    w.filings.filings.set(a.id, {
      ...filing(w, a.id),
      updatedAt: ago(INFLIGHT_MS + 60 * SECOND_MS),
    })
    w.filings.filings.set(b.id, {
      ...filing(w, b.id),
      updatedAt: ago(INFLIGHT_MS - 60 * SECOND_MS),
    })

    await w.svc.runSweepPass()

    expect(filing(w, a.id).status).toBe("queued")
    expect(filing(w, b.id).status).toBe("running")
    expect(w.jobs.jobsFor("filing.email").map((j) => ({ data: j.data, opts: j.opts }))).toEqual([
      { data: { filingId: a.id }, opts: { singletonKey: a.id } },
    ])
    expect((await w.filings.listRunningFilings()).map((f) => f.id)).toEqual([c.id])

    await w.run(a.id)

    expect(filing(w, a.id)).toMatchObject({ status: "submitted", mailThreadId: threadId })
    expect(w.mailer.calls).toBe(0)
  })
})
