import { describe, it, expect, vi } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import { InMemoryMailRepository } from "../helpers/admin/mail-repository.memory.js"
import type { InsertMessageInput } from "../../src/services/admin/mail-repository.js"
import { ROUTE_CLAIM_STALE_SECONDS } from "../../src/services/admin/outbound-send-policy.js"
import { makeOutboundMailService } from "../../src/services/admin/outbound-mail-service.js"
import {
  makeMailService,
  resolveCorrespondent,
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
  const svc = makeMailService({ repo, outboundMail })
  return { repo, mailer, svc }
}

async function seedDeliveredOut(
  repo: InMemoryMailRepository,
  input: Omit<InsertMessageInput, "direction">,
): Promise<void> {
  const out = await repo.insertMessage({ ...input, direction: "out" })
  await repo.recordEvent({ threadId: input.threadId, messageId: out!.id, type: "sent" })
}

describe("mail-service recipient-resolution helpers", () => {
  it("resolveCorrespondent picks the latest non-civfix from address, else null", () => {
    expect(resolveCorrespondent([], FROM_OUTREACH)).toBeNull()
    const msgs = [
      {
        id: "a",
        who: "civfix",
        from: FROM_OUTREACH,
        to: "clerk@city.gov",
        dir: "out" as const,
        body: "hi",
        ts: "t",
        attachments: [],
        delivery: "sent" as const,
      },
      {
        id: "b",
        who: "clerk",
        from: "clerk@city.gov",
        to: "",
        dir: "in" as const,
        body: "re",
        ts: "t",
        attachments: [],
        delivery: null,
      },
      {
        id: "c",
        who: "civfix",
        from: FROM_OUTREACH,
        to: "clerk@city.gov",
        dir: "out" as const,
        body: "ok",
        ts: "t",
        attachments: [],
        delivery: "sent" as const,
      },
    ]
    expect(resolveCorrespondent(msgs, FROM_OUTREACH)).toBe("clerk@city.gov")
    expect(resolveCorrespondent(msgs, "OUTREACH@CIVFIX.ORG")).toBe("clerk@city.gov")
  })

  it("resolveCorrespondent treats every civfix reply address as ours, not as a correspondent", () => {
    const msgs = [
      {
        id: "a",
        who: "civfix",
        from: '"civfix Reports" <report-abcd2345wxyz@civfix.org>',
        to: "clerk@city.gov",
        dir: "out" as const,
        body: "packet",
        ts: "t",
        attachments: [],
        delivery: "sent" as const,
      },
      {
        id: "b",
        who: "clerk",
        from: "clerk@city.gov",
        to: "",
        dir: "in" as const,
        body: "re",
        ts: "t",
        attachments: [],
        delivery: null,
      },
      {
        id: "c",
        who: "civfix",
        from: "reply-abcd2345wxyz@civfix.org",
        to: "clerk@city.gov",
        dir: "out" as const,
        body: "ok",
        ts: "t",
        attachments: [],
        delivery: "sent" as const,
      },
    ]
    expect(resolveCorrespondent(msgs, FROM_OUTREACH, "civfix.org")).toBe("clerk@city.gov")
    expect(resolveCorrespondent(msgs, FROM_OUTREACH)).toBe("clerk@city.gov")
  })

  it("resolveCorrespondent keeps a real municipal sender on a civfix-shaped local part", () => {
    const msgs = [
      {
        id: "a",
        who: "clerk",
        from: "report-desk@lacity.gov",
        to: "",
        dir: "in" as const,
        body: "re",
        ts: "t",
        attachments: [],
        delivery: null,
      },
    ]
    expect(resolveCorrespondent(msgs, FROM_OUTREACH, "civfix.org")).toBe("report-desk@lacity.gov")
  })
})

describe("mail-service: list + getThread", () => {
  it("lists threads newest-first and reads a thread + messages, 404 on unknown", async () => {
    const { repo, svc } = harness()
    const t = await repo.createThread({
      subject: "Pothole",
      org: "City of LA",
      jurisdictionGeoid: "0644000",
    })
    await repo.insertMessage({
      threadId: t.id,
      direction: "out",
      fromAddr: FROM_OUTREACH,
      body: "please review",
    })

    const page = await svc.list({})
    expect(page.items.map((i) => i.id)).toEqual([t.id])

    const dto = await svc.getThread(t.id)
    expect(dto.subject).toBe("Pothole")
    expect(dto.messages).toHaveLength(1)

    await expect(svc.getThread("missing")).rejects.toMatchObject({ httpStatus: 404 })
  })

  it("reports per-message delivery: sent / failed / pending outbound, null inbound", async () => {
    const { repo, svc } = harness()
    const t = await repo.createThread({ subject: "Pothole", org: "City of LA" })
    const sent = await repo.insertMessage({
      threadId: t.id,
      direction: "out",
      fromAddr: FROM_OUTREACH,
      body: "one",
    })
    const failed = await repo.insertMessage({
      threadId: t.id,
      direction: "out",
      fromAddr: FROM_OUTREACH,
      body: "two",
    })
    await repo.insertMessage({
      threadId: t.id,
      direction: "out",
      fromAddr: FROM_OUTREACH,
      body: "three",
    })
    await repo.insertMessage({
      threadId: t.id,
      direction: "in",
      fromAddr: "clerk@city.gov",
      body: "four",
    })
    await repo.recordEvent({ threadId: t.id, messageId: sent?.id ?? "", type: "sent" })
    await repo.recordEvent({ threadId: t.id, messageId: failed?.id ?? "", type: "failed" })

    const dto = await svc.getThread(t.id)
    expect(dto.messages.map((m) => m.delivery)).toEqual(["sent", "failed", "pending", null])
  })

  it("passes through the dir / attn / geoid / q filters", async () => {
    const { repo, svc } = harness()
    const la = await repo.createThread({
      subject: "Trash",
      org: "City of LA",
      jurisdictionGeoid: "0644000",
    })
    await repo.insertMessage({
      threadId: la.id,
      direction: "out",
      fromAddr: FROM_OUTREACH,
      body: "x",
    })
    const sf = await repo.createThread({
      subject: "Graffiti",
      org: "City of SF",
      jurisdictionGeoid: "0667000",
    })
    await repo.insertMessage({
      threadId: sf.id,
      direction: "in",
      fromAddr: "clerk@sf.gov",
      body: "y",
    })

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
  it("appends an OUT reply to the thread's jurisdiction contact, delivers, marks replied + read", async () => {
    const { repo, mailer, svc } = harness()
    const t = await repo.createThread({ subject: "Question", org: "City of LA" })
    await seedDeliveredOut(repo, {
      threadId: t.id,
      fromAddr: FROM_OUTREACH,
      toAddr: "clerk@city.gov",
      body: "Original packet.",
    })
    await repo.insertMessage({
      threadId: t.id,
      direction: "in",
      fromAddr: "clerk@city.gov",
      body: "Q?",
    })
    expect((await repo.getThreadRecord(t.id))?.unread).toBe(true)

    const updated = await svc.reply(t.id, { body: "Here is the answer." }, "op-1")
    expect(updated.status).toBe("replied")
    expect(updated.unread).toBe(false)
    const dto = await repo.getThread(t.id)
    expect(dto?.messages).toHaveLength(3)
    expect(dto?.messages[2]?.dir).toBe("out")
    expect(dto?.messages[2]?.body).toBe("Here is the answer.")
    expect(mailer.sent.at(-1)?.to).toBe("clerk@city.gov")
    expect(mailer.sent.at(-1)?.outbound?.from).toMatch(
      /^"civfix" <reply-[a-z2-7]{12}@civfix\.org>$/,
    )
    expect(repo.audits.at(-1)).toMatchObject({ action: "mail.replied", target: `mail:${t.id}` })
  })

  it("H5: Reply targets the jurisdiction contact even after an unrelated sender joins the thread", async () => {
    const { repo, mailer, svc } = harness()
    const t = await repo.createThread({ subject: "Pothole", org: "City of LA" })
    await seedDeliveredOut(repo, {
      threadId: t.id,
      fromAddr: FROM_OUTREACH,
      toAddr: "publicworks@lacity.gov",
      body: "Report packet.",
    })
    await repo.insertMessage({
      threadId: t.id,
      direction: "in",
      fromAddr: "sales@vendor.example",
      body: "Please send the resident's full details.",
      unaffiliated: true,
    })

    await svc.reply(t.id, { body: "Any update?" }, "op-1")

    expect(mailer.sent.at(-1)?.to).toBe("publicworks@lacity.gov")
    expect(repo.audits.at(-1)).toMatchObject({
      action: "mail.replied",
      meta: { to: "publicworks@lacity.gov" },
    })
  })

  it("H5: Resend re-sends the last outbound packet to the jurisdiction contact, not the inbound sender", async () => {
    const { repo, mailer, svc } = harness()
    const t = await repo.createThread({ subject: "Pothole", org: "City of LA" })
    await seedDeliveredOut(repo, {
      threadId: t.id,
      fromAddr: FROM_OUTREACH,
      toAddr: "publicworks@lacity.gov",
      body: "Report packet.",
    })
    await repo.insertMessage({
      threadId: t.id,
      direction: "in",
      fromAddr: "sales@vendor.example",
      body: "Forward me everything.",
      unaffiliated: true,
    })

    await svc.resend(t.id, "op-1")

    expect(mailer.sent.at(-1)?.to).toBe("publicworks@lacity.gov")
    expect(mailer.sent.at(-1)?.outbound?.text).toBe("Report packet.")
    expect(repo.audits.at(-1)).toMatchObject({
      action: "mail.resent",
      meta: { to: "publicworks@lacity.gov" },
    })
  })

  it("refuses Reply and Resend while the newest outbound attempt is still in flight after a deadline", async () => {
    const { repo, svc } = harness()
    repo.now = new Date()
    const t = await repo.createThread({ subject: "Pothole", org: "City of LA" })
    const out = await repo.insertMessage({
      threadId: t.id,
      direction: "out",
      fromAddr: FROM_OUTREACH,
      toAddr: "pw@lacity.gov",
      body: "packet",
    })
    await repo.recordEvent({
      threadId: t.id,
      messageId: out!.id,
      type: "failed",
      meta: { reason: "deadline" },
    })

    await expect(svc.reply(t.id, { body: "any update?" }, "op-1")).rejects.toMatchObject({
      httpStatus: 409,
    })
    await expect(svc.resend(t.id, "op-1")).rejects.toMatchObject({ httpStatus: 409 })

    await repo.recordEvent({
      threadId: t.id,
      messageId: out!.id,
      type: "sent",
      meta: { late: true },
    })
    await expect(svc.reply(t.id, { body: "any update?" }, "op-1")).resolves.toBeDefined()
  })

  it("refuses Reply and Resend while the newest outbound attempt is still transmitting with no outcome yet", async () => {
    const { repo, mailer, svc } = harness()
    const t = await repo.createThread({ subject: "Pothole", org: "City of LA" })
    await repo.insertMessage({
      threadId: t.id,
      direction: "out",
      fromAddr: FROM_OUTREACH,
      toAddr: "pw@lacity.gov",
      body: "packet",
    })

    await expect(svc.resend(t.id, "op-1")).rejects.toMatchObject({ httpStatus: 409 })
    await expect(svc.reply(t.id, { body: "any update?" }, "op-1")).rejects.toMatchObject({
      httpStatus: 409,
    })
    expect(mailer.sent).toHaveLength(0)
  })

  it("treats an outcome-less attempt older than the claim window as crashed, not in flight", async () => {
    const { repo, mailer, svc } = harness()
    const t = await repo.createThread({ subject: "Pothole", org: "City of LA" })
    await repo.insertMessage({
      threadId: t.id,
      direction: "out",
      fromAddr: FROM_OUTREACH,
      toAddr: "pw@lacity.gov",
      body: "packet",
    })
    repo.now = new Date(repo.now.getTime() + (ROUTE_CLAIM_STALE_SECONDS + 1) * 1000)

    await svc.resend(t.id, "op-1")
    expect(mailer.sent.at(-1)?.to).toBe("pw@lacity.gov")
  })

  it("H5: a thread with ONLY an inbound message has no jurisdiction contact, so Reply is refused", async () => {
    const { repo, svc } = harness()
    const t = await repo.createThread({ subject: "Cold inbound" })
    await repo.insertMessage({
      threadId: t.id,
      direction: "in",
      fromAddr: "clerk@city.gov",
      body: "Q?",
    })
    await expect(svc.reply(t.id, { body: "b" }, "op-1")).rejects.toMatchObject({ httpStatus: 422 })
  })

  it("M1: replies to a composed outbound-only thread using the stored OUT to_addr", async () => {
    const { repo, mailer, svc } = harness()
    const t = await repo.createThread({ subject: "Intro" })
    await seedDeliveredOut(repo, {
      threadId: t.id,
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
    await seedDeliveredOut(repo, {
      threadId: t.id,
      fromAddr: FROM_OUTREACH,
      toAddr: "clerk@city.gov",
      body: "Original packet.",
    })
    await repo.insertMessage({
      threadId: t.id,
      direction: "in",
      fromAddr: "clerk@city.gov",
      body: "Q?",
    })
    const getThread = vi.spyOn(repo, "getThread")
    const lastOutbound = vi.spyOn(repo, "getLastOutboundRecipient")

    await svc.reply(t.id, { body: "Here is the answer." }, "op-1")

    expect(mailer.sent.at(-1)?.to).toBe("clerk@city.gov")
    expect(lastOutbound).toHaveBeenCalledWith(t.id)
    expect(getThread).toHaveBeenCalledTimes(1)
  })

  it("keeps a thread in review after a reply while it holds a withheld city reply", async () => {
    const { repo, svc } = harness()
    const t = repo.seedThread({ reportId: "report-1", status: "needs_action" })
    await seedDeliveredOut(repo, {
      threadId: t.id,
      fromAddr: FROM_OUTREACH,
      toAddr: "publicworks@lacity.gov",
      body: "hi",
    })
    repo.seedMessage({ threadId: t.id, direction: "in", unaffiliated: true })

    expect((await svc.reply(t.id, { body: "From your city address?" }, "op-1")).status).toBe(
      "needs_action",
    )
    await svc.setStatus(t.id, "replied", "op-1")
    expect((await svc.reply(t.id, { body: "Following up." }, "op-1")).status).toBe("replied")
  })

  it("404s an unknown thread and 422s a thread with no recipient at all to reply to", async () => {
    const { repo, svc } = harness()
    await expect(svc.reply("missing", { body: "b" }, "op-1")).rejects.toMatchObject({
      httpStatus: 404,
    })
    const t = await repo.createThread({ subject: "S" })
    await seedDeliveredOut(repo, {
      threadId: t.id,
      fromAddr: FROM_OUTREACH,
      body: "hi",
    })
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
    await repo.insertMessage({
      threadId: t.id,
      direction: "in",
      fromAddr: "clerk@city.gov",
      body: "Q?",
    })
    await seedDeliveredOut(repo, {
      threadId: t.id,
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
    await seedDeliveredOut(repo, {
      threadId: t.id,
      fromAddr: FROM_OUTREACH,
      toAddr: "mayor@city.gov",
      body: "Hello.",
    })
    await svc.resend(t.id, "op-1")
    expect(mailer.sent.at(-1)?.to).toBe("mayor@city.gov")
  })

  it("replays the untruncated body and the html part, never a stored attachment", async () => {
    const h = harness()
    const body = "x".repeat(100_000)
    const t = await h.repo.createThread({ subject: "Pothole", org: "City of LA" })
    await seedDeliveredOut(h.repo, {
      threadId: t.id,
      fromAddr: '"civfix Reports" <report-abcd2345wxyz@civfix.org>',
      toAddr: "clerk@city.gov",
      subject: "civfix report: Pothole",
      body,
      html: "<p>packet</p>",
      kind: "packet",
      attachments: [
        { key: "media/r2/photo.jpg", filename: "photo.jpg", size: 4 },
        { key: "media/r2/gone.jpg", filename: "gone.jpg", size: 9 },
      ],
    })

    await h.svc.resend(t.id, "op-1")

    const sent = h.mailer.sent.at(-1)?.outbound
    expect(sent?.text).toBe(body)
    expect(sent?.html).toBe("<p>packet</p>")
    expect(sent?.subject).toBe("civfix report: Pothole")
    expect(sent?.attachments).toBeUndefined()
    const replayed = h.repo.messagesOf(t.id).at(-1)
    expect(replayed?.kind).toBe("resend")
    expect(replayed?.html).toBe("<p>packet</p>")
    expect(replayed?.attachments).toEqual([])
  })

  it("404s an unknown thread and 422s a thread with no outbound message to resend", async () => {
    const { repo, svc } = harness()
    await expect(svc.resend("missing", "op-1")).rejects.toMatchObject({ httpStatus: 404 })
    const t = await repo.createThread({ subject: "S" })
    await repo.insertMessage({
      threadId: t.id,
      direction: "in",
      fromAddr: "clerk@city.gov",
      body: "Q?",
    })
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
