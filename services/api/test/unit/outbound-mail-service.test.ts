import { describe, it, expect } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import type { Mailer, OutboundAttachment, SentMail } from "@civfix/shared/interfaces"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import {
  assertOutboundSendPolicy,
  base64Bytes,
  inflightWindowSeconds,
  maxOutboundSendDeadlineMs,
  outboundSendDeadlineMs,
  OUTBOUND_SEND_MAX_DEADLINE_MS,
  ROUTE_DEADLINE_INFLIGHT_SECONDS,
} from "../../src/services/admin/outbound-send-policy.js"
import {
  isOutboundSendDeadlineError,
  makeOutboundMailService,
  OutboundSendDeadlineError,
  outboundPayloadBytes,
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
    return {
      filename: "photo.png",
      contentType: "image/png",
      content: new Uint8Array([1, 2, 3, 4]),
    }
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
    expect(dto?.messages[0]?.from).toBe(env?.from)
    const out = repo.messagesOf(thread.id)[0]
    expect(out?.messageId).toBe(messageId)

    expect(repo.events).toHaveLength(1)
    expect(repo.events[0]?.type).toBe("sent")
    expect(repo.events[0]?.meta).toMatchObject({
      from: `"civfix Reports" <report-${thread.threadToken}@civfix.org>`,
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
    expect(dto?.messages[0]?.from).toMatch(REPLY_FROM_RE)

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
      from: `"civfix" <reply-${thread.threadToken}@civfix.org>`,
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
    const thread = await svc.compose({
      to: "mayor@city.gov",
      subject: "Intro",
      body: "Hello there.",
    })
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
    await repo.insertMessage({
      threadId: t.id,
      direction: "in",
      fromAddr: "clerk@city.gov",
      body: "Q?",
    })
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

describe("OutboundMailService (F110): References chain is trimmed (root + last 9)", () => {
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

describe("OutboundMailService (F109): a delivered send never throws post-delivery", () => {
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

describe("OutboundMailService: the outbound row is a true snapshot of what was sent", () => {
  it("stores the per-thread From, the html part, the kind and the attachment metadata", async () => {
    const { repo, svc } = harness()
    const { thread } = await svc.sendReportToJurisdiction({
      reportId: "report-1",
      geoid: "0644000",
      toAddr: "clerk@lacity.gov",
      subject: "civfix report: Pothole",
      text: "A pothole on Main St.",
      html: "<p>A pothole on Main St.</p>",
      attachments: [
        {
          key: "media/r2/photo.jpg",
          filename: "photo.jpg",
          contentType: "image/jpeg",
          content: new Uint8Array([1, 2, 3]),
        },
        { filename: "keyless.jpg", contentType: "image/jpeg", content: new Uint8Array([4]) },
      ],
    })

    const stored = repo.messagesOf(thread.id)[0]
    expect(stored?.fromAddr).toBe(`"civfix Reports" <report-${thread.threadToken}@civfix.org>`)
    expect(stored?.html).toBe("<p>A pothole on Main St.</p>")
    expect(stored?.kind).toBe("packet")
    expect(stored?.attachments).toEqual([
      { key: "media/r2/photo.jpg", filename: "photo.jpg", size: 3 },
    ])
  })

  it("stamps the kind each entry point owns", async () => {
    const { repo, svc } = harness()
    const digest = await svc.sendToCity({
      geoid: "0644000",
      toAddr: "clerk@lacity.gov",
      subject: "Digest",
      body: "d",
    })
    const composed = await svc.compose({ to: "mayor@city.gov", subject: "Intro", body: "hi" })
    await svc.appendOutbound(composed.id, { toAddr: "mayor@city.gov", body: "again" })
    await svc.appendOutbound(composed.id, {
      toAddr: "mayor@city.gov",
      body: "again",
      kind: "resend",
    })
    const event = await svc.sendEventToJurisdiction({
      cleanupId: "cleanup-1",
      geoid: "0644000",
      toAddr: "parks@lacity.gov",
      subject: "Cleanup",
      text: "e",
    })

    expect(repo.messagesOf(digest.id).map((m) => m.kind)).toEqual(["digest"])
    expect(repo.messagesOf(composed.id).map((m) => m.kind)).toEqual(["compose", "reply", "resend"])
    expect(repo.messagesOf(event.thread.id).map((m) => m.kind)).toEqual(["packet"])
  })

  it("refreshes the thread subject when a re-route carries a new one", async () => {
    const { repo, svc } = harness()
    const first = await svc.sendReportToJurisdiction({
      reportId: "report-1",
      geoid: "0644000",
      toAddr: "clerk@lacity.gov",
      subject: "civfix report: Pothole",
      text: "one",
    })
    await svc.sendReportToJurisdiction({
      reportId: "report-1",
      geoid: "0644000",
      toAddr: "clerk@lacity.gov",
      subject: "civfix report: Pothole [ref-2]",
      text: "two",
    })
    expect((await repo.getThreadRecord(first.thread.id))?.subject).toBe(
      "civfix report: Pothole [ref-2]",
    )
  })
})

describe("OutboundMailService: a failed send is recorded as a failure", () => {
  it("flips the thread to needs_action and audits mail.send_failed with the report id", async () => {
    const repo = new InMemoryMailRepository()
    const mailer = new FakeMailer()
    mailer.sendOutbound = () => Promise.reject(new Error("smtp down"))
    const svc = makeOutboundMailService({ repo, mailer, env: ENV })

    await expect(
      svc.sendReportToJurisdiction({
        reportId: "report-1",
        geoid: "0644000",
        toAddr: "clerk@lacity.gov",
        subject: "Pothole",
        text: "packet",
      }),
    ).rejects.toThrow(/smtp down/)

    const thread = [...repo.threads.values()][0]
    expect(thread?.status).toBe("needs_action")
    const failed = repo.events.find((e) => e.type === "failed")
    expect(failed?.meta).toMatchObject({
      from: `"civfix Reports" <report-${thread?.threadToken}@civfix.org>`,
      to: "clerk@lacity.gov",
      error: "smtp down",
      reportId: "report-1",
    })
    expect(repo.audits.at(-1)).toMatchObject({
      actorId: null,
      action: "mail.send_failed",
      target: "report:report-1",
      meta: { to: "clerk@lacity.gov", reportId: "report-1", error: "smtp down" },
    })
  })

  it("a successful re-route clears the needs_action a failed send left behind", async () => {
    const repo = new InMemoryMailRepository()
    const mailer = new FakeMailer()
    mailer.sendOutbound = () => Promise.reject(new Error("smtp down"))
    const svc = makeOutboundMailService({ repo, mailer, env: ENV, logger: { warn: () => {} } })
    const input = {
      reportId: "report-1",
      geoid: "0644000",
      toAddr: "clerk@lacity.gov",
      subject: "Pothole",
      text: "packet",
    }
    await expect(svc.sendReportToJurisdiction(input)).rejects.toThrow(/smtp down/)
    const thread = [...repo.threads.values()][0]
    expect(thread?.status).toBe("needs_action")

    mailer.sendOutbound = FakeMailer.prototype.sendOutbound.bind(mailer)
    await svc.sendReportToJurisdiction(input)

    expect(repo.threads.get(thread?.id ?? "")?.status).toBe("sent")
  })

  it("a successful resend clears needs_action on a composed thread too", async () => {
    const repo = new InMemoryMailRepository()
    const mailer = new FakeMailer()
    mailer.sendOutbound = () => Promise.reject(new Error("smtp down"))
    const svc = makeOutboundMailService({ repo, mailer, env: ENV, logger: { warn: () => {} } })
    const t = await repo.createThread({ subject: "S" })
    await expect(svc.appendOutbound(t.id, { toAddr: "x@y.com", body: "b" })).rejects.toThrow(
      /smtp down/,
    )
    expect(repo.threads.get(t.id)?.status).toBe("needs_action")

    mailer.sendOutbound = FakeMailer.prototype.sendOutbound.bind(mailer)
    await svc.appendOutbound(t.id, { toAddr: "x@y.com", body: "b", kind: "resend" })

    expect(repo.threads.get(t.id)?.status).toBe("sent")
  })

  it("writes no audit row when the failed send carries no report", async () => {
    const repo = new InMemoryMailRepository()
    const mailer = new FakeMailer()
    mailer.sendOutbound = () => Promise.reject(new Error("smtp down"))
    const svc = makeOutboundMailService({ repo, mailer, env: ENV })
    const t = await repo.createThread({ subject: "S" })
    await expect(svc.appendOutbound(t.id, { toAddr: "x@y.com", body: "b" })).rejects.toThrow(
      /smtp down/,
    )
    expect(repo.threads.get(t.id)?.status).toBe("needs_action")
    expect(repo.audits).toHaveLength(0)
  })
})

describe("OutboundMailService: total send deadline", () => {
  function deferredMailer(): {
    mailer: Mailer
    resolve: (messageId: string) => void
    reject: (err: unknown) => void
  } {
    let resolve!: (messageId: string) => void
    let reject!: (err: unknown) => void
    const pending = new Promise<SentMail>((res, rej) => {
      resolve = (messageId: string) => res({ messageId })
      reject = rej
    })
    return {
      resolve,
      reject,
      mailer: {
        sendOtp: () => Promise.resolve(),
        sendTransactional: () => Promise.resolve(),
        sendOutbound: () => pending,
      },
    }
  }

  function svcFor(mailer: Mailer, repo: InMemoryMailRepository, deadlineMs: number) {
    return makeOutboundMailService({
      repo,
      mailer,
      env: ENV,
      logger: { warn: () => {} },
      sendDeadlineMs: deadlineMs,
    })
  }

  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

  it("records 'failed' with reason=deadline when the send outlives its budget", async () => {
    const repo = new InMemoryMailRepository()
    const { mailer } = deferredMailer()
    const svc = svcFor(mailer, repo, 20)

    await expect(
      svc.sendReportToJurisdiction({
        reportId: "11111111-1111-1111-1111-111111111111",
        geoid: "0644000",
        toAddr: "pw@lacity.gov",
        subject: "Pothole",
        text: "packet",
      }),
    ).rejects.toSatisfy(isOutboundSendDeadlineError)

    const failed = repo.events.filter((e) => e.type === "failed")
    expect(failed).toHaveLength(1)
    expect(failed[0]?.meta).toMatchObject({ reason: "deadline", deadlineMs: 20 })
    expect(repo.events.some((e) => e.type === "sent")).toBe(false)
  })

  it("a LATE success records 'sent' (marked late) with the real Message-ID, clearing send_failed", async () => {
    const repo = new InMemoryMailRepository()
    const { mailer, resolve } = deferredMailer()
    const svc = svcFor(mailer, repo, 20)

    await expect(
      svc.sendReportToJurisdiction({
        reportId: "22222222-2222-2222-2222-222222222222",
        geoid: "0644000",
        toAddr: "pw@lacity.gov",
        subject: "Pothole",
        text: "packet",
      }),
    ).rejects.toSatisfy(isOutboundSendDeadlineError)

    expect(repo.events.map((e) => e.type)).toEqual(["failed"])

    resolve("<real-250-ok@oci>")
    await flush()

    expect(repo.events.map((e) => e.type)).toEqual(["failed", "sent"])
    const sentEvent = repo.events.find((e) => e.type === "sent")
    expect(sentEvent?.meta).toMatchObject({ late: true })
    expect(repo.events.some((e) => e.type === "sent")).toBe(true)
    const stored = repo.messages.find((m) => m.direction === "out")
    expect(stored?.messageId).toBe("<real-250-ok@oci>")
  })

  it("a LATE rejection leaves the recorded 'failed' standing and raises no unhandled rejection", async () => {
    const repo = new InMemoryMailRepository()
    const { mailer, reject } = deferredMailer()
    const svc = svcFor(mailer, repo, 20)

    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err)
    }
    process.on("unhandledRejection", onUnhandled)
    try {
      await expect(
        svc.sendReportToJurisdiction({
          reportId: "33333333-3333-3333-3333-333333333333",
          geoid: "0644000",
          toAddr: "pw@lacity.gov",
          subject: "Pothole",
          text: "packet",
        }),
      ).rejects.toSatisfy(isOutboundSendDeadlineError)

      reject(new Error("550 rejected"))
      await flush()
      await flush()
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }

    expect(repo.events.map((e) => e.type)).toEqual(["failed"])
    expect(unhandled).toHaveLength(0)
  })

  it("runs the caller's late-success continuation after recording the late 'sent'", async () => {
    const repo = new InMemoryMailRepository()
    const { mailer, resolve } = deferredMailer()
    const svc = svcFor(mailer, repo, 20)
    const ran: string[] = []

    const prepared = await svc.prepareReportToJurisdiction({
      reportId: "66666666-6666-6666-6666-666666666666",
      geoid: "0644000",
      toAddr: "pw@lacity.gov",
      subject: "Pothole",
      text: "packet",
    })
    await expect(
      prepared.deliver({
        onLateSuccess: async () => {
          ran.push("route-outcome")
          await Promise.resolve()
        },
      }),
    ).rejects.toSatisfy(isOutboundSendDeadlineError)

    expect(ran).toHaveLength(0)

    resolve("<late-ok@oci>")
    await flush()

    expect(ran).toEqual(["route-outcome"])
    expect(repo.events.map((e) => e.type)).toEqual(["failed", "sent"])
  })

  it("a LATE success restores the thread the deadline flipped to needs_action", async () => {
    const repo = new InMemoryMailRepository()
    const { mailer, resolve } = deferredMailer()
    const svc = svcFor(mailer, repo, 20)

    await expect(
      svc.sendReportToJurisdiction({
        reportId: "77777777-7777-7777-7777-777777777777",
        geoid: "0644000",
        toAddr: "pw@lacity.gov",
        subject: "Pothole",
        text: "packet",
      }),
    ).rejects.toSatisfy(isOutboundSendDeadlineError)
    const thread = [...repo.threads.values()][0]
    expect(thread?.status).toBe("needs_action")

    resolve("<late-ok@oci>")
    await flush()

    expect(repo.threads.get(thread?.id ?? "")?.status).toBe("sent")
  })

  it("a success landing BEFORE the failure write commits still leaves the thread sent", async () => {
    const repo = new InMemoryMailRepository()
    let releaseFailure!: () => void
    const failureWritten = new Promise<void>((res) => {
      releaseFailure = res
    })
    const recordSendFailure = repo.recordSendFailure.bind(repo)
    repo.recordSendFailure = async (input) => {
      await failureWritten
      await recordSendFailure(input)
    }
    const { mailer, resolve } = deferredMailer()
    const svc = svcFor(mailer, repo, 20)

    const send = svc.sendReportToJurisdiction({
      reportId: "99999999-9999-9999-9999-999999999999",
      geoid: "0644000",
      toAddr: "pw@lacity.gov",
      subject: "Pothole",
      text: "packet",
    })
    await new Promise((r) => setTimeout(r, 40))
    resolve("<raced-ok@oci>")
    await flush()
    releaseFailure()
    await expect(send).rejects.toSatisfy(isOutboundSendDeadlineError)
    await flush()
    await flush()

    const thread = [...repo.threads.values()][0]
    expect(repo.events.map((e) => e.type)).toEqual(["failed", "sent"])
    expect(repo.threads.get(thread?.id ?? "")?.status).toBe("sent")
  })

  it("leaves a status that is not a delivery failure alone on a late success", async () => {
    const repo = new InMemoryMailRepository()
    const { mailer, resolve } = deferredMailer()
    const svc = svcFor(mailer, repo, 20)

    await expect(
      svc.sendReportToJurisdiction({
        reportId: "88888888-8888-8888-8888-888888888888",
        geoid: "0644000",
        toAddr: "pw@lacity.gov",
        subject: "Pothole",
        text: "packet",
      }),
    ).rejects.toSatisfy(isOutboundSendDeadlineError)
    const thread = [...repo.threads.values()][0]
    await repo.setThreadStatus(thread?.id ?? "", "replied")

    resolve("<late-ok@oci>")
    await flush()

    expect(repo.threads.get(thread?.id ?? "")?.status).toBe("replied")
  })

  it("a deadline expiry is a CONFLICT for the operator, not a 500", async () => {
    const err = new OutboundSendDeadlineError(30_000)
    expect(err.httpStatus).toBe(409)
    expect(err.message.toLowerCase()).toContain("still in progress")
    expect(isOutboundSendDeadlineError(err)).toBe(true)
  })

  it("the deadline SCALES with the payload rather than being flat", () => {
    const phaseBudgetMs = 45_000
    const minThroughputBytesPerSec = 256 * 1024

    const empty = outboundSendDeadlineMs({ bytes: 0, phaseBudgetMs, minThroughputBytesPerSec })
    const oneMiB = outboundSendDeadlineMs({
      bytes: 1024 * 1024,
      phaseBudgetMs,
      minThroughputBytesPerSec,
    })
    const eightMiB = outboundSendDeadlineMs({
      bytes: 8 * 1024 * 1024,
      phaseBudgetMs,
      minThroughputBytesPerSec,
    })

    expect(empty).toBe(phaseBudgetMs)
    expect(oneMiB).toBe(phaseBudgetMs + 4_000)
    expect(eightMiB).toBe(phaseBudgetMs + 32_000)
    expect(eightMiB).toBeGreaterThan(oneMiB)
  })

  it("payload bytes count the text, the html part and attachments AS BASE64 (what goes on the wire)", () => {
    expect(outboundPayloadBytes({ body: "abc" })).toBe(3)
    expect(outboundPayloadBytes({ body: "abc", html: "<p>de</p>" })).toBe(3 + 9)
    expect(
      outboundPayloadBytes({
        body: "abc",
        attachments: [
          { filename: "a.jpg", contentType: "image/jpeg", content: new Uint8Array(1000) },
          { filename: "b.jpg", contentType: "image/jpeg", content: new Uint8Array(2000) },
        ],
      }),
    ).toBe(3 + base64Bytes(3000))
    expect(base64Bytes(3000)).toBe(4000)
  })

  describe("send-deadline / in-flight-window invariant", () => {
    const DEFAULTS = { smtpTimeoutMs: 15_000, minThroughputBytesPerSec: 256 * 1024 }

    it("the largest computable deadline at defaults fits inside the in-flight window", () => {
      const maxMs = maxOutboundSendDeadlineMs(DEFAULTS)
      expect(maxMs).toBeLessThan(ROUTE_DEADLINE_INFLIGHT_SECONDS * 1000)
      expect(inflightWindowSeconds(DEFAULTS)).toBeLessThanOrEqual(ROUTE_DEADLINE_INFLIGHT_SECONDS)
      expect(ROUTE_DEADLINE_INFLIGHT_SECONDS).toBeGreaterThanOrEqual(900)
    })

    it("accepts the default configuration", () => {
      expect(assertOutboundSendPolicy(DEFAULTS)).toEqual([])
    })

    it("REJECTS a throughput floor below the minimum", () => {
      const errs = assertOutboundSendPolicy({ ...DEFAULTS, minThroughputBytesPerSec: 48 })
      expect(errs).toHaveLength(1)
      expect(errs[0]).toContain("OUTBOUND_SEND_MIN_THROUGHPUT_BPS")
    })

    it("REJECTS an SMTP timeout above the ceiling", () => {
      const errs = assertOutboundSendPolicy({ ...DEFAULTS, smtpTimeoutMs: 300_000 })
      expect(errs).toHaveLength(1)
      expect(errs[0]).toContain("OCI_EMAIL_SMTP_TIMEOUT_MS")
    })

    it("REJECTS an in-range combination whose largest deadline still outlives the window", () => {
      const errs = assertOutboundSendPolicy({
        smtpTimeoutMs: 60_000,
        minThroughputBytesPerSec: 16 * 1024,
      })
      expect(errs).toHaveLength(1)
      expect(errs[0]).toContain("in-flight guard")
    })

    it("never produces a deadline that overflows setTimeout's 32-bit range", () => {
      const absurd = outboundSendDeadlineMs({
        bytes: Number.MAX_SAFE_INTEGER,
        phaseBudgetMs: 45_000,
        minThroughputBytesPerSec: 1,
      })
      expect(absurd).toBe(OUTBOUND_SEND_MAX_DEADLINE_MS)
      expect(absurd).toBeLessThanOrEqual(2 ** 31 - 1)
    })
  })

  it("a large packet is NOT failed by a budget sized for a small one", async () => {
    const repo = new InMemoryMailRepository()
    const mailer = new FakeMailer()
    const svc = makeOutboundMailService({
      repo,
      mailer,
      env: ENV,
      sendPhaseBudgetMs: 50,
      sendMinThroughputBytesPerSec: 1024,
    })

    await svc.sendReportToJurisdiction({
      reportId: "44444444-4444-4444-4444-444444444444",
      geoid: "0644000",
      toAddr: "pw@lacity.gov",
      subject: "Pothole",
      text: "x".repeat(64 * 1024),
    })

    expect(repo.events.some((e) => e.type === "sent")).toBe(true)
    expect(repo.events.some((e) => e.type === "failed")).toBe(false)
  })

  it("a send that completes inside the deadline is unaffected", async () => {
    const repo = new InMemoryMailRepository()
    const mailer = new FakeMailer()
    const svc = svcFor(mailer, repo, 5_000)

    await svc.sendReportToJurisdiction({
      reportId: "55555555-5555-5555-5555-555555555555",
      geoid: "0644000",
      toAddr: "pw@lacity.gov",
      subject: "Pothole",
      text: "packet",
    })

    expect(repo.events.some((e) => e.type === "sent")).toBe(true)
    expect(repo.events.some((e) => e.type === "failed")).toBe(false)
  })
})
