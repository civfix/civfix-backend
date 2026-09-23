import { describe, expect, it, vi } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import type { Mailer } from "@civfix/shared/interfaces"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { InMemoryBroadcastRepository } from "../../src/services/host/broadcast-repository.memory.js"
import { makeDrizzleBroadcastRepository } from "../../src/services/host/broadcast-repository.drizzle.js"
import {
  BroadcastCapError,
  capError,
  makeBroadcastService,
  type BroadcastConfig,
} from "../../src/services/host/broadcast-service.js"
import { makeBroadcastPipeline } from "../../src/services/host/broadcast-pipeline.js"
import { makeBroadcastLanes } from "../../src/services/host/broadcast-lanes.js"
import type { NotificationService } from "../../src/services/notification-service.js"
import type { Sql } from "../../src/db/client.js"
import { makeFakeSql } from "../helpers/fake-sql.js"

const EVENT = "00000000-0000-0000-0000-0000000000ee"
const HOST = "00000000-0000-0000-0000-0000000000aa"
const MEMBER = "00000000-0000-0000-0000-000000000001"

const CONFIG: BroadcastConfig = {
  killSwitch: false,
  perEventPerDay: 5,
  recipientsPerDay: 1000,
  cooldownSec: 900,
  minAccountAgeHours: 24,
  maxRecipients: 5000,
  chunkSize: 200,
  emailConcurrency: 1,
  emailRatePerSec: 1000,
  linkAllowedHosts: [],
  mailFromEvents: "events@civfix.org",
  unsubscribeSigningKey: "unsubscribe-signing-key-for-tests-0123456789",
  webBaseUrl: "https://civfix.org",
  apiBaseUrl: "https://api.civfix.org",
  eventUpdatePerEventPerHour: 3,
}

function logSpy() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function build(
  overrides: {
    config?: Partial<BroadcastConfig>
    enqueuePlan?: (broadcastId: string) => Promise<void>
  } = {},
) {
  const repo = new InMemoryBroadcastRepository()
  repo.seedEvent({
    cleanupId: EVENT,
    title: "Beach Cleanup",
    pageSlug: "beach-cleanup",
    scheduledAt: new Date("2026-02-01T17:00:00Z"),
    endsAt: null,
    timezone: "UTC",
    address: null,
    status: "upcoming",
    organizerUserId: HOST,
    replyTo: null,
    replyToVerified: false,
  })
  repo.seedHost(HOST, { accountCreatedAt: new Date("2020-01-01T00:00:00Z") })
  const counters = new InMemoryCounterStore()
  const logger = logSpy()
  const service = makeBroadcastService({
    repo,
    counters,
    config: { ...CONFIG, ...overrides.config },
    mailer: new FakeMailer(),
    enqueuePlan: overrides.enqueuePlan ?? (() => Promise.resolve()),
    logger,
  })
  return { repo, counters, service, logger }
}

async function draft(repo: InMemoryBroadcastRepository): Promise<string> {
  const record = await repo.create({
    cleanupId: EVENT,
    createdBy: HOST,
    kind: "host_broadcast",
    subject: "Bring gloves",
    bodyMd: "See you at the meeting point.",
    segment: { kind: "all_registered" },
    channels: ["email"],
    status: "draft",
  })
  return record.id
}

describe("host daily recipient budget", () => {
  it("does not charge the budget for a send it refused", async () => {
    const { service } = build({ config: { recipientsPerDay: 1000 } })
    expect(await service.reserveRecipientBudget(HOST, 900)).toBe(true)
    expect(await service.reserveRecipientBudget(HOST, 200)).toBe(false)
    expect(await service.reserveRecipientBudget(HOST, 50)).toBe(true)
  })

  it("still refuses a send that would cross the budget after a refund", async () => {
    const { service } = build({ config: { recipientsPerDay: 1000 } })
    expect(await service.reserveRecipientBudget(HOST, 900)).toBe(true)
    expect(await service.reserveRecipientBudget(HOST, 200)).toBe(false)
    expect(await service.reserveRecipientBudget(HOST, 101)).toBe(false)
    expect(await service.reserveRecipientBudget(HOST, 100)).toBe(true)
    expect(await service.reserveRecipientBudget(HOST, 1)).toBe(false)
  })

  it("keeps the refusal when the refund cannot be recorded, and logs it", async () => {
    const { service, counters, logger } = build({ config: { recipientsPerDay: 10 } })
    const incrBy = counters.incrBy.bind(counters)
    counters.incrBy = (key, by, ttl) =>
      key.endsWith(":refunded") && by > 0
        ? Promise.reject(new Error("redis down"))
        : incrBy(key, by, ttl)
    expect(await service.reserveRecipientBudget(HOST, 11)).toBe(false)
    expect(logger.warn).toHaveBeenCalled()
  })
})

describe("send when the plan job cannot be enqueued", () => {
  it("returns the broadcast to draft and rethrows", async () => {
    const { repo, service } = build({ enqueuePlan: () => Promise.reject(new Error("queue down")) })
    const id = await draft(repo)
    await expect(service.send(EVENT, HOST, id)).rejects.toThrow("queue down")
    const after = await repo.findById(id)
    expect(after?.status).toBe("draft")
    expect(after?.startedAt).toBeNull()
  })

  it("returns a scheduled broadcast to scheduled", async () => {
    const { repo, service } = build({ enqueuePlan: () => Promise.reject(new Error("queue down")) })
    const id = await draft(repo)
    await repo.transition(id, ["draft"], "scheduled", { scheduledAt: new Date(Date.now() + 1e6) })
    await expect(service.send(EVENT, HOST, id)).rejects.toThrow("queue down")
    expect((await repo.findById(id))?.status).toBe("scheduled")
  })
})

describe("empty draft patch", () => {
  it("returns the unchanged draft without writing", async () => {
    const { repo, service } = build()
    const id = await draft(repo)
    const updateDraft = vi.spyOn(repo, "updateDraft")
    const dto = await service.update(EVENT, HOST, { id: EVENT, broadcastId: id })
    expect(dto.id).toBe(id)
    expect(dto.subject).toBe("Bring gloves")
    expect(updateDraft).not.toHaveBeenCalled()
  })

  it("still refuses an empty patch on a message that already left draft", async () => {
    const { repo, service } = build()
    const id = await draft(repo)
    await repo.transition(id, ["draft"], "sending", { startedAt: new Date() })
    await expect(service.update(EVENT, HOST, { id: EVENT, broadcastId: id })).rejects.toMatchObject(
      { code: "CONFLICT" },
    )
  })

  it("names the broken invariant instead of a reduce TypeError in the SQL repository", async () => {
    const fake = makeFakeSql()
    const repo = makeDrizzleBroadcastRepository(fake.sql as unknown as Sql)
    await expect(repo.updateDraft(EVENT, MEMBER, {})).rejects.toThrow(/at least one column/)
    expect(fake.statements).toHaveLength(0)
  })
})

describe("test-send cap", () => {
  it("reports its own cap kind and copy, not the per-event daily limit", async () => {
    const { repo, service } = build()
    const id = await draft(repo)
    repo.seedMembers(EVENT, [{ userId: HOST }])
    let kind = "none"
    for (let i = 0; i < 10 && kind === "none"; i += 1) {
      try {
        await service.testSend(EVENT, HOST, id)
      } catch (err) {
        if (!(err instanceof BroadcastCapError)) throw err
        kind = err.kind
      }
    }
    expect(kind).toBe("test_sends")
    expect(capError("test_sends").code).toBe("RATE_LIMITED")
    expect(capError("test_sends").message).not.toMatch(/daily message limit/)
  })
})

describe("hard-bounce suppression write failure", () => {
  it("is logged, and the delivery is still recorded as a permanent failure", async () => {
    const repo = new InMemoryBroadcastRepository()
    repo.seedEvent({
      cleanupId: EVENT,
      title: "Beach Cleanup",
      pageSlug: "beach-cleanup",
      scheduledAt: new Date("2026-02-01T17:00:00Z"),
      endsAt: null,
      timezone: "UTC",
      address: null,
      status: "upcoming",
      organizerUserId: HOST,
      replyTo: null,
      replyToVerified: false,
    })
    repo.seedHost(HOST, { accountCreatedAt: new Date("2020-01-01T00:00:00Z") })
    repo.seedMembers(EVENT, [{ userId: MEMBER }])
    repo.seedGuests(EVENT, [])
    repo.suppressEmail = () => Promise.reject(new Error("db down"))
    const bounces: Mailer = {
      sendOtp: () => Promise.resolve(),
      sendTransactional: () => Promise.resolve(),
      sendOutbound: () => Promise.reject({ responseCode: 550, response: "550 no such user" }),
    }
    const logger = logSpy()
    const service = makeBroadcastService({
      repo,
      counters: new InMemoryCounterStore(),
      config: CONFIG,
      mailer: bounces,
      enqueuePlan: () => Promise.resolve(),
    })
    const pipeline = makeBroadcastPipeline({
      repo,
      service,
      notifications: {
        createNotifications: () => Promise.resolve(),
      } as unknown as NotificationService,
      mailer: bounces,
      cache: new InMemoryCacheClient(),
      config: CONFIG,
      mailDomain: "civfix.org",
      enqueueChunk: () => Promise.resolve(),
      audit: () => Promise.resolve(),
      logger,
    })
    const id = await draft(repo)
    await repo.transition(id, ["draft"], "sending", { startedAt: new Date() })
    await pipeline.plan(id)
    await pipeline.runChunk(id, 0)

    expect(repo.allDeliveries()[0]?.failureKind).toBe("permanent")
    const messages = logger.warn.mock.calls.map((call) => String(call[1]))
    expect(messages.some((m) => /suppression/.test(m))).toBe(true)
    const logged = JSON.stringify(logger.warn.mock.calls)
    expect(logged).not.toContain("@")
  })
})

describe("automated lanes stamp startedAt on insert", () => {
  it("gives a reminder broadcast a start time", async () => {
    const repo = new InMemoryBroadcastRepository()
    const at = new Date("2026-01-31T17:00:00Z")
    repo.seedEvent({
      cleanupId: EVENT,
      title: "Beach Cleanup",
      pageSlug: "beach-cleanup",
      scheduledAt: new Date("2026-02-01T17:00:00Z"),
      endsAt: null,
      timezone: "UTC",
      address: null,
      status: "upcoming",
      organizerUserId: HOST,
      replyTo: null,
      replyToVerified: false,
    })
    repo.listDueReminders = () => Promise.resolve([{ cleanupId: EVENT, offsetMin: 1440 }])
    const plans: string[] = []
    const lanes = makeBroadcastLanes({
      repo,
      counters: new InMemoryCounterStore(),
      perEventPerHour: 3,
      enqueuePlan: (broadcastId) => {
        plans.push(broadcastId)
        return Promise.resolve()
      },
      now: () => at,
    })
    await lanes.runReminderSweep()
    expect(plans).toHaveLength(1)
    expect((await repo.findById(plans[0]!))?.startedAt?.toISOString()).toBe(at.toISOString())
  })

  it("stamps the cancellation and event-update lanes without a second status write", async () => {
    const repo = new InMemoryBroadcastRepository()
    const at = new Date("2026-01-31T17:00:00Z")
    repo.seedEvent({
      cleanupId: EVENT,
      title: "Beach Cleanup",
      pageSlug: "beach-cleanup",
      scheduledAt: new Date("2026-02-01T17:00:00Z"),
      endsAt: null,
      timezone: "UTC",
      address: null,
      status: "upcoming",
      organizerUserId: HOST,
      replyTo: null,
      replyToVerified: false,
    })
    const transition = vi.spyOn(repo, "transition")
    const lanes = makeBroadcastLanes({
      repo,
      counters: new InMemoryCounterStore(),
      perEventPerHour: 3,
      enqueuePlan: () => Promise.resolve(),
      now: () => at,
    })
    const updated = await lanes.eventUpdated(EVENT)
    const cancelled = await lanes.eventCancelled(EVENT, null)
    expect(updated.status).toBe("started")
    const updatedId = updated.status === "started" ? updated.broadcastId : ""
    expect((await repo.findById(updatedId))?.startedAt?.toISOString()).toBe(at.toISOString())
    expect((await repo.findById(cancelled!))?.startedAt?.toISOString()).toBe(at.toISOString())
    expect(transition).not.toHaveBeenCalled()
  })
})

describe("in-memory broadcast repository matches the SQL semantics", () => {
  it("only dedupes the kinds a unique index covers", async () => {
    const repo = new InMemoryBroadcastRepository()
    const input = {
      cleanupId: EVENT,
      createdBy: null,
      kind: "event_updated" as const,
      subject: "s",
      bodyMd: "b",
      segment: { kind: "all_registered" as const },
      channels: ["email" as const],
      status: "sending" as const,
    }
    expect(await repo.createIfAbsent(input)).not.toBeNull()
    expect(await repo.createIfAbsent(input)).not.toBeNull()
    const cancelled = { ...input, kind: "event_cancelled" as const }
    expect(await repo.createIfAbsent(cancelled)).not.toBeNull()
    expect(await repo.createIfAbsent(cancelled)).toBeNull()
    const reminder = { ...input, kind: "reminder" as const, reminderOffsetMin: 180 }
    expect(await repo.createIfAbsent(reminder)).not.toBeNull()
    expect(await repo.createIfAbsent(reminder)).toBeNull()
  })

  it("pages the broadcast list by its cursor", async () => {
    const { repo, service } = build()
    const ids: string[] = []
    for (let i = 0; i < 3; i += 1) ids.push(await draft(repo))
    const first = await service.list(EVENT, { id: EVENT, limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const second = await service.list(EVENT, {
      id: EVENT,
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    })
    const seen = [...first.items, ...second.items].map((item) => item.id)
    expect(new Set(seen).size).toBe(3)
    expect(new Set(seen)).toEqual(new Set(ids))
  })

  it("pages the delivery list by its cursor", async () => {
    const repo = new InMemoryBroadcastRepository()
    const id = await draft(repo)
    await repo.insertDeliveries(
      Array.from({ length: 3 }, (_, i) => ({
        broadcastId: id,
        chunkNo: 0,
        recipientKind: "member" as const,
        userId: `00000000-0000-0000-0000-00000000010${i}`,
        guestId: null,
        channel: "email" as const,
      })),
    )
    const first = await repo.listDeliveries({ broadcastId: id, cursor: null, limit: 2 })
    const last = first.at(-1)!
    const second = await repo.listDeliveries({
      broadcastId: id,
      cursor: { createdAt: last.createdAt, id: last.id },
      limit: 2,
    })
    const seen = [...first, ...second].map((row) => row.id)
    expect(new Set(seen).size).toBe(3)
  })
})
