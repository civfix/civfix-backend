import { describe, it, expect, vi } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { makeOutboundMailService } from "../../src/services/admin/outbound-mail-service.js"
import {
  makeMailService,
  resolveCorrespondent,
  latestOutbound,
  type MailService,
} from "../../src/services/admin/mail-service.js"


const FROM_OUTREACH = "outreach@civfix.org"

interface Harness {
  repo: InMemoryMailRepository
  mailer: FakeMailer
  svc: MailService
}

function harness(): Harness {
  const repo = new InMemoryMailRepository()
  const mailer = new FakeMailer()
  const outboundMail = makeOutboundMailService({
    repo,
    mailer,
    env: { MAIL_FROM_OUTREACH: FROM_OUTREACH, MAIL_REPLY_DOMAIN: "civfix.org" },
  })
  const svc = makeMailService({ repo, outboundMail, fromOutreach: FROM_OUTREACH })
  return { repo, mailer, svc }
}

describe("mail-service recipient-resolution helpers", () => {
  it("resolveCorrespondent picks the latest non-civfix from address, else null", () => {
    expect(resolveCorrespondent([], FROM_OUTREACH)).toBeNull()
    const msgs = [
      { id: "a", who: "civfix", from: FROM_OUTREACH, to: "clerk@city.gov", dir: "out" as const, body: "hi", ts: "t", attachments: [] },
      { id: "b", who: "clerk", from: "clerk@city.gov", to: "", dir: "in" as const, body: "re", ts: "t", attachments: [] },
      { id: "c", who: "civfix", from: FROM_OUTREACH, to: "clerk@city.gov", dir: "out" as const, body: "ok", ts: "t", attachments: [] },
    ]
    expect(resolveCorrespondent(msgs, FROM_OUTREACH)).toBe("clerk@city.gov")
    expect(resolveCorrespondent(msgs, "OUTREACH@CIVFIX.ORG")).toBe("clerk@city.gov")
  })

  it("latestOutbound returns the newest out message, else null", () => {
    expect(latestOutbound([])).toBeNull()
    const msgs = [
      { id: "a", who: "civfix", from: FROM_OUTREACH, to: "clerk@city.gov", dir: "out" as const, body: "first", ts: "t", attachments: [] },
      { id: "b", who: "clerk", from: "clerk@city.gov", to: "", dir: "in" as const, body: "re", ts: "t", attachments: [] },
      { id: "c", who: "civfix", from: FROM_OUTREACH, to: "clerk@city.gov", dir: "out" as const, body: "last", ts: "t", attachments: [] },
    ]
    expect(latestOutbound(msgs)?.body).toBe("last")
  })
})

describe("mail-service: list + getThread", () => {
  it("lists threads newest-first and reads a thread + messages, 404 on unknown", async () => {
    const { repo, svc } = harness()
    const t = await repo.createThread({ subject: "Pothole", org: "City of LA", jurisdictionGeoid: "0644000" })
    await repo.insertMessage({ threadId: t.id, direction: "out", fromAddr: FROM_OUTREACH, body: "please review" })

    const page = await svc.list({})
    expect(page.items.map((i) => i.id)).toEqual([t.id])

    const dto = await svc.getThread(t.id)
    expect(dto.subject).toBe("Pothole")
    expect(dto.messages).toHaveLength(1)

    await expect(svc.getThread("missing")).rejects.toMatchObject({ httpStatus: 404 })
  })

  it("passes through the dir / attn / geoid / q filters", async () => {
    const { repo, svc } = harness()
    const la = await repo.createThread({ subject: "Trash", org: "City of LA", jurisdictionGeoid: "0644000" })
    await repo.insertMessage({ threadId: la.id, direction: "out", fromAddr: FROM_OUTREACH, body: "x" })
    const sf = await repo.createThread({ subject: "Graffiti", org: "City of SF", jurisdictionGeoid: "0667000" })
    await repo.insertMessage({ threadId: sf.id, direction: "in", fromAddr: "clerk@sf.gov", body: "y" })

    expect((await svc.list({ dir: "in" })).items.map((i) => i.id)).toEqual([sf.id])
    expect((await svc.list({ geoid: "0644000" })).items.map((i) => i.id)).toEqual([la.id])
    expect((await svc.list({ q: "graffiti" })).items.map((i) => i.id)).toEqual([sf.id])
    expect((await svc.list({ filter: "attn" })).items.map((i) => i.id)).toEqual([sf.id])
  })
})

describe("mail-service: compose", () => {
  it("creates a new outbound thread, delivers From outreach, records a 'sent' event", async () => {
    const { repo, mailer, svc } = harness()
    const thread = await svc.compose(
      { to: "mayor@city.gov", subject: "Intro", body: "Hello." },
      "op-1",
    )
    expect(repo.threads.size).toBe(1)
    const dto = await repo.getThread(thread.id)
    expect(dto?.messages).toHaveLength(1)
    expect(dto?.messages[0]?.dir).toBe("out")
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0]?.to).toBe("mayor@city.gov")
    expect(mailer.sent[0]?.outbound?.from).toMatch(/^"civfix" <reply-[a-z2-7]{12}@civfix\.org>$/)
    expect(mailer.sent[0]?.outbound?.replyTo).toBeUndefined()
    expect(repo.events[0]?.type).toBe("sent")
    expect(repo.audits.at(-1)).toMatchObject({
      actorId: "op-1",
      action: "mail.sent",
      target: `mail:${thread.id}`,
    })
  })
})

describe("mail-service: reply", () => {
  it("appends an OUT reply to the resolved correspondent, delivers, marks replied + read", async () => {
    const { repo, mailer, svc } = harness()
    const t = await repo.createThread({ subject: "Question", org: "City of LA" })
    await repo.insertMessage({ threadId: t.id, direction: "in", fromAddr: "clerk@city.gov", body: "Q?" })
    expect((await repo.getThreadRecord(t.id))?.unread).toBe(true)

    const updated = await svc.reply(t.id, { body: "Here is the answer." }, "op-1")
    expect(updated.status).toBe("replied")
    expect(updated.unread).toBe(false)
    const dto = await repo.getThread(t.id)
    expect(dto?.messages).toHaveLength(2)
    expect(dto?.messages[1]?.dir).toBe("out")
    expect(dto?.messages[1]?.body).toBe("Here is the answer.")
    expect(mailer.sent[0]?.to).toBe("clerk@city.gov")
    expect(mailer.sent[0]?.outbound?.from).toMatch(/^"civfix" <reply-[a-z2-7]{12}@civfix\.org>$/)
    expect(repo.audits.at(-1)).toMatchObject({ action: "mail.replied", target: `mail:${t.id}` })
  })

  it("M1: replies to a composed outbound-only thread using the stored OUT to_addr", async () => {
    const { repo, mailer, svc } = harness()
    const t = await repo.createThread({ subject: "Intro" })
    await repo.insertMessage({
      threadId: t.id,
      direction: "out",
      fromAddr: FROM_OUTREACH,
      toAddr: "mayor@city.gov",
      body: "Hello.",
    })
    const updated = await svc.reply(t.id, { body: "Following up." }, "op-1")
    expect(updated.status).toBe("replied")
    expect(mailer.sent.at(-1)?.to).toBe("mayor@city.gov")
  })

  it("F025: resolves the recipient through the point reads, not by loading every body in the thread", async () => {
    const { repo, mailer, svc } = harness()
    const t = await repo.createThread({ subject: "Question", org: "City of LA" })
    await repo.insertMessage({ threadId: t.id, direction: "in", fromAddr: "clerk@city.gov", body: "Q?" })
    const getThread = vi.spyOn(repo, "getThread")
    const lastInbound = vi.spyOn(repo, "getLastInboundSender")

    await svc.reply(t.id, { body: "Here is the answer." }, "op-1")

    expect(mailer.sent.at(-1)?.to).toBe("clerk@city.gov")
    expect(lastInbound).toHaveBeenCalledWith(t.id)
    expect(getThread).toHaveBeenCalledTimes(1)
  })

  it("404s an unknown thread and 422s a thread with no recipient at all to reply to", async () => {
    const { repo, svc } = harness()
    await expect(svc.reply("missing", { body: "b" }, "op-1")).rejects.toMatchObject({
      httpStatus: 404,
    })
    const t = await repo.createThread({ subject: "S" })
    await repo.insertMessage({ threadId: t.id, direction: "out", fromAddr: FROM_OUTREACH, body: "hi" })
    await expect(svc.reply(t.id, { body: "b" }, "op-1")).rejects.toMatchObject({ httpStatus: 422 })
  })
})

describe("mail-service: markRead + setStatus", () => {
  it("clears unread and 404s an unknown thread", async () => {
    const { repo, svc } = harness()
    const t = await repo.createThread({ subject: "S", unread: true })
    await svc.markRead(t.id)
    expect((await repo.getThreadRecord(t.id))?.unread).toBe(false)
    await expect(svc.markRead("missing")).rejects.toMatchObject({ httpStatus: 404 })
  })

  it("sets status, audits in-tx, and 404s an unknown thread", async () => {
    const { repo, svc } = harness()
    const t = await repo.createThread({ subject: "S" })
    await svc.setStatus(t.id, "needs_action", "op-1")
    expect((await repo.getThreadRecord(t.id))?.status).toBe("needs_action")
    expect(repo.audits.at(-1)).toMatchObject({
      action: "mail.status_changed",
      target: `mail:${t.id}`,
      meta: { status: "needs_action" },
    })
    await expect(svc.setStatus("missing", "bounced", "op-1")).rejects.toMatchObject({
      httpStatus: 404,
    })
  })
})

describe("mail-service: resend", () => {
  it("re-delivers the latest outbound body as a fresh OUT message to the correspondent", async () => {
    const { repo, mailer, svc } = harness()
    const t = await repo.createThread({ subject: "Follow-up", org: "City of LA" })
    await repo.insertMessage({ threadId: t.id, direction: "in", fromAddr: "clerk@city.gov", body: "Q?" })
    await repo.insertMessage({
      threadId: t.id,
      direction: "out",
      fromAddr: FROM_OUTREACH,
      toAddr: "clerk@city.gov",
      body: "original outbound",
    })

    await svc.resend(t.id, "op-1")
    const dto = await repo.getThread(t.id)
    expect(dto?.messages).toHaveLength(3)
    expect(dto?.messages[2]?.dir).toBe("out")
    expect(dto?.messages[2]?.body).toBe("original outbound")
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0]?.to).toBe("clerk@city.gov")
    expect(repo.events[0]?.type).toBe("sent")
    expect(repo.audits.at(-1)).toMatchObject({ action: "mail.resent", target: `mail:${t.id}` })
  })

  it("M1: resends a composed outbound-only thread using the stored OUT to_addr", async () => {
    const { repo, mailer, svc } = harness()
    const t = await repo.createThread({ subject: "Intro" })
    await repo.insertMessage({
      threadId: t.id,
      direction: "out",
      fromAddr: FROM_OUTREACH,
      toAddr: "mayor@city.gov",
      body: "Hello.",
    })
    await svc.resend(t.id, "op-1")
    expect(mailer.sent.at(-1)?.to).toBe("mayor@city.gov")
  })

  it("404s an unknown thread and 422s a thread with no outbound message to resend", async () => {
    const { repo, svc } = harness()
    await expect(svc.resend("missing", "op-1")).rejects.toMatchObject({ httpStatus: 404 })
    const t = await repo.createThread({ subject: "S" })
    await repo.insertMessage({ threadId: t.id, direction: "in", fromAddr: "clerk@city.gov", body: "Q?" })
    await expect(svc.resend(t.id, "op-1")).rejects.toMatchObject({ httpStatus: 422 })
  })
})

describe("mail-service: stats", () => {
  it("passes through the repository's rolling-window measured stats", async () => {
    const { repo, svc } = harness()
    repo.now = new Date("2026-03-10T00:00:00.000Z")
    await repo.createThread({ subject: "A", unread: true })
    repo.seedEvent({ type: "sent", createdAt: new Date("2026-03-09T00:00:00.000Z") })
    repo.seedEvent({ type: "bounced", createdAt: new Date("2026-03-09T00:00:00.000Z") })
    const stats = await svc.stats()
    expect(stats.sent).toBe(1)
    expect(stats.bounced).toBe(1)
    expect(stats.threads).toBe(1)
    expect(stats.unread).toBe(1)
  })
})
