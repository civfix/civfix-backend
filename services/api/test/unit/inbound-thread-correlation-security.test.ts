import { describe, expect, it } from "vitest"
import { FakeInboundMail, FakeJobs, FakeStorage } from "@civfix/shared/fakes"
import type { ParsedMail } from "@civfix/shared/interfaces"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { InMemoryInboundRepository } from "../../src/services/admin/inbound-repository.memory.js"
import { InMemoryAdminReportRepository } from "../../src/services/admin/admin-report-repository.memory.js"
import { isJurisdictionSender } from "../../src/services/admin/inbound-thread-correlation.js"
import {
  processInboundObject,
  INBOUND_PENDING_PREFIX,
  type InboundProcessorDeps,
} from "../../src/services/admin/inbound-processor.js"
import type { ReportTimelineEvent } from "../../src/services/report-timeline-event.js"
import type { Container } from "../../src/di.js"
import { RecordingNotifier } from "../helpers/notifications.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"
import { makeFakeSql } from "../helpers/fake-sql.js"

const TOKEN = "0123456789abcdef01234567"
const CONSUMER_CONTACT = "clerk.smalltown@gmail.com"

function mail(from: string): ParsedMail {
  return {
    from: { address: from },
    to: [{ address: `reply+${TOKEN}@civfix.org` }],
    subject: null,
    text: null,
    html: null,
    messageId: null,
    inReplyTo: null,
    headers: {},
  }
}

async function sentBy(contacts: string[], from: string): Promise<boolean> {
  const mailRepo = new InMemoryMailRepository()
  const thread = mailRepo.seedThread({ threadToken: TOKEN })
  for (const toAddr of contacts)
    mailRepo.seedMessage({ threadId: thread.id, direction: "out", toAddr })
  return isJurisdictionSender(mailRepo, thread.id, mail(from))
}

describe("isJurisdictionSender on a consumer mail domain", () => {
  it("rejects a different mailbox at the same consumer provider", async () => {
    expect(await sentBy([CONSUMER_CONTACT], "mallory@gmail.com")).toBe(false)
  })

  it("accepts the contact's own mailbox, ignoring case and surrounding space", async () => {
    expect(await sentBy([CONSUMER_CONTACT], "Clerk.SmallTown@Gmail.com")).toBe(true)
    expect(await sentBy([` ${CONSUMER_CONTACT.toUpperCase()} `], CONSUMER_CONTACT)).toBe(true)
    expect(await sentBy([`Town Clerk <${CONSUMER_CONTACT}>`], CONSUMER_CONTACT)).toBe(true)
  })

  it("does not fold provider aliases, dots or plus tags into a match", async () => {
    expect(await sentBy([CONSUMER_CONTACT], "clerk.smalltown@googlemail.com")).toBe(false)
    expect(await sentBy([CONSUMER_CONTACT], "clerksmalltown@gmail.com")).toBe(false)
    expect(await sentBy([CONSUMER_CONTACT], "clerk.smalltown+city@gmail.com")).toBe(false)
  })

  it("applies the exact-match rule to every consumer provider and its subdomains", async () => {
    expect(await sentBy(["clerk@outlook.com"], "other@outlook.com")).toBe(false)
    expect(await sentBy(["clerk@yahoo.com"], "other@yahoo.com")).toBe(false)
    expect(await sentBy(["clerk@icloud.com"], "other@icloud.com")).toBe(false)
    expect(await sentBy(["clerk@proton.me"], "other@proton.me")).toBe(false)
    expect(await sentBy(["clerk@mail.yahoo.com"], "other@yahoo.com")).toBe(false)
  })

  it("still aligns by organizational domain for a jurisdiction's own domain", async () => {
    expect(await sentBy(["publicworks@lacity.org"], "clerk@bss.lacity.org")).toBe(true)
    expect(await sentBy([CONSUMER_CONTACT, "publicworks@lacity.org"], "clerk@lacity.org")).toBe(
      true,
    )
    expect(await sentBy([CONSUMER_CONTACT, "publicworks@lacity.org"], "mallory@gmail.com")).toBe(
      false,
    )
  })
})

describe("an unrelated consumer-domain sender on a report thread", () => {
  function ctx() {
    const inboundMail = new FakeInboundMail()
    const storage = new FakeStorage()
    const mailRepo = new InMemoryMailRepository()
    const adminReportRepo = new InMemoryAdminReportRepository()
    const notifier = new RecordingNotifier()
    const chatEvents: ReportTimelineEvent[] = []
    const deps: InboundProcessorDeps = {
      storage,
      inboundMail,
      mailRepo,
      inboundRepo: new InMemoryInboundRepository(),
      adminReportRepo,
      cleanupRepo: new InMemoryCleanupRepository(),
      notifications: notifier,
      chatEmitter: {
        emit: (event) => {
          chatEvents.push(event)
          return Promise.resolve()
        },
      },
    }
    const container = {
      env: {},
      storage,
      inboundStorage: storage,
      inboundMail,
      jobs: new FakeJobs(),
      getDb: () => ({ sql: makeFakeSql().sql }),
    } as unknown as Container
    return { container, deps, storage, mailRepo, adminReportRepo, notifier, chatEvents }
  }

  function seedReportThread(c: ReturnType<typeof ctx>, reportId: string): string {
    c.adminReportRepo.seedReport({
      id: reportId,
      status: "published",
      reporter: {
        id: "user-1",
        name: "Jane",
        handle: "jane",
        emailVerified: true,
        hasOauth: false,
        joinedAt: new Date("2025-01-01T00:00:00Z"),
      },
    })
    const thread = c.mailRepo.seedThread({ threadToken: TOKEN, reportId, status: "sent" })
    c.mailRepo.seedMessage({ threadId: thread.id, direction: "out", toAddr: CONSUMER_CONTACT })
    return thread.id
  }

  function reply(from: string, messageId: string): Buffer {
    return Buffer.from(
      [
        `From: ${from}`,
        `To: reply+${TOKEN}@civfix.org`,
        `Message-ID: ${messageId}`,
        "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=gmail.com",
        "",
        "We have closed this, the reporter is lying.",
      ].join("\n"),
      "utf8",
    )
  }

  it("is stored as unaffiliated with no status change, chat message or push", async () => {
    const c = ctx()
    const reportId = "report-consumer"
    const threadId = seedReportThread(c, reportId)
    const key = `${INBOUND_PENDING_PREFIX}mallory.eml`
    await c.storage.put(key, reply("mallory@gmail.com", "<m-1@gmail.com>"))

    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("threaded")

    const stored = c.mailRepo.messagesOf(threadId).filter((m) => m.direction === "in")
    expect(stored).toHaveLength(1)
    expect(stored[0]?.unaffiliated).toBe(true)
    expect(c.chatEvents).toHaveLength(0)
    expect(c.notifier.sent).toHaveLength(0)
    expect(c.adminReportRepo.reports.get(reportId)?.record.status).toBe("published")
  })

  it("still applies the effects when the contact itself replies", async () => {
    const c = ctx()
    const reportId = "report-consumer-contact"
    const threadId = seedReportThread(c, reportId)
    const key = `${INBOUND_PENDING_PREFIX}clerk.eml`
    await c.storage.put(key, reply(CONSUMER_CONTACT, "<c-1@gmail.com>"))

    expect((await processInboundObject(c.container, key, c.deps)).outcome).toBe("threaded")

    const stored = c.mailRepo.messagesOf(threadId).find((m) => m.direction === "in")
    expect(stored?.unaffiliated).toBe(false)
    expect(c.adminReportRepo.reports.get(reportId)?.record.status).toBe("in_progress")
  })
})
