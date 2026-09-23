import { describe, expect, it, vi } from "vitest"
import type { BroadcastKind } from "@civfix/shared"
import { FakeMailer } from "@civfix/shared/fakes"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { insightsGenerationKey } from "../../src/services/host/host-analytics-cache.js"
import { InMemoryBroadcastRepository } from "../helpers/host/broadcast-repository.memory.js"
import {
  makeBroadcastService,
  type BroadcastConfig,
} from "../../src/services/host/broadcast-service.js"
import { makeBroadcastPipeline } from "../../src/services/host/broadcast-pipeline.js"
import type { NotificationService } from "../../src/services/notification-service.js"

const EVENT = "00000000-0000-0000-0000-0000000000ee"
const HOST = "00000000-0000-0000-0000-0000000000aa"
const MEMBER_COUNT = 3
const STALE_SENDING_AGE_MS = 60 * 60 * 1000

const CONFIG: BroadcastConfig = {
  killSwitch: false,
  perEventPerDay: 3,
  recipientsPerDay: 2000,
  cooldownSec: 900,
  minAccountAgeHours: 24,
  maxRecipients: 5000,
  chunkSize: 2,
  emailConcurrency: 2,
  emailRatePerSec: 1000,
  linkAllowedHosts: [],
  mailFromEvents: "events@civfix.org",
  unsubscribeSigningKey: "unsubscribe-signing-key-for-tests-0123456789",
  webBaseUrl: "http://localhost:3000",
  apiBaseUrl: "http://localhost:8080",
  eventUpdatePerEventPerHour: 3,
}

function memberId(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`
}

function harness(options: { organizationSuspended: boolean }) {
  const repo = new InMemoryBroadcastRepository()
  repo.seedEvent({
    cleanupId: EVENT,
    title: "Beach Cleanup",
    pageSlug: "beach-cleanup",
    scheduledAt: new Date("2026-02-01T17:00:00Z"),
    endsAt: null,
    timezone: "America/Los_Angeles",
    address: "Ocean Ave",
    status: "upcoming",
    organizerUserId: HOST,
    organizationSuspended: options.organizationSuspended,
    replyTo: null,
    replyToVerified: false,
  })
  repo.seedHost(HOST, { accountCreatedAt: new Date("2020-01-01T00:00:00Z") })
  repo.seedMembers(
    EVENT,
    Array.from({ length: MEMBER_COUNT }, (_, i) => ({ userId: memberId(i + 1) })),
  )
  repo.seedGuests(EVENT, [])
  const cache = new InMemoryCacheClient()
  const counters = new InMemoryCounterStore()
  const mailer = new FakeMailer()
  const counterKeys: string[] = []
  const incr = counters.incr.bind(counters)
  counters.incr = (key, ttl) => {
    counterKeys.push(key)
    return incr(key, ttl)
  }
  const service = makeBroadcastService({
    repo,
    counters,
    config: CONFIG,
    mailer,
    enqueuePlan: () => Promise.resolve(),
  })
  const chunks: number[] = []
  const audits: Array<{ action: string; target: string; meta: Record<string, unknown> }> = []
  const pipeline = makeBroadcastPipeline({
    repo,
    service,
    notifications: {
      createNotifications: () => Promise.resolve(),
      createNotificationsReportingFailures: () => Promise.resolve({ failed: [] }),
    } as unknown as NotificationService,
    mailer,
    cache,
    config: CONFIG,
    mailDomain: "civfix.org",
    enqueueChunk: (_id, chunkNo) => {
      chunks.push(chunkNo)
      return Promise.resolve()
    },
    audit: (action, _actorId, target, meta) => {
      audits.push({ action, target, meta })
      return Promise.resolve()
    },
  })
  return { repo, cache, mailer, pipeline, chunks, counterKeys, audits }
}

type Harness = ReturnType<typeof harness>

async function seedBroadcast(
  h: Harness,
  kind: BroadcastKind,
  status: "scheduled" | "sending",
): Promise<string> {
  const record = await h.repo.create({
    cleanupId: EVENT,
    createdBy: kind === "event_cancelled" || kind === "event_updated" ? null : HOST,
    kind,
    subject: "Bring gloves",
    bodyMd: "See you there.",
    segment: { kind: "all_registered" },
    channels: ["email"],
    status: status === "scheduled" ? "scheduled" : "draft",
    ...(status === "scheduled" ? { scheduledAt: new Date(Date.now() - 1000) } : {}),
  })
  if (status === "sending") {
    await h.repo.transition(record.id, ["draft"], "sending", { startedAt: new Date() })
  }
  return record.id
}

async function generation(h: Harness): Promise<number> {
  return Number((await h.cache.get(insightsGenerationKey(EVENT))) ?? 0)
}

describe("scheduled release under a suspended organization", () => {
  it("fails a due host broadcast instead of sending it, and burns no send slot", async () => {
    const h = harness({ organizationSuspended: true })
    const id = await seedBroadcast(h, "host_broadcast", "scheduled")
    const before = await generation(h)

    const result = await h.pipeline.sweep()

    expect(result.released).toBe(0)
    const after = await h.repo.findById(id)
    expect(after?.status).toBe("failed")
    expect(after?.finishedAt).not.toBeNull()
    expect(after?.plannedAt).toBeNull()
    expect(h.repo.allDeliveries()).toHaveLength(0)
    expect(h.chunks).toHaveLength(0)
    expect(h.counterKeys).toHaveLength(0)
    expect(await generation(h)).toBeGreaterThan(before)
  })

  it("fails a due host-composed thank-you the same way", async () => {
    const h = harness({ organizationSuspended: true })
    const id = await seedBroadcast(h, "thank_you", "scheduled")

    await h.pipeline.sweep()

    expect((await h.repo.findById(id))?.status).toBe("failed")
    expect(h.repo.allDeliveries()).toHaveLength(0)
  })

  it("still releases a due host broadcast when the organization is in good standing", async () => {
    const h = harness({ organizationSuspended: false })
    const id = await seedBroadcast(h, "host_broadcast", "scheduled")

    const result = await h.pipeline.sweep()

    expect(result.released).toBe(1)
    expect((await h.repo.findById(id))?.plannedAt).not.toBeNull()
    expect(h.repo.allDeliveries()).toHaveLength(MEMBER_COUNT)
  })
})

describe("plan under a suspended organization", () => {
  it("stops an already-queued plan of a host broadcast", async () => {
    const h = harness({ organizationSuspended: true })
    const id = await seedBroadcast(h, "host_broadcast", "sending")
    const before = await generation(h)

    const outcome = await h.pipeline.plan(id)

    expect(outcome.kind).toBe("org_suspended")
    expect((await h.repo.findById(id))?.status).toBe("failed")
    expect(h.repo.allDeliveries()).toHaveLength(0)
    expect(h.chunks).toHaveLength(0)
    expect(await generation(h)).toBeGreaterThan(before)
  })

  it("stops an announcement too", async () => {
    const h = harness({ organizationSuspended: true })
    const id = await seedBroadcast(h, "announcement", "sending")

    expect((await h.pipeline.plan(id)).kind).toBe("org_suspended")
    expect((await h.repo.findById(id))?.status).toBe("failed")
  })

  it("never blocks a critical automated notice: attendees still learn the event is off", async () => {
    const h = harness({ organizationSuspended: true })
    const id = await seedBroadcast(h, "event_cancelled", "sending")

    const outcome = await h.pipeline.plan(id)

    expect(outcome.kind).toBe("planned")
    expect(h.repo.allDeliveries()).toHaveLength(MEMBER_COUNT)
  })
})

describe("a chunk under an organization suspended after planning", () => {
  it("delivers nothing and fails the broadcast with the suspension reason", async () => {
    const h = harness({ organizationSuspended: false })
    const id = await seedBroadcast(h, "host_broadcast", "sending")
    expect((await h.pipeline.plan(id)).kind).toBe("planned")
    const before = await generation(h)

    h.repo.setEventOrganizationSuspended(EVENT, true)
    await h.pipeline.runChunk(id, h.chunks[0]!)

    expect(h.mailer.sent).toHaveLength(0)
    expect((await h.repo.findById(id))?.status).toBe("failed")
    const deliveries = h.repo.allDeliveries()
    expect(deliveries).toHaveLength(MEMBER_COUNT)
    expect(deliveries.every((d) => d.status === "suppressed")).toBe(true)
    expect(await generation(h)).toBeGreaterThan(before)
    expect(h.audits).toEqual([
      {
        action: "event.broadcast_killed",
        target: `broadcast:${id}`,
        meta: expect.objectContaining({ reason: "org_suspended", cleanupId: EVENT }) as unknown,
      },
    ])
  })

  it("stops a chunk the stale-sending sweep resumes", async () => {
    const h = harness({ organizationSuspended: false })
    const id = await seedBroadcast(h, "host_broadcast", "sending")
    await h.pipeline.plan(id)
    const planned = h.chunks.length

    h.repo.setEventOrganizationSuspended(EVENT, true)
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(Date.now() + STALE_SENDING_AGE_MS)
      expect((await h.pipeline.sweep()).resumed).toBe(1)
      for (const chunkNo of h.chunks.slice(planned)) await h.pipeline.runChunk(id, chunkNo)
    } finally {
      vi.useRealTimers()
    }

    expect(h.mailer.sent).toHaveLength(0)
    expect((await h.repo.findById(id))?.status).toBe("failed")
  })

  it("still delivers a critical automated notice", async () => {
    const h = harness({ organizationSuspended: false })
    const id = await seedBroadcast(h, "event_cancelled", "sending")
    await h.pipeline.plan(id)

    h.repo.setEventOrganizationSuspended(EVENT, true)
    for (const chunkNo of h.chunks) await h.pipeline.runChunk(id, chunkNo)

    expect(h.mailer.sent.length).toBeGreaterThan(0)
    expect((await h.repo.findById(id))?.status).toBe("sent")
    expect(h.audits).toHaveLength(0)
  })
})
