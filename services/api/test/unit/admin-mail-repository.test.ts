import { describe, it, expect } from "vitest"
import type { MailThreadDTO } from "@civfix/shared"
import type { Storage } from "@civfix/shared/interfaces"
import { InMemoryMailRepository } from "../helpers/admin/mail-repository.memory.js"
import { presignThreadAttachments } from "../../src/routes/admin/mail.routes.js"
import {
  buildMailStats,
  mintThreadToken,
  toThreadDTO,
  deriveWho,
  type MailThreadRecord,
} from "../../src/services/admin/mail-repository.drizzle.js"

describe("mintThreadToken", () => {
  it("produces a 12-char lowercase base32 token, distinct per call", () => {
    const a = mintThreadToken()
    const b = mintThreadToken()
    expect(a).toMatch(/^[a-z2-7]{12}$/)
    expect(a).not.toBe(b)
  })
})

describe("buildMailStats", () => {
  it("surfaces only measured signals, clamped non-negative", () => {
    expect(
      buildMailStats({ unread: 2, threads: 5, counts: { sent: 10, bounced: 1, failed: 2 } }),
    ).toEqual({ unread: 2, threads: 5, sent: 10, bounced: 1, failed: 2 })
  })
})

describe("deriveWho", () => {
  it("uses the from address when present, else a direction-based label", () => {
    expect(deriveWho("in", "clerk@city.gov")).toBe("clerk@city.gov")
    expect(deriveWho("in", null)).toBe("Inbound")
    expect(deriveWho("out", "")).toBe("civfix")
  })
})

describe("toThreadDTO", () => {
  it("maps a thread + messages to the detail DTO with derived dir/from/preview from the latest", () => {
    const thread: MailThreadRecord = {
      id: "11111111-1111-1111-1111-111111111111",
      threadToken: "tok",
      reportId: null,
      cleanupId: null,
      jurisdictionGeoid: "0644000",
      org: "City of LA",
      subject: "Pothole",
      status: "sent",
      unread: false,
      lastMessageAt: new Date("2026-02-01T00:00:02.000Z"),
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
    }
    const dto = toThreadDTO(thread, [
      {
        id: "m1",
        threadId: thread.id,
        direction: "out",
        fromAddr: "outreach@civfix.org",
        toAddr: "clerk@city.gov",
        subject: "Pothole",
        body: "Please review.",
        attachments: [],
        messageId: null,
        inReplyTo: null,
        html: null,
        kind: null,
        unaffiliated: false,
        effectsClaimedAt: null,
        effectsAppliedAt: null,
        effectsStage: 0,
        createdAt: new Date("2026-02-01T00:00:01.000Z"),
      },
      {
        id: "m2",
        threadId: thread.id,
        direction: "in",
        fromAddr: "clerk@city.gov",
        toAddr: "outreach@civfix.org",
        subject: "Re: Pothole",
        body: "On it.",
        attachments: [{ key: "r2/a.pdf", filename: "a.pdf", size: 10 }],
        messageId: null,
        inReplyTo: null,
        html: null,
        kind: null,
        unaffiliated: false,
        effectsClaimedAt: null,
        effectsAppliedAt: null,
        effectsStage: 0,
        createdAt: new Date("2026-02-01T00:00:02.000Z"),
      },
    ])
    expect(dto.id).toBe(thread.id)
    expect(dto.dir).toBe("in")
    expect(dto.from).toBe("clerk@city.gov")
    expect(dto.preview).toBe("On it.")
    expect(dto.org).toBe("City of LA")
    expect(dto.messages).toHaveLength(2)
    expect(dto.messages[1]?.attachments).toEqual([{ key: "r2/a.pdf", filename: "a.pdf", size: 10 }])
    expect(dto.messages[0]?.who).toBe("outreach@civfix.org")
    expect(dto.messages[0]?.delivery).toBe("pending")
    expect(dto.messages[1]?.delivery).toBeNull()
  })

  it("derives delivery from the message's latest sent/failed mail event", async () => {
    const repo = new InMemoryMailRepository()
    const thread = await repo.createThread({ subject: "Pothole", org: "City of LA" })
    const message = await repo.insertMessage({
      threadId: thread.id,
      direction: "out",
      fromAddr: "outreach@civfix.org",
      body: "Please review.",
    })
    await repo.recordEvent({ threadId: thread.id, messageId: message?.id ?? "", type: "failed" })
    expect((await repo.getThread(thread.id))?.messages[0]?.delivery).toBe("failed")
    await repo.recordEvent({ threadId: thread.id, messageId: message?.id ?? "", type: "sent" })
    expect((await repo.getThread(thread.id))?.messages[0]?.delivery).toBe("sent")
  })
})

describe("InMemoryMailRepository: thread upsert", () => {
  it("creates on first use and returns the same row on the second", async () => {
    const repo = new InMemoryMailRepository()
    const first = await repo.upsertThreadByToken("geo-0644000", {
      jurisdictionGeoid: "0644000",
      org: "City of LA",
      subject: "Outreach",
    })
    const second = await repo.upsertThreadByToken("geo-0644000", { org: "ignored on hit" })
    expect(second.id).toBe(first.id)
    expect(second.org).toBe("City of LA")
    expect(repo.threads.size).toBe(1)
  })

  it("createThread mints a token when none is provided", async () => {
    const repo = new InMemoryMailRepository()
    const t = await repo.createThread({ subject: "Compose" })
    expect(t.threadToken).toMatch(/^[a-z2-7]{12}$/)
    expect(t.status).toBe("sent")
  })
})

describe("InMemoryMailRepository: insertMessage side effects", () => {
  it("bumps last_message_at forward and leaves unread false for an outbound message", async () => {
    const repo = new InMemoryMailRepository()
    const t = await repo.createThread({ subject: "S" })
    expect(t.lastMessageAt).toBeNull()
    const m = await repo.insertMessage({
      threadId: t.id,
      direction: "out",
      fromAddr: "outreach@civfix.org",
      toAddr: "clerk@city.gov",
      body: "Hello",
    })
    const after = await repo.getThreadRecord(t.id)
    expect(after?.lastMessageAt?.getTime()).toBe(m!.createdAt.getTime())
    expect(after?.unread).toBe(false)
  })

  it("sets unread=true for an inbound message", async () => {
    const repo = new InMemoryMailRepository()
    const t = await repo.createThread({ subject: "S" })
    await repo.insertMessage({
      threadId: t.id,
      direction: "in",
      fromAddr: "clerk@city.gov",
      body: "Reply",
    })
    const after = await repo.getThreadRecord(t.id)
    expect(after?.unread).toBe(true)
  })

  it("does not rewind last_message_at when an older message is inserted", async () => {
    const repo = new InMemoryMailRepository()
    const t = await repo.createThread({ subject: "S" })
    const newer = await repo.insertMessage({ threadId: t.id, direction: "out", body: "newer" })
    const after1 = await repo.getThreadRecord(t.id)
    expect(after1?.lastMessageAt?.getTime()).toBe(newer!.createdAt.getTime())
    const newest = await repo.insertMessage({ threadId: t.id, direction: "out", body: "newest" })
    const after2 = await repo.getThreadRecord(t.id)
    expect(after2?.lastMessageAt?.getTime()).toBe(newest!.createdAt.getTime())
    expect(after2!.lastMessageAt!.getTime()).toBeGreaterThan(after1!.lastMessageAt!.getTime())
  })
})

describe("InMemoryMailRepository: getThread", () => {
  it("returns the thread + ordered messages, or null for an unknown id", async () => {
    const repo = new InMemoryMailRepository()
    expect(await repo.getThread("nope")).toBeNull()
    const t = await repo.createThread({ subject: "S", org: "Org" })
    await repo.insertMessage({ threadId: t.id, direction: "out", fromAddr: "a", body: "first" })
    await repo.insertMessage({ threadId: t.id, direction: "in", fromAddr: "b", body: "second" })
    const dto = await repo.getThread(t.id)
    expect(dto?.messages.map((m) => m.body)).toEqual(["first", "second"])
    expect(dto?.dir).toBe("in")
    expect(dto?.preview).toBe("second")
  })
})

describe("InMemoryMailRepository: listThreads filter + paginate", () => {
  it("orders newest-first by last_message_at and paginates with a stable cursor", async () => {
    const repo = new InMemoryMailRepository()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const t = await repo.createThread({ subject: `T${i}` })
      await repo.insertMessage({ threadId: t.id, direction: "out", body: `b${i}` })
      ids.push(t.id)
    }
    const page1 = await repo.listThreads({ limit: 2 })
    expect(page1.items).toHaveLength(2)
    expect(page1.items[0]?.id).toBe(ids[2])
    expect(page1.items[1]?.id).toBe(ids[1])
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await repo.listThreads({ limit: 2, cursor: page1.nextCursor })
    expect(page2.items).toHaveLength(1)
    expect(page2.items[0]?.id).toBe(ids[0])
    expect(page2.nextCursor).toBeNull()
  })

  it("filters by dir (latest message direction)", async () => {
    const repo = new InMemoryMailRepository()
    const out = await repo.createThread({ subject: "out" })
    await repo.insertMessage({ threadId: out.id, direction: "out", body: "o" })
    const inb = await repo.createThread({ subject: "in" })
    await repo.insertMessage({ threadId: inb.id, direction: "in", fromAddr: "c", body: "i" })
    const outbound = await repo.listThreads({ dir: "out", limit: 10 })
    expect(outbound.items.map((t) => t.id)).toEqual([out.id])
    const inbound = await repo.listThreads({ dir: "in", limit: 10 })
    expect(inbound.items.map((t) => t.id)).toEqual([inb.id])
  })

  it("filters attn to unread or triage-status threads", async () => {
    const repo = new InMemoryMailRepository()
    const calm = await repo.createThread({ subject: "calm" })
    await repo.insertMessage({ threadId: calm.id, direction: "out", body: "x" })
    const unread = await repo.createThread({ subject: "unread" })
    await repo.insertMessage({ threadId: unread.id, direction: "in", fromAddr: "c", body: "y" })
    const flagged = await repo.createThread({ subject: "needs", status: "needs_action" })
    await repo.insertMessage({ threadId: flagged.id, direction: "out", body: "z" })
    const attn = await repo.listThreads({ filter: "attn", limit: 10 })
    const ids = new Set(attn.items.map((t) => t.id))
    expect(ids.has(unread.id)).toBe(true)
    expect(ids.has(flagged.id)).toBe(true)
    expect(ids.has(calm.id)).toBe(false)
  })

  it("filters by jurisdiction and by free-text q (org/subject/from)", async () => {
    const repo = new InMemoryMailRepository()
    const la = await repo.createThread({
      subject: "Pothole",
      org: "City of LA",
      jurisdictionGeoid: "0644000",
    })
    await repo.insertMessage({
      threadId: la.id,
      direction: "out",
      fromAddr: "outreach@civfix.org",
      body: "p",
    })
    const sf = await repo.createThread({
      subject: "Graffiti",
      org: "City of SF",
      jurisdictionGeoid: "0667000",
    })
    await repo.insertMessage({
      threadId: sf.id,
      direction: "out",
      fromAddr: "outreach@civfix.org",
      body: "g",
    })
    const byGeo = await repo.listThreads({ jurisdictionGeoid: "0644000", limit: 10 })
    expect(byGeo.items.map((t) => t.id)).toEqual([la.id])
    const byQ = await repo.listThreads({ q: "graffiti", limit: 10 })
    expect(byQ.items.map((t) => t.id)).toEqual([sf.id])
    const byOrg = await repo.listThreads({ q: "city of la", limit: 10 })
    expect(byOrg.items.map((t) => t.id)).toEqual([la.id])
  })
})

describe("InMemoryMailRepository: markThreadRead + setThreadStatus", () => {
  it("clears unread and reports whether the thread existed", async () => {
    const repo = new InMemoryMailRepository()
    const t = await repo.createThread({ subject: "S", unread: true })
    expect(await repo.markThreadRead(t.id)).toBe(true)
    expect((await repo.getThreadRecord(t.id))?.unread).toBe(false)
    expect(await repo.markThreadRead("missing")).toBe(false)
  })

  it("sets status and reports whether the thread existed", async () => {
    const repo = new InMemoryMailRepository()
    const t = await repo.createThread({ subject: "S" })
    expect(await repo.setThreadStatus(t.id, "replied")).toBe(true)
    expect((await repo.getThreadRecord(t.id))?.status).toBe("replied")
    expect(await repo.setThreadStatus("missing", "bounced")).toBe(false)
  })
})

describe("InMemoryMailRepository: stats7d", () => {
  it("aggregates events in the rolling window and counts unread + threads", async () => {
    const repo = new InMemoryMailRepository()
    repo.now = new Date("2026-03-10T00:00:00.000Z")
    const a = await repo.createThread({ subject: "A" })
    await repo.insertMessage({ threadId: a.id, direction: "in", fromAddr: "c", body: "x" })
    await repo.createThread({ subject: "B" })
    repo.seedEvent({ type: "sent", createdAt: new Date("2026-03-09T00:00:00.000Z") })
    repo.seedEvent({ type: "sent", createdAt: new Date("2026-03-08T00:00:00.000Z") })
    repo.seedEvent({ type: "failed", createdAt: new Date("2026-03-09T00:00:00.000Z") })
    repo.seedEvent({ type: "bounced", createdAt: new Date("2026-03-09T00:00:00.000Z") })
    repo.seedEvent({ type: "sent", createdAt: new Date("2026-02-01T00:00:00.000Z") })
    const stats = await repo.stats7d()
    expect(stats.sent).toBe(2)
    expect(stats.failed).toBe(1)
    expect(stats.bounced).toBe(1)
    expect(stats.unread).toBe(1)
    expect(stats.threads).toBe(2)
  })

  it("returns honest zero stats with no events", async () => {
    const repo = new InMemoryMailRepository()
    const stats = await repo.stats7d()
    expect(stats).toEqual({ unread: 0, threads: 0, sent: 0, bounced: 0, failed: 0 })
  })
})

describe("InMemoryMailRepository: outreach state", () => {
  it("upserts and patches only provided fields", async () => {
    const repo = new InMemoryMailRepository()
    expect(await repo.getOutreachState("0644000")).toBeNull()
    const at = new Date("2026-03-01T00:00:00.000Z")
    const set1 = await repo.setOutreachState("0644000", { lastOutreachAt: at })
    expect(set1.lastOutreachAt?.getTime()).toBe(at.getTime())
    expect(set1.suppressed).toBe(false)
    const set2 = await repo.setOutreachState("0644000", { suppressed: true })
    expect(set2.suppressed).toBe(true)
    expect(set2.lastOutreachAt?.getTime()).toBe(at.getTime())
  })
})

describe("InMemoryMailRepository: recordEvent", () => {
  it("stores an event and returns its id", async () => {
    const repo = new InMemoryMailRepository()
    const id = await repo.recordEvent({ type: "sent", meta: { to: "x@y.com" } })
    expect(typeof id).toBe("string")
    expect(repo.events).toHaveLength(1)
    expect(repo.events[0]?.meta).toEqual({ to: "x@y.com" })
  })
})

describe("InMemoryMailRepository: outbound snapshot + failure recording", () => {
  it("records a send failure as one event + needs_action + an audit row", async () => {
    const repo = new InMemoryMailRepository()
    const t = await repo.createThread({ subject: "Pothole", status: "sent" })
    const m = await repo.insertMessage({
      threadId: t.id,
      direction: "out",
      toAddr: "clerk@city.gov",
      body: "packet",
    })
    await repo.recordSendFailure({
      threadId: t.id,
      messageId: m?.id ?? "",
      meta: { to: "clerk@city.gov", error: "smtp down" },
      audit: {
        actorId: null,
        action: "mail.send_failed",
        target: "report:rep-1",
        meta: { reportId: "rep-1" },
      },
    })
    expect(repo.events.map((e) => e.type)).toEqual(["failed"])
    expect((await repo.getThreadRecord(t.id))?.status).toBe("needs_action")
    expect(repo.audits.at(-1)).toMatchObject({ action: "mail.send_failed", target: "report:rep-1" })
  })

  it("re-reads the latest outbound message whole, and only outbound ones", async () => {
    const repo = new InMemoryMailRepository()
    const t = await repo.createThread({ subject: "Pothole" })
    await repo.insertMessage({
      threadId: t.id,
      direction: "out",
      toAddr: "clerk@city.gov",
      body: "first",
    })
    const inbound = await repo.insertMessage({
      threadId: t.id,
      direction: "in",
      fromAddr: "clerk@city.gov",
      body: "re",
    })
    const last = await repo.insertMessage({
      threadId: t.id,
      direction: "out",
      toAddr: "clerk@city.gov",
      subject: "civfix report: Pothole",
      body: "second",
      html: "<p>second</p>",
      kind: "packet",
      attachments: [{ key: "media/r2/a.jpg", filename: "a.jpg", size: 4 }],
    })

    expect(await repo.latestOutboundMessageId(t.id)).toBe(last?.id)
    expect(await repo.getOutboundMessageForResend(inbound?.id ?? "")).toBeNull()
    expect(await repo.getOutboundMessageForResend(last?.id ?? "")).toEqual({
      id: last?.id,
      toAddr: "clerk@city.gov",
      subject: "civfix report: Pothole",
      body: "second",
      html: "<p>second</p>",
      attachments: [{ key: "media/r2/a.jpg", filename: "a.jpg", size: 4 }],
    })
  })

  it("rewrites a thread subject in place", async () => {
    const repo = new InMemoryMailRepository()
    const t = await repo.createThread({ subject: "old" })
    await repo.setThreadSubject(t.id, "new")
    expect((await repo.getThreadRecord(t.id))?.subject).toBe("new")
  })
})

describe("presignThreadAttachments", () => {
  it("signs outbound packet media against the media bucket, inbound files against the inbound one", async () => {
    const store = (label: string): Storage =>
      ({ presignGet: (key: string) => Promise.resolve(`${label}:${key}`) }) as unknown as Storage
    const attachments = (key: string) => [{ key, filename: "f", size: 1 }]
    const dto = {
      messages: [
        { dir: "out", attachments: attachments("media/photo.jpg") },
        { dir: "in", attachments: attachments("inbound/a.pdf") },
      ],
    } as unknown as MailThreadDTO

    const signed = await presignThreadAttachments(dto, { in: store("in"), out: store("out") })

    expect(signed.messages.map((m) => m.attachments[0]?.key)).toEqual([
      "out:media/photo.jpg",
      "in:inbound/a.pdf",
    ])
  })
})
