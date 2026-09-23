import { describe, expect, it, vi } from "vitest"
import { FakeInboundMail, FakeJobs, FakeStorage } from "@civfix/shared/fakes"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { InMemoryInboundRepository } from "../../src/services/admin/inbound-repository.memory.js"
import {
  processInboundObject,
  INBOUND_PENDING_PREFIX,
  type InboundProcessorDeps,
} from "../../src/services/admin/inbound-processor.js"
import type { Container } from "../../src/di.js"
import { makeFakeSql } from "../helpers/fake-sql.js"

const GEOID = "0644000"
const FAILED = "clerk@lacity.gov"
const OUTBOUND_ID = "<out-42@civfix.org>"
const KEY = `${INBOUND_PENDING_PREFIX}dsn-1.eml`

function dsnBytes(): Buffer {
  return Buffer.from(
    [
      "From: mailer-daemon@lacity.gov",
      "To: outreach@civfix.org",
      "Message-ID: <dsn-1@lacity.gov>",
      `X-Failed-Recipients: ${FAILED}`,
      "",
      "Your message could not be delivered.",
      `Original-Message-ID: ${OUTBOUND_ID}`,
    ].join("\n"),
    "utf8",
  )
}

function setup() {
  const storage = new FakeStorage()
  const mailRepo = new InMemoryMailRepository()
  const inboundRepo = new InMemoryInboundRepository()
  const jobs = new FakeJobs()
  const db = makeFakeSql([
    { match: /UPDATE\s+jurisdiction_contacts\s+SET\s+bounced_at/i, rows: [] },
    { match: /FROM\s+mail_messages/i, rows: [{ ok: true }] },
  ])
  const warn = vi.fn()
  const deps: InboundProcessorDeps = {
    storage,
    inboundMail: new FakeInboundMail(),
    mailRepo,
    inboundRepo,
    logger: { warn, error: vi.fn() },
  }
  const container = {
    env: {},
    storage,
    inboundStorage: storage,
    inboundMail: deps.inboundMail,
    jobs,
    getDb: () => ({ sql: db.sql }),
  } as unknown as Container
  const thread = mailRepo.seedThread({ jurisdictionGeoid: GEOID, status: "sent" })
  mailRepo.seedMessage({ threadId: thread.id, direction: "out", messageId: OUTBOUND_ID })
  return { storage, mailRepo, jobs, deps, container, thread, warn }
}

function bouncedEvents(repo: InMemoryMailRepository) {
  return repo.events.filter((e) => e.type === "bounced")
}

describe("bounce bookkeeping survives a transient failure", () => {
  it("keeps the pending object and logs when the bookkeeping fails, then completes it on the next run", async () => {
    const s = setup()
    const realRecordEvent = s.mailRepo.recordEvent.bind(s.mailRepo)
    let failures = 1
    s.mailRepo.recordEvent = (input) => {
      if (input.type === "bounced" && failures > 0) {
        failures -= 1
        return Promise.reject(new Error("db connection reset"))
      }
      return realRecordEvent(input)
    }
    await s.storage.put(KEY, dsnBytes())

    const first = await processInboundObject(s.container, KEY, s.deps)
    expect(first.outcome).toBe("inbox")
    expect(await s.storage.getObject(KEY)).not.toBeNull()
    expect(s.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: KEY, originalMessageId: OUTBOUND_ID }),
      expect.any(String),
    )
    expect(bouncedEvents(s.mailRepo)).toHaveLength(0)

    const second = await processInboundObject(s.container, KEY, s.deps)
    expect(second.outcome).toBe("replay")
    expect(await s.storage.getObject(KEY)).toBeNull()
    expect(bouncedEvents(s.mailRepo)).toHaveLength(1)
    expect((await s.mailRepo.getThreadRecord(s.thread.id))?.status).toBe("bounced")
  })

  it("does not record a second bounce or reset the status when a finished DSN is delivered again", async () => {
    const s = setup()
    await s.storage.put(KEY, dsnBytes())
    await processInboundObject(s.container, KEY, s.deps)
    expect(bouncedEvents(s.mailRepo)).toHaveLength(1)
    await s.mailRepo.setThreadStatus(s.thread.id, "replied")

    await s.storage.put(KEY, dsnBytes())
    const again = await processInboundObject(s.container, KEY, s.deps)
    expect(again.outcome).toBe("replay")
    expect(await s.storage.getObject(KEY)).toBeNull()
    expect(bouncedEvents(s.mailRepo)).toHaveLength(1)
    expect((await s.mailRepo.getThreadRecord(s.thread.id))?.status).toBe("replied")
  })
})
