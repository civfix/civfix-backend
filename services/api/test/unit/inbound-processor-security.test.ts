import { describe, expect, it } from "vitest"
import { FakeJobs, FakeStorage } from "@civfix/shared/fakes"
import { CfInboundMail } from "../../src/adapters/inbound-mail.cf.js"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { InMemoryInboundRepository } from "../../src/services/admin/inbound-repository.memory.js"
import { InMemoryAdminReportRepository } from "../../src/services/admin/admin-report-repository.memory.js"
import { RecordingNotifier } from "../helpers/notifications.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"
import {
  processInboundObject,
  INBOUND_PENDING_PREFIX,
  type InboundProcessorDeps,
} from "../../src/services/admin/inbound-processor.js"
import type { Container } from "../../src/di.js"
import { makeFakeSql } from "../helpers/fake-sql.js"

const TOKEN = "0123456789abcdef01234567"
const REPLY_TO = `reply+${TOKEN}@civfix.org`
const CITY_BYTES = "CITY-EVIDENCE"
const ATTACKER_BYTES = "ATTACKER-BYTES"

interface Ctx {
  container: Container
  deps: InboundProcessorDeps
  storage: FakeStorage
  mailRepo: InMemoryMailRepository
  inboundRepo: InMemoryInboundRepository
}

function ctx(): Ctx {
  const inboundMail = new CfInboundMail()
  const storage = new FakeStorage()
  const mailRepo = new InMemoryMailRepository()
  const inboundRepo = new InMemoryInboundRepository()
  const deps: InboundProcessorDeps = {
    storage,
    inboundMail,
    mailRepo,
    inboundRepo,
    adminReportRepo: new InMemoryAdminReportRepository(),
    cleanupRepo: new InMemoryCleanupRepository(),
    notifications: new RecordingNotifier(),
    chatEmitter: { emit: () => Promise.resolve() },
  }
  const container = {
    env: {},
    storage,
    inboundStorage: storage,
    inboundMail,
    jobs: new FakeJobs(),
    getDb: () => ({ sql: makeFakeSql().sql }),
  } as unknown as Container
  return { container, deps, storage, mailRepo, inboundRepo }
}

function mailWithAttachment(opts: {
  from: string
  to: string
  messageId: string
  filename: string
  content: string
}): Buffer {
  const fromDomain = opts.from.slice(opts.from.lastIndexOf("@") + 1)
  return Buffer.from(
    [
      `From: ${opts.from}`,
      `To: ${opts.to}`,
      "Subject: Re: pothole",
      `Message-ID: ${opts.messageId}`,
      `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=${fromDomain}`,
      "Content-Type: multipart/mixed; boundary=b",
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "See attached.",
      "--b",
      "Content-Type: application/octet-stream",
      `Content-Disposition: attachment; filename="${opts.filename}"`,
      "",
      opts.content,
      "--b--",
      "",
    ].join("\r\n"),
    "utf8",
  )
}

async function deliver(c: Ctx, key: string, raw: Buffer): Promise<string> {
  await c.storage.put(key, raw)
  return (await processInboundObject(c.container, key, c.deps)).outcome
}

function text(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : Buffer.from(bytes).toString("utf8").trim()
}

async function keysUnder(storage: FakeStorage, prefix: string): Promise<string[]> {
  return (await storage.list(prefix, { limit: 1000 })).keys
}

function seedReportThread(c: Ctx): string {
  const thread = c.mailRepo.seedThread({ threadToken: TOKEN, status: "sent" })
  c.mailRepo.seedMessage({ threadId: thread.id, direction: "out", toAddr: "clerk@city.gov" })
  return thread.id
}

describe("threaded inbound attachments cannot be overwritten by a later mail", () => {
  it("keeps each message's same-named attachment at its own key with its own bytes", async () => {
    const c = ctx()
    const threadId = seedReportThread(c)

    const cityMail = mailWithAttachment({
      from: "clerk@city.gov",
      to: REPLY_TO,
      messageId: "<city-1@city.gov>",
      filename: "photo.jpg",
      content: CITY_BYTES,
    })
    const attackerMail = mailWithAttachment({
      from: "mallory@gmail.com",
      to: REPLY_TO,
      messageId: "<attacker-1@gmail.com>",
      filename: "photo.jpg",
      content: ATTACKER_BYTES,
    })
    expect(await deliver(c, `${INBOUND_PENDING_PREFIX}a.eml`, cityMail)).toBe("threaded")
    expect(await deliver(c, `${INBOUND_PENDING_PREFIX}b.eml`, attackerMail)).toBe("threaded")

    const inbound = c.mailRepo.messagesOf(threadId).filter((m) => m.direction === "in")
    const cityKey = inbound.find((m) => m.fromAddr === "clerk@city.gov")?.attachments[0]?.key
    const attackerKey = inbound.find((m) => m.fromAddr === "mallory@gmail.com")?.attachments[0]?.key
    expect(cityKey).toBeDefined()
    expect(attackerKey).toBeDefined()
    expect(cityKey).not.toBe(attackerKey)
    expect(cityKey!.startsWith(`inbound-mail/${threadId}/`)).toBe(true)
    expect(text(await c.storage.getObject(cityKey!))).toBe(CITY_BYTES)
    expect(text(await c.storage.getObject(attackerKey!))).toBe(ATTACKER_BYTES)
  })

  it("never rewrites the stored bytes when a later mail reuses the Message-ID with other bytes", async () => {
    const c = ctx()
    const threadId = seedReportThread(c)
    const messageId = "<city-2@city.gov>"

    await deliver(
      c,
      `${INBOUND_PENDING_PREFIX}a.eml`,
      mailWithAttachment({
        from: "clerk@city.gov",
        to: REPLY_TO,
        messageId,
        filename: "Work order.pdf",
        content: CITY_BYTES,
      }),
    )
    const outcome = await deliver(
      c,
      `${INBOUND_PENDING_PREFIX}b.eml`,
      mailWithAttachment({
        from: "mallory@gmail.com",
        to: REPLY_TO,
        messageId,
        filename: "Work order.pdf",
        content: ATTACKER_BYTES,
      }),
    )
    expect(outcome).toBe("replay")

    const inbound = c.mailRepo.messagesOf(threadId).filter((m) => m.direction === "in")
    expect(inbound).toHaveLength(1)
    const cityKey = inbound[0]!.attachments[0]!.key
    expect(text(await c.storage.getObject(cityKey))).toBe(CITY_BYTES)
    expect(await keysUnder(c.storage, `inbound-mail/${threadId}/`)).toEqual([cityKey])
  })

  it("stays idempotent when the same pending object is processed twice", async () => {
    const c = ctx()
    const threadId = seedReportThread(c)
    const raw = mailWithAttachment({
      from: "clerk@city.gov",
      to: REPLY_TO,
      messageId: "<city-3@city.gov>",
      filename: "photo.jpg",
      content: CITY_BYTES,
    })
    const key = `${INBOUND_PENDING_PREFIX}same.eml`
    expect(await deliver(c, key, raw)).toBe("threaded")
    expect(await deliver(c, key, raw)).toBe("replay")

    const inbound = c.mailRepo.messagesOf(threadId).filter((m) => m.direction === "in")
    expect(inbound).toHaveLength(1)
    const stored = inbound[0]!.attachments[0]!.key
    expect(text(await c.storage.getObject(stored))).toBe(CITY_BYTES)
    expect(await keysUnder(c.storage, `inbound-mail/${threadId}/`)).toEqual([stored])
  })
})

describe("inbox inbound attachments cannot be overwritten by a later mail", () => {
  it("keeps distinct bytes for two mails whose pending keys share one Message-ID slug", async () => {
    const c = ctx()
    const collidingKey = `${INBOUND_PENDING_PREFIX}a_b@x.example.eml`

    expect(
      await deliver(
        c,
        collidingKey,
        mailWithAttachment({
          from: "resident@x.example",
          to: "support@civfix.org",
          messageId: "<a+b@x.example>",
          filename: "photo.jpg",
          content: CITY_BYTES,
        }),
      ),
    ).toBe("inbox")
    expect(
      await deliver(
        c,
        collidingKey,
        mailWithAttachment({
          from: "mallory@x.example",
          to: "support@civfix.org",
          messageId: "<a=b@x.example>",
          filename: "photo.jpg",
          content: ATTACKER_BYTES,
        }),
      ),
    ).toBe("inbox")

    const first = c.inboundRepo.rows.find((r) => r.messageId === "<a+b@x.example>")
    const second = c.inboundRepo.rows.find((r) => r.messageId === "<a=b@x.example>")
    const firstKey = first?.attachments[0]?.key
    const secondKey = second?.attachments[0]?.key
    expect(firstKey).toBeDefined()
    expect(firstKey).not.toBe(secondKey)
    expect(text(await c.storage.getObject(firstKey!))).toBe(CITY_BYTES)
    expect(text(await c.storage.getObject(secondKey!))).toBe(ATTACKER_BYTES)
  })

  it("keeps distinct bytes for two non-pending keys whose Message-IDs sanitize alike", async () => {
    const c = ctx()
    await deliver(
      c,
      "inbound/manual/one.eml",
      mailWithAttachment({
        from: "resident@x.example",
        to: "support@civfix.org",
        messageId: "<a b@x.example>",
        filename: "photo.jpg",
        content: CITY_BYTES,
      }),
    )
    await deliver(
      c,
      "inbound/manual/two.eml",
      mailWithAttachment({
        from: "mallory@x.example",
        to: "support@civfix.org",
        messageId: "<a_b@x.example>",
        filename: "photo.jpg",
        content: ATTACKER_BYTES,
      }),
    )

    const firstKey = c.inboundRepo.rows[0]?.attachments[0]?.key
    const secondKey = c.inboundRepo.rows[1]?.attachments[0]?.key
    expect(firstKey).not.toBe(secondKey)
    expect(text(await c.storage.getObject(firstKey!))).toBe(CITY_BYTES)
  })

  it("leaves no orphan objects when a later mail reuses the Message-ID with other bytes", async () => {
    const c = ctx()
    await deliver(
      c,
      `${INBOUND_PENDING_PREFIX}first.eml`,
      mailWithAttachment({
        from: "resident@x.example",
        to: "support@civfix.org",
        messageId: "<dup@x.example>",
        filename: "photo.jpg",
        content: CITY_BYTES,
      }),
    )
    const outcome = await deliver(
      c,
      `${INBOUND_PENDING_PREFIX}second.eml`,
      mailWithAttachment({
        from: "mallory@x.example",
        to: "support@civfix.org",
        messageId: "<dup@x.example>",
        filename: "photo.jpg",
        content: ATTACKER_BYTES,
      }),
    )
    expect(outcome).toBe("replay")

    const stored = c.inboundRepo.rows[0]!.attachments[0]!.key
    expect(text(await c.storage.getObject(stored))).toBe(CITY_BYTES)
    expect(await keysUnder(c.storage, "inbound-emails/")).toEqual([stored])
  })

  it("stays idempotent when the same pending object is processed twice", async () => {
    const c = ctx()
    const raw = mailWithAttachment({
      from: "resident@x.example",
      to: "support@civfix.org",
      messageId: "<again@x.example>",
      filename: "photo.jpg",
      content: CITY_BYTES,
    })
    const key = `${INBOUND_PENDING_PREFIX}again.eml`
    expect(await deliver(c, key, raw)).toBe("inbox")
    expect(await deliver(c, key, raw)).toBe("replay")

    expect(c.inboundRepo.rows).toHaveLength(1)
    const stored = c.inboundRepo.rows[0]!.attachments[0]!.key
    expect(text(await c.storage.getObject(stored))).toBe(CITY_BYTES)
    expect(await keysUnder(c.storage, "inbound-emails/")).toEqual([stored])
  })
})

function missFirstLookup(repo: InMemoryMailRepository): void {
  const lookup = repo.findMessageByMessageId.bind(repo)
  let calls = 0
  repo.findMessageByMessageId = (messageId) => {
    calls += 1
    return calls === 1 ? Promise.resolve(null) : lookup(messageId)
  }
}

describe("threaded inbound under a Message-ID lookup failure or insert race", () => {
  it("surfaces a lookup failure and leaves the pending object for the sweep", async () => {
    const c = ctx()
    const threadId = seedReportThread(c)
    c.mailRepo.findMessageByMessageId = () => Promise.reject(new Error("db down"))
    const key = `${INBOUND_PENDING_PREFIX}lookup.eml`
    await c.storage.put(
      key,
      mailWithAttachment({
        from: "clerk@city.gov",
        to: REPLY_TO,
        messageId: "<city-4@city.gov>",
        filename: "photo.jpg",
        content: CITY_BYTES,
      }),
    )

    await expect(processInboundObject(c.container, key, c.deps)).rejects.toThrow("db down")

    expect(await c.storage.getObject(key)).not.toBeNull()
    expect(c.mailRepo.messagesOf(threadId).filter((m) => m.direction === "in")).toHaveLength(0)
    expect(await keysUnder(c.storage, `inbound-mail/${threadId}/`)).toEqual([])
  })

  it("discards the loser's attachment objects when a racing insert stored other bytes", async () => {
    const c = ctx()
    const threadId = seedReportThread(c)
    const messageId = "<city-5@city.gov>"
    await deliver(
      c,
      `${INBOUND_PENDING_PREFIX}winner.eml`,
      mailWithAttachment({
        from: "mallory@gmail.com",
        to: REPLY_TO,
        messageId,
        filename: "photo.jpg",
        content: ATTACKER_BYTES,
      }),
    )
    const winnerKey = c.mailRepo.messagesOf(threadId).find((m) => m.direction === "in")!
      .attachments[0]!.key

    missFirstLookup(c.mailRepo)
    const outcome = await deliver(
      c,
      `${INBOUND_PENDING_PREFIX}loser.eml`,
      mailWithAttachment({
        from: "clerk@city.gov",
        to: REPLY_TO,
        messageId,
        filename: "photo.jpg",
        content: CITY_BYTES,
      }),
    )

    expect(outcome).toBe("replay")
    expect(await keysUnder(c.storage, `inbound-mail/${threadId}/`)).toEqual([winnerKey])
    expect(text(await c.storage.getObject(winnerKey))).toBe(ATTACKER_BYTES)
  })

  it("keeps the objects the winner references when the same mail raced itself", async () => {
    const c = ctx()
    const threadId = seedReportThread(c)
    const raw = mailWithAttachment({
      from: "clerk@city.gov",
      to: REPLY_TO,
      messageId: "<city-6@city.gov>",
      filename: "photo.jpg",
      content: CITY_BYTES,
    })
    expect(await deliver(c, `${INBOUND_PENDING_PREFIX}one.eml`, raw)).toBe("threaded")
    const stored = c.mailRepo.messagesOf(threadId).find((m) => m.direction === "in")!
      .attachments[0]!.key

    missFirstLookup(c.mailRepo)
    expect(await deliver(c, `${INBOUND_PENDING_PREFIX}two.eml`, raw)).toBe("replay")

    expect(await keysUnder(c.storage, `inbound-mail/${threadId}/`)).toEqual([stored])
    expect(text(await c.storage.getObject(stored))).toBe(CITY_BYTES)
  })

  it("never deletes an identical attachment another message of the thread still holds", async () => {
    const c = ctx()
    const threadId = seedReportThread(c)
    await deliver(
      c,
      `${INBOUND_PENDING_PREFIX}earlier.eml`,
      mailWithAttachment({
        from: "clerk@city.gov",
        to: REPLY_TO,
        messageId: "<city-7@city.gov>",
        filename: "photo.jpg",
        content: CITY_BYTES,
      }),
    )
    const earlierKey = c.mailRepo.messagesOf(threadId).find((m) => m.direction === "in")!
      .attachments[0]!.key
    c.mailRepo.seedMessage({
      threadId: c.mailRepo.seedThread({ threadToken: "fedcba9876543210fedcba98" }).id,
      direction: "in",
      messageId: "<elsewhere@city.gov>",
    })

    missFirstLookup(c.mailRepo)
    await deliver(
      c,
      `${INBOUND_PENDING_PREFIX}resend.eml`,
      mailWithAttachment({
        from: "clerk@city.gov",
        to: REPLY_TO,
        messageId: "<elsewhere@city.gov>",
        filename: "photo.jpg",
        content: CITY_BYTES,
      }),
    )

    expect(text(await c.storage.getObject(earlierKey))).toBe(CITY_BYTES)
  })
})
