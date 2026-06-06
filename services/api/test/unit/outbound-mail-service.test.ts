import { describe, it, expect } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import {
  makeOutboundMailService,
  OUTBOUND_MAIL_TEMPLATE,
  type OutboundMailEnv,
  type OutboundMailService,
} from "../../src/services/admin/outbound-mail-service.js"

/**
 * Offline unit tests for the OutboundMailService over the in-memory MailRepository + FakeMailer (no DB,
 * no SMTP). They prove the API the reports/events agent and the mail agent import: sendToCity / compose
 * / appendOutbound each (1) deliver via the Mailer From MAIL_FROM_OUTREACH, (2) persist an OUT message,
 * (3) record a 'sent' mail_events row, and (4) mint a reply+{token}@{MAIL_REPLY_DOMAIN} reply-to.
 */

const ENV: OutboundMailEnv = {
  MAIL_FROM_OUTREACH: "outreach@civfix.org",
  MAIL_REPLY_DOMAIN: "civfix.org",
}

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

describe("OutboundMailService.mintReplyAddress", () => {
  it("mints reply+{token}@{MAIL_REPLY_DOMAIN}", () => {
    const { svc } = harness()
    expect(svc.mintReplyAddress("abc123")).toBe("reply+abc123@civfix.org")
  })
})

describe("OutboundMailService.sendToCity", () => {
  it("threads by jurisdiction, sends From outreach, records a 'sent' event, returns the thread", async () => {
    const { repo, mailer, svc } = harness()
    const thread = await svc.sendToCity({
      geoid: "0644000",
      toAddr: "clerk@city.gov",
      subject: "Pothole follow-up",
      body: "Any update on report 42?",
      reportContext: { reportId: "42" },
      org: "City of LA",
    })
    // The thread is keyed by a deterministic per-geoid token (rolling conversation).
    expect(thread.threadToken).toBe("geo-0644000")
    expect(thread.jurisdictionGeoid).toBe("0644000")
    expect(thread.lastMessageAt).not.toBeNull()
    // One OUT message persisted, From outreach.
    const dto = await repo.getThread(thread.id)
    expect(dto?.messages).toHaveLength(1)
    expect(dto?.messages[0]?.dir).toBe("out")
    expect(dto?.messages[0]?.from).toBe("outreach@civfix.org")
    // The mailer was called with the generic template + the From + reply-to in vars.
    expect(mailer.sent).toHaveLength(1)
    const sent = mailer.sent[0]!
    expect(sent.to).toBe("clerk@city.gov")
    expect(sent.template).toBe(OUTBOUND_MAIL_TEMPLATE)
    expect(sent.vars?.from).toBe("outreach@civfix.org")
    expect(sent.vars?.replyTo).toBe("reply+geo-0644000@civfix.org")
    expect(sent.vars?.subject).toBe("Pothole follow-up")
    // A 'sent' event was recorded with the report context + recipient.
    expect(repo.events).toHaveLength(1)
    expect(repo.events[0]?.type).toBe("sent")
    expect(repo.events[0]?.meta).toMatchObject({
      from: "outreach@civfix.org",
      to: "clerk@city.gov",
      reportId: "42",
      geoid: "0644000",
    })
  })

  it("appends a second follow-up to the SAME jurisdiction thread", async () => {
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

  it("creates a fresh thread when there is no geoid", async () => {
    const { repo, svc } = harness()
    await svc.sendToCity({ toAddr: "a@x.com", subject: "S", body: "b" })
    await svc.sendToCity({ toAddr: "a@x.com", subject: "S", body: "b" })
    expect(repo.threads.size).toBe(2)
  })
})

describe("OutboundMailService.compose", () => {
  it("creates a new outbound thread + first message + sends From outreach", async () => {
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
    expect(mailer.sent[0]?.to).toBe("mayor@city.gov")
    expect(mailer.sent[0]?.vars?.from).toBe("outreach@civfix.org")
    expect(repo.events[0]?.type).toBe("sent")
  })
})

describe("OutboundMailService.appendOutbound", () => {
  it("appends an OUT reply to an existing thread, defaulting the subject to Re:", async () => {
    const { repo, mailer, svc } = harness()
    // Seed an inbound thread (a city wrote in) to reply to.
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
    // The outbound message subject defaulted to "Re: Question".
    expect(repo.messagesOf(t.id)[1]?.subject).toBe("Re: Question")
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0]?.vars?.from).toBe("outreach@civfix.org")
    expect(repo.events[0]?.type).toBe("sent")
  })

  it("honors an explicit subject override", async () => {
    const { repo, svc } = harness()
    const t = await repo.createThread({ subject: "Original" })
    await svc.appendOutbound(t.id, { toAddr: "x@y.com", body: "body", subject: "Custom" })
    expect(repo.messagesOf(t.id)[0]?.subject).toBe("Custom")
  })

  it("throws for an unknown thread id", async () => {
    const { svc } = harness()
    await expect(svc.appendOutbound("missing", { toAddr: "x@y.com", body: "b" })).rejects.toThrow(
      /not found/,
    )
  })

  it("propagates a Mailer failure WITHOUT recording a 'sent' event", async () => {
    const repo = new InMemoryMailRepository()
    // A mailer whose send rejects.
    const mailer = new FakeMailer()
    mailer.sendTransactional = () => Promise.reject(new Error("smtp down"))
    const svc = makeOutboundMailService({ repo, mailer, env: ENV })
    const t = await repo.createThread({ subject: "S" })
    await expect(svc.appendOutbound(t.id, { toAddr: "x@y.com", body: "b" })).rejects.toThrow(
      /smtp down/,
    )
    // The message was persisted (insert precedes delivery) but NO 'sent' event was recorded.
    expect(repo.messagesOf(t.id)).toHaveLength(1)
    expect(repo.events).toHaveLength(0)
  })
})
