import { describe, it, expect } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import type { OutboundAttachment } from "@civfix/shared/interfaces"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import {
  makeOutboundMailService,
  type OutboundMailEnv,
  type OutboundMailService,
} from "../../src/services/admin/outbound-mail-service.js"


const ENV: OutboundMailEnv = {
  MAIL_FROM_OUTREACH: "outreach@civfix.org",
  MAIL_REPLY_DOMAIN: "civfix.org",
}

const REPLY_FROM_RE = /^"civfix" <reply-[a-z2-7]{12}@civfix\.org>$/
const REPORT_FROM_RE = /^"civfix Reports" <report-[a-z2-7]{12}@civfix\.org>$/
const EVENT_FROM_RE = /^"civfix Cleanups" <event-[a-z2-7]{12}@civfix\.org>$/

function harness(): {
  repo: InMemoryMailRepository
  mailer: FakeMailer
  svc: OutboundMailService
} {
  const repo = new InMemoryMailRepository()
  const mailer = new FakeMailer()
  const svc = makeOutboundMailService({ repo, mailer, env: ENV })
  return { repo, mailer, svc }
}

describe("OutboundMailService.sendReportToJurisdiction", () => {
  function png(): OutboundAttachment {
    return { filename: "photo.png", contentType: "image/png", content: new Uint8Array([1, 2, 3, 4]) }
  }

  it("sends a per-report packet via sendOutbound From the report- reply address, no Reply-To, + attachments", async () => {
    const { repo, mailer, svc } = harness()
    const attachments = [png()]
    const { thread, messageId } = await svc.sendReportToJurisdiction({
      reportId: "report-1",
      geoid: "0644000",
      org: "City of LA",
      toAddr: "clerk@lacity.gov",
      subject: "civfix report: Pothole [abcd1234]",
      text: "A pothole on Main St.",
      html: "<p>A pothole on Main St.</p>",
      attachments,
    })

    expect(thread.reportId).toBe("report-1")
    expect(thread.jurisdictionGeoid).toBe("0644000")
    expect(thread.threadToken).toMatch(/^[a-z2-7]{12}$/)

    expect(mailer.sent).toHaveLength(1)
    const env = mailer.lastOutbound()
    expect(env).toBeDefined()
    expect(env?.from).toMatch(REPORT_FROM_RE)
    expect(env?.from).toBe(`"civfix Reports" <report-${thread.threadToken}@civfix.org>`)
    expect(env?.replyTo).toBeUndefined()
    expect(env?.to).toBe("clerk@lacity.gov")
    expect(env?.subject).toBe("civfix report: Pothole [abcd1234]")
    expect(env?.html).toBe("<p>A pothole on Main St.</p>")
    expect(env?.attachments).toHaveLength(1)
    expect(env?.attachments?.[0]?.filename).toBe("photo.png")
    expect(env?.attachments?.[0]?.contentType).toBe("image/png")
    expect(messageId).toMatch(/^<out-.+@civfix\.org>$/)
    expect(env?.messageId).toBe(messageId)

    const dto = await repo.getThread(thread.id)
    expect(dto?.messages).toHaveLength(1)
    expect(dto?.messages[0]?.dir).toBe("out")
    expect(dto?.messages[0]?.from).toBe("outreach@civfix.org")
    const out = repo.messagesOf(thread.id)[0]
    expect(out?.messageId).toBe(messageId)

    expect(repo.events).toHaveLength(1)
    expect(repo.events[0]?.type).toBe("sent")
    expect(repo.events[0]?.meta).toMatchObject({
      from: "outreach@civfix.org",
      to: "clerk@lacity.gov",
      reportId: "report-1",
      geoid: "0644000",
    })
  })

  it("reuses the SAME per-report thread on a second send (find-or-create by report_id)", async () => {
    const { repo, svc } = harness()
    const first = await svc.sendReportToJurisdiction({
      reportId: "report-1",
      geoid: "0644000",
      toAddr: "clerk@lacity.gov",
      subject: "S1",
      text: "b1",
    })
    const second = await svc.sendReportToJurisdiction({
      reportId: "report-1",
      geoid: "0644000",
      toAddr: "clerk@lacity.gov",
      subject: "S2",
      text: "b2",
    })
    expect(second.thread.id).toBe(first.thread.id)
    expect(repo.threads.size).toBe(1)
    const dto = await repo.getThread(first.thread.id)
    expect(dto?.messages.map((m) => m.body)).toEqual(["b1", "b2"])
  })

  it("omits the geoid from the event meta when the report has no jurisdiction", async () => {
    const { repo, svc } = harness()
    await svc.sendReportToJurisdiction({
      reportId: "report-2",
      geoid: null,
      toAddr: "clerk@lacity.gov",
      subject: "S",
      text: "b",
    })
    expect(repo.events[0]?.meta).toMatchObject({ reportId: "report-2" })
    expect(repo.events[0]?.meta).not.toHaveProperty("geoid")
  })
})

describe("OutboundMailService.sendEventToJurisdiction (D10/D19 per-event thread)", () => {
  it("threads on the EVENT (cleanup_id), From the event- reply address, no Reply-To + 'sent' event", async () => {
    const { repo, mailer, svc } = harness()
    const { thread, messageId } = await svc.sendEventToJurisdiction({
      cleanupId: "cleanup-1",
      geoid: "0644000",
      org: "City of LA",
      toAddr: "events@lacity.gov",
      subject: "civfix event: Park Cleanup [EVENT-42-000001]",
      text: "We need 20 trash bags and gloves.",
      html: "<p>We need 20 trash bags and gloves.</p>",
    })
    expect(thread.cleanupId).toBe("cleanup-1")
    expect(thread.reportId).toBeNull()
    expect(thread.jurisdictionGeoid).toBe("0644000")
    expect(thread.threadToken).toMatch(/^[a-z2-7]{12}$/)

    expect(mailer.sent).toHaveLength(1)
    const env = mailer.lastOutbound()
    expect(env?.from).toMatch(EVENT_FROM_RE)
    expect(env?.from).toBe(`"civfix Cleanups" <event-${thread.threadToken}@civfix.org>`)
    expect(env?.replyTo).toBeUndefined()
    expect(env?.to).toBe("events@lacity.gov")
    expect(env?.html).toBe("<p>We need 20 trash bags and gloves.</p>")
    expect(messageId).toMatch(/^<out-.+@civfix\.org>$/)

    expect(repo.events).toHaveLength(1)
    expect(repo.events[0]?.type).toBe("sent")
    expect(repo.events[0]?.meta).toMatchObject({ cleanupId: "cleanup-1", geoid: "0644000" })
  })

  it("reuses the SAME per-event thread on a second send (find-or-create by cleanup_id)", async () => {
    const { repo, svc } = harness()
    const first = await svc.sendEventToJurisdiction({
      cleanupId: "cleanup-2",
      geoid: null,
      toAddr: "events@city.gov",
      subject: "S1",
      text: "b1",
    })
    const second = await svc.sendEventToJurisdiction({
      cleanupId: "cleanup-2",
      geoid: null,
      toAddr: "events@city.gov",
      subject: "S2",
      text: "b2",
    })
    expect(second.thread.id).toBe(first.thread.id)
    expect(repo.threads.size).toBe(1)
  })
})

describe("OutboundMailService threading headers (D14)", () => {
  it("sets NO In-Reply-To/References on the first message, then the chain on the second", async () => {
    const { mailer, svc } = harness()
    const first = await svc.sendReportToJurisdiction({
      reportId: "report-thr",
      geoid: "0644000",
      toAddr: "clerk@city.gov",
      subject: "S1",
      text: "b1",
    })
    const env1 = mailer.lastOutbound()
    expect(env1?.inReplyTo).toBeUndefined()
    expect(env1?.references).toBeUndefined()

    const second = await svc.sendReportToJurisdiction({
      reportId: "report-thr",
      geoid: "0644000",
      toAddr: "clerk@city.gov",
      subject: "S2",
      text: "b2",
    })
    expect(second.thread.id).toBe(first.thread.id)
    const env2 = mailer.lastOutbound()
    expect(env2?.inReplyTo).toBe(first.messageId)
    expect(env2?.references).toEqual([first.messageId])
  })
})

describe("OutboundMailService.sendToCity (digest path: minted token)", () => {
  it("threads by jurisdiction with a MINTED base32 token (not geo-{geoid}), sends From the reply- address, records 'sent'", async () => {
    const { repo, mailer, svc } = harness()
    const thread = await svc.sendToCity({
      geoid: "0644000",
      toAddr: "clerk@city.gov",
      subject: "Pothole follow-up",
      body: "Any update on report 42?",
      reportContext: { reportId: "42" },
      org: "City of LA",
    })
    expect(thread.threadToken).toMatch(/^[a-z2-7]{12}$/)
    expect(thread.threadToken).not.toMatch(/^geo-/)
    expect(thread.jurisdictionGeoid).toBe("0644000")
    expect(thread.reportId).toBeNull()
    expect(thread.lastMessageAt).not.toBeNull()

    const dto = await repo.getThread(thread.id)
    expect(dto?.messages).toHaveLength(1)
    expect(dto?.messages[0]?.dir).toBe("out")
    expect(dto?.messages[0]?.from).toBe("outreach@civfix.org")

    expect(mailer.sent).toHaveLength(1)
    const env = mailer.lastOutbound()
    expect(env?.from).toMatch(REPLY_FROM_RE)
    expect(env?.from).toBe(`"civfix" <reply-${thread.threadToken}@civfix.org>`)
    expect(env?.replyTo).toBeUndefined()
    expect(env?.to).toBe("clerk@city.gov")
    expect(env?.subject).toBe("Pothole follow-up")

    expect(repo.events).toHaveLength(1)
    expect(repo.events[0]?.type).toBe("sent")
    expect(repo.events[0]?.meta).toMatchObject({
      from: "outreach@civfix.org",
      to: "clerk@city.gov",
      reportId: "42",
      geoid: "0644000",
    })
  })

  it("appends a second follow-up to the SAME jurisdiction (digest) thread", async () => {
    const { repo, svc } = harness()
    const t1 = await svc.sendToCity({
      geoid: "0644000",
      toAddr: "clerk@city.gov",
      subject: "S1",
      body: "b1",
    })
    const t2 = await svc.sendToCity({
      geoid: "0644000",
      toAddr: "clerk@city.gov",
      subject: "S2",
      body: "b2",
    })
    expect(t2.id).toBe(t1.id)
    expect(repo.threads.size).toBe(1)
    const dto = await repo.getThread(t1.id)
    expect(dto?.messages.map((m) => m.body)).toEqual(["b1", "b2"])
  })

  it("does NOT reuse a per-report thread for the digest path (report_id IS NULL filter)", async () => {
    const { repo, svc } = harness()
    const reportThread = await svc.sendReportToJurisdiction({
      reportId: "report-9",
      geoid: "0644000",
      toAddr: "clerk@city.gov",
      subject: "report packet",
      text: "packet body",
    })
    const digest = await svc.sendToCity({
      geoid: "0644000",
      toAddr: "clerk@city.gov",
      subject: "digest",
      body: "digest body",
    })
    expect(digest.id).not.toBe(reportThread.thread.id)
    expect(digest.reportId).toBeNull()
    expect(repo.threads.size).toBe(2)
  })

  it("creates a fresh thread when there is no geoid", async () => {
    const { repo, svc } = harness()
    await svc.sendToCity({ toAddr: "a@x.com", subject: "S", body: "b" })
    await svc.sendToCity({ toAddr: "a@x.com", subject: "S", body: "b" })
    expect(repo.threads.size).toBe(2)
  })
})

describe("OutboundMailService.compose / appendOutbound", () => {
  it("compose creates a new outbound thread + first message + sends From outreach via sendOutbound", async () => {
    const { repo, mailer, svc } = harness()
    const thread = await svc.compose({ to: "mayor@city.gov", subject: "Intro", body: "Hello there." })
    expect(repo.threads.size).toBe(1)
    expect(thread.lastMessageAt).not.toBeNull()
    const dto = await repo.getThread(thread.id)
    expect(dto?.messages).toHaveLength(1)
    expect(dto?.messages[0]?.dir).toBe("out")
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.lastOutbound()?.to).toBe("mayor@city.gov")
    expect(mailer.lastOutbound()?.from).toMatch(REPLY_FROM_RE)
    expect(mailer.lastOutbound()?.replyTo).toBeUndefined()
    expect(repo.events[0]?.type).toBe("sent")
  })

  it("appendOutbound appends an OUT reply to an existing thread, defaulting the subject to Re:", async () => {
    const { repo, mailer, svc } = harness()
    const t = await repo.createThread({ subject: "Question", org: "City of LA" })
    await repo.insertMessage({ threadId: t.id, direction: "in", fromAddr: "clerk@city.gov", body: "Q?" })
    expect((await repo.getThreadRecord(t.id))?.unread).toBe(true)

    const updated = await svc.appendOutbound(t.id, {
      toAddr: "clerk@city.gov",
      body: "Here is the answer.",
    })
    expect(updated.id).toBe(t.id)
    const dto = await repo.getThread(t.id)
    expect(dto?.messages).toHaveLength(2)
    expect(dto?.messages[1]?.dir).toBe("out")
    expect(dto?.messages[1]?.body).toBe("Here is the answer.")
    expect(repo.messagesOf(t.id)[1]?.subject).toBe("Re: Question")
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.lastOutbound()?.from).toMatch(REPLY_FROM_RE)
    expect(mailer.lastOutbound()?.replyTo).toBeUndefined()
    expect(repo.events[0]?.type).toBe("sent")
  })

  it("throws for an unknown thread id", async () => {
    const { svc } = harness()
    await expect(svc.appendOutbound("missing", { toAddr: "x@y.com", body: "b" })).rejects.toThrow(
      /not found/,
    )
  })

  it("propagates a Mailer failure, recording a 'failed' event (not 'sent') (D17)", async () => {
    const repo = new InMemoryMailRepository()
    const mailer = new FakeMailer()
    mailer.sendOutbound = () => Promise.reject(new Error("smtp down"))
    const svc = makeOutboundMailService({ repo, mailer, env: ENV })
    const t = await repo.createThread({ subject: "S" })
    await expect(svc.appendOutbound(t.id, { toAddr: "x@y.com", body: "b" })).rejects.toThrow(
      /smtp down/,
    )
    expect(repo.messagesOf(t.id)).toHaveLength(1)
    expect(repo.events).toHaveLength(1)
    expect(repo.events[0]?.type).toBe("failed")
    expect(repo.events[0]?.meta).toMatchObject({ to: "x@y.com", error: "smtp down" })
    expect(repo.events.some((e) => e.type === "sent")).toBe(false)
  })
})

describe("OutboundMailService — F110: References chain is trimmed (root + last 9)", () => {
  it("emits root + the last 9 prior ids (never the unbounded middle); In-Reply-To stays the true latest", async () => {
    const { repo, mailer, svc } = harness()
    const t = repo.seedThread({ subject: "Digest" })
    for (let i = 0; i < 12; i++) {
      repo.seedMessage({ threadId: t.id, direction: "out", messageId: `<out-${i}@civfix.org>` })
    }

    await svc.appendOutbound(t.id, { toAddr: "clerk@city.gov", body: "next digest" })

    const env = mailer.lastOutbound()
    const refs = env?.references ?? []
    expect(refs).toHaveLength(10)
    expect(refs[0]).toBe("<out-0@civfix.org>")
    expect(refs).toEqual([
      "<out-0@civfix.org>",
      "<out-3@civfix.org>",
      "<out-4@civfix.org>",
      "<out-5@civfix.org>",
      "<out-6@civfix.org>",
      "<out-7@civfix.org>",
      "<out-8@civfix.org>",
      "<out-9@civfix.org>",
      "<out-10@civfix.org>",
      "<out-11@civfix.org>",
    ])
    expect(env?.inReplyTo).toBe("<out-11@civfix.org>")
  })
})

describe("OutboundMailService — F109: a delivered send never throws post-delivery", () => {
  it("swallows a thread re-read failure after delivery so the throttle window is not reopened", async () => {
    const repo = new InMemoryMailRepository()
    const mailer = new FakeMailer()
    repo.getThreadRecord = () => Promise.reject(new Error("db down"))
    const svc = makeOutboundMailService({ repo, mailer, env: ENV })

    await expect(
      svc.sendToCity({ geoid: null, toAddr: "clerk@city.gov", subject: "Digest", body: "hi" }),
    ).resolves.toBeDefined()
    expect(mailer.sent).toHaveLength(1)
  })
})
