import { describe, expect, it, vi } from "vitest"
import { FakeInboundMail, FakeJobs, FakeStorage } from "@civfix/shared/fakes"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { InMemoryInboundRepository } from "../../src/services/admin/inbound-repository.memory.js"
import {
  processInboundObject,
  INBOUND_BOUNCE_MAX_ATTEMPTS,
  INBOUND_PENDING_PREFIX,
  type InboundProcessorDeps,
} from "../../src/services/admin/inbound-processor.js"
import type { Container } from "../../src/di.js"
import { makeFakeSql } from "../helpers/fake-sql.js"
import type { Sql } from "../../src/db/client.js"
import { makeDrizzleMailRepository } from "../../src/services/admin/mail-repository.drizzle.js"
import { JURISDICTION_DISCOVERY_JOB } from "../../src/lib/queue-names.js"

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
  return { storage, mailRepo, inboundRepo, jobs, deps, container, thread, warn }
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

describe("bounce discovery sees the bounce it was enqueued for", () => {
  it("records the bounced event before it enqueues discovery", async () => {
    const s = setup()
    const eventsAtEnqueue: number[] = []
    const realEnqueue = s.jobs.enqueue.bind(s.jobs)
    s.jobs.enqueue = (name, data, opts) => {
      if (name === JURISDICTION_DISCOVERY_JOB)
        eventsAtEnqueue.push(bouncedEvents(s.mailRepo).length)
      return realEnqueue(name, data, opts)
    }
    await s.storage.put(KEY, dsnBytes())
    await processInboundObject(s.container, KEY, s.deps)
    expect(eventsAtEnqueue).toEqual([1])
  })

  it("re-enqueues discovery on the next run when the enqueue failed after the bounce was recorded", async () => {
    const s = setup()
    const realEnqueue = s.jobs.enqueue.bind(s.jobs)
    let failures = 1
    s.jobs.enqueue = (name, data, opts) => {
      if (name === JURISDICTION_DISCOVERY_JOB && failures > 0) {
        failures -= 1
        return Promise.reject(new Error("pg-boss unavailable"))
      }
      return realEnqueue(name, data, opts)
    }
    await s.storage.put(KEY, dsnBytes())
    await processInboundObject(s.container, KEY, s.deps)
    expect(await s.storage.getObject(KEY)).not.toBeNull()
    expect(bouncedEvents(s.mailRepo)).toHaveLength(1)
    await s.mailRepo.setThreadStatus(s.thread.id, "replied")

    await processInboundObject(s.container, KEY, s.deps)
    expect(await s.storage.getObject(KEY)).toBeNull()
    expect(s.jobs.jobsFor(JURISDICTION_DISCOVERY_JOB)).toHaveLength(1)
    expect(bouncedEvents(s.mailRepo)).toHaveLength(1)
    expect((await s.mailRepo.getThreadRecord(s.thread.id))?.status).toBe("replied")
  })
})

describe("a DSN whose bounce bookkeeping never succeeds", () => {
  const FAILED_KEY = KEY.replace(INBOUND_PENDING_PREFIX, "inbound/failed/")

  function failEveryBounceEvent(s: ReturnType<typeof setup>): void {
    s.mailRepo.recordEvent = (input) =>
      input.type === "bounced"
        ? Promise.reject(new Error("constraint violation"))
        : Promise.resolve("event-id")
  }

  it("stays pending until the attempt cap, then is parked under inbound/failed/", async () => {
    const s = setup()
    failEveryBounceEvent(s)
    await s.storage.put(KEY, dsnBytes())

    for (let attempt = 1; attempt < INBOUND_BOUNCE_MAX_ATTEMPTS; attempt += 1) {
      await processInboundObject(s.container, KEY, s.deps)
      expect(await s.storage.getObject(KEY)).not.toBeNull()
    }
    const last = await processInboundObject(s.container, KEY, s.deps)

    expect(last).toMatchObject({ outcome: "failed", reason: "bounce-bookkeeping" })
    expect(await s.storage.getObject(KEY)).toBeNull()
    expect(await s.storage.getObject(FAILED_KEY)).not.toBeNull()
    expect(s.inboundRepo.bounceAttempts.size).toBe(0)
  })

  it("forgets earlier failures once the bookkeeping succeeds", async () => {
    const s = setup()
    const realRecordEvent = s.mailRepo.recordEvent.bind(s.mailRepo)
    let failures = INBOUND_BOUNCE_MAX_ATTEMPTS - 1
    s.mailRepo.recordEvent = (input) => {
      if (input.type === "bounced" && failures > 0) {
        failures -= 1
        return Promise.reject(new Error("constraint violation"))
      }
      return realRecordEvent(input)
    }
    await s.storage.put(KEY, dsnBytes())
    for (let attempt = 1; attempt < INBOUND_BOUNCE_MAX_ATTEMPTS; attempt += 1) {
      await processInboundObject(s.container, KEY, s.deps)
    }
    const done = await processInboundObject(s.container, KEY, s.deps)

    expect(done.outcome).toBe("replay")
    expect(await s.storage.getObject(KEY)).toBeNull()
    expect(await s.storage.getObject(FAILED_KEY)).toBeNull()
    expect(s.inboundRepo.bounceAttempts.size).toBe(0)
  })
})

describe("the stored bounce marker", () => {
  const marker = { threadId: "t-1", failedRecipient: FAILED, originalMessageId: OUTBOUND_ID }

  it("reads as none, discovery pending, or complete", async () => {
    const cases = [
      [{ recorded: false, complete: false }, "none"],
      [{ recorded: true, complete: false }, "discovery_pending"],
      [{ recorded: true, complete: true }, "complete"],
    ] as const
    for (const [row, state] of cases) {
      const fake = makeFakeSql([{ match: /FROM mail_events/, rows: [row] }])
      const repo = makeDrizzleMailRepository(fake.sql as unknown as Sql)
      expect(await repo.bounceEventState(marker)).toBe(state)
    }
  })

  it("clears only the pending flag once discovery is enqueued", async () => {
    const fake = makeFakeSql()
    await makeDrizzleMailRepository(fake.sql as unknown as Sql).markBounceDiscoveryEnqueued(marker)
    const update = fake.statements[0]
    expect(update?.sql).toMatch(/SET meta = meta - \?::text/)
    expect(update?.values).toContain("discoveryPending")
    expect(update?.sql).toMatch(/type = 'bounced'/)
  })
})
