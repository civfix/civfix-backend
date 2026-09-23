import { beforeEach, describe, expect, it, vi } from "vitest"
import { BROADCAST_VARS } from "@civfix/shared/host"
import { FakeMailer } from "@civfix/shared/fakes"
import type { Mailer, OutboundEmail, SentMail } from "@civfix/shared/interfaces"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { insightsGenerationKey } from "../../src/services/host/host-analytics-cache.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { InMemoryBroadcastRepository } from "../../src/services/host/broadcast-repository.memory.js"
import {
  emailHashOf,
  makeBroadcastService,
  type BroadcastConfig,
} from "../../src/services/host/broadcast-service.js"
import {
  AUTH_ABORT_BACKOFF_SEC,
  makeBroadcastPipeline,
} from "../../src/services/host/broadcast-pipeline.js"
import type { NotificationService } from "../../src/services/notification-service.js"
import type { EventBroadcastContext } from "../../src/services/host/broadcast-types.js"

const EVENT = "00000000-0000-0000-0000-0000000000ee"
const HOST = "00000000-0000-0000-0000-0000000000aa"

function u(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`
}

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
  webBaseUrl: "https://civfix.org",
  apiBaseUrl: "https://api.civfix.org",
  eventUpdatePerEventPerHour: 3,
}

const EVENT_CONTEXT: EventBroadcastContext = {
  cleanupId: EVENT,
  title: "Beach Cleanup",
  pageSlug: "beach-cleanup",
  scheduledAt: new Date("2026-02-01T17:00:00Z"),
  endsAt: null,
  timezone: "America/Los_Angeles",
  address: "Ocean Ave",
  status: "upcoming",
  organizerUserId: HOST,
  organizationSuspended: false,
  replyTo: null,
  replyToVerified: false,
}

function notificationsStub(
  fail: boolean | ((userIds: string[]) => boolean) = false,
  failedRecipients: (userIds: string[]) => string[] = () => [],
): NotificationService & { calls: unknown[] } {
  const calls: unknown[] = []
  const fails = typeof fail === "function" ? fail : () => fail
  const fanOut = (userIds: string[], input: unknown): Promise<{ failed: string[] }> => {
    calls.push({ userIds, input })
    return fails(userIds)
      ? Promise.reject(new Error("fan-out down"))
      : Promise.resolve({ failed: failedRecipients(userIds) })
  }
  return {
    calls,
    createNotifications: async (userIds: string[], input: unknown) => {
      await fanOut(userIds, input)
    },
    createNotificationsReportingFailures: fanOut,
  } as unknown as NotificationService & { calls: unknown[] }
}

interface Harness {
  repo: InMemoryBroadcastRepository
  mailer: FakeMailer
  cache: InMemoryCacheClient
  counters: InMemoryCounterStore
  notifications: NotificationService & { calls: unknown[] }
  chunks: Array<{ broadcastId: string; chunkNo: number; startAfterSec?: number }>
  audits: Array<{ action: string; meta: Record<string, unknown> }>
  service: ReturnType<typeof makeBroadcastService>
  pipeline: ReturnType<typeof makeBroadcastPipeline>
}

function harness(
  overrides: {
    config?: Partial<BroadcastConfig>
    mailer?: Mailer
    members?: number
    notificationsFail?: boolean | ((userIds: string[]) => boolean)
    notificationsFailedRecipients?: (userIds: string[]) => string[]
    clock?: () => number
  } = {},
): Harness {
  const repo = new InMemoryBroadcastRepository()
  repo.seedEvent(EVENT_CONTEXT)
  repo.seedHost(HOST, { accountCreatedAt: new Date("2020-01-01T00:00:00Z") })
  repo.seedMembers(
    EVENT,
    Array.from({ length: overrides.members ?? 5 }, (_, i) => ({ userId: u(i + 1) })),
  )
  repo.seedGuests(EVENT, [])
  const mailer = (overrides.mailer as FakeMailer) ?? new FakeMailer()
  const clock = overrides.clock ?? (() => Date.now())
  const cache = new InMemoryCacheClient(clock)
  const counters = new InMemoryCounterStore(clock)
  const notifications = notificationsStub(
    overrides.notificationsFail ?? false,
    overrides.notificationsFailedRecipients,
  )
  const chunks: Array<{ broadcastId: string; chunkNo: number; startAfterSec?: number }> = []
  const audits: Array<{ action: string; meta: Record<string, unknown> }> = []
  const config = { ...CONFIG, ...overrides.config }
  const plans: string[] = []
  const service = makeBroadcastService({
    repo,
    counters,
    config,
    mailer,
    enqueuePlan: (broadcastId) => {
      plans.push(broadcastId)
      return Promise.resolve()
    },
    ...(overrides.clock !== undefined ? { now: () => new Date(clock()) } : {}),
  })
  const pipeline = makeBroadcastPipeline({
    repo,
    service,
    notifications,
    mailer,
    cache,
    config,
    mailDomain: "civfix.org",
    enqueueChunk: (broadcastId, chunkNo, opts) => {
      chunks.push({
        broadcastId,
        chunkNo,
        ...(opts?.startAfterSec !== undefined ? { startAfterSec: opts.startAfterSec } : {}),
      })
      return Promise.resolve()
    },
    audit: (action, _actorId, _target, meta) => {
      audits.push({ action, meta })
      return Promise.resolve()
    },
    ...(overrides.clock !== undefined ? { now: () => new Date(clock()) } : {}),
  })
  return { repo, mailer, cache, counters, notifications, chunks, audits, service, pipeline }
}

async function draftSending(h: Harness, channels: Array<"inapp" | "push" | "email"> = ["email"]) {
  const record = await h.repo.create({
    cleanupId: EVENT,
    createdBy: HOST,
    kind: "host_broadcast",
    subject: "Bring gloves",
    bodyMd: "See you at the meeting point.",
    segment: { kind: "all_registered" },
    channels,
    chunkSize: 2,
  })
  await h.repo.transition(record.id, ["draft"], "sending", { startedAt: new Date() })
  return record.id
}

describe("broadcast plan", () => {
  it("creates one delivery per recipient per channel and chunks them", async () => {
    const h = harness()
    const id = await draftSending(h, ["email", "inapp"])
    const outcome = await h.pipeline.plan(id)
    expect(outcome.kind).toBe("planned")
    expect(outcome.recipients).toBe(5)
    expect(outcome.chunks).toBe(3)
    expect(h.repo.allDeliveries()).toHaveLength(10)
    expect(h.chunks).toHaveLength(3)
  })

  it("re-plans a crashed plan without stranding the tail chunk when the audience shrank", async () => {
    const h = harness({ members: 5 })
    const id = await draftSending(h)

    const markPlanned = h.repo.markPlanned.bind(h.repo)
    let crashed = false
    h.repo.markPlanned = ((broadcastId: string, args: Parameters<typeof markPlanned>[1]) => {
      if (!crashed) {
        crashed = true
        return Promise.reject(new Error("crashed between the last insert and markPlanned"))
      }
      return markPlanned(broadcastId, args)
    }) as typeof h.repo.markPlanned

    await expect(h.pipeline.plan(id)).rejects.toThrow(/crashed/)
    expect(h.repo.allDeliveries().filter((d) => d.chunkNo === 2)).toHaveLength(1)
    expect((await h.repo.findById(id))?.plannedAt).toBeNull()

    h.repo.seedMembers(
      EVENT,
      Array.from({ length: 3 }, (_, i) => ({ userId: u(i + 1) })),
    )
    h.chunks.length = 0
    await h.pipeline.plan(id)

    expect((await h.repo.findById(id))?.chunkCount).toBe(3)
    expect(h.chunks.map((c) => c.chunkNo)).toEqual([0, 1, 2])
    for (const chunk of [...h.chunks]) await h.pipeline.runChunk(id, chunk.chunkNo)
    expect(await h.repo.deliveryCounts(id)).toMatchObject({ pending: 0 })
    expect((await h.repo.findById(id))?.status).toBe("sent")
  })

  it("enqueues only the chunks that still have work on a stale-sending resume", async () => {
    const h = harness({ members: 5 })
    const id = await draftSending(h)
    await h.pipeline.plan(id)
    await h.pipeline.runChunk(id, 0)
    h.chunks.length = 0
    await h.repo.transition(id, ["sending"], "sending", { startedAt: new Date(0) })
    h.repo.forceUpdatedAt(id, new Date(0))
    await h.pipeline.sweep()
    expect(h.chunks.map((c) => c.chunkNo)).toEqual([1, 2])
  })

  it("is idempotent: replanning inserts no duplicate deliveries", async () => {
    const h = harness()
    const id = await draftSending(h)
    await h.pipeline.plan(id)
    const first = h.repo.allDeliveries().length
    await h.pipeline.plan(id)
    expect(h.repo.allDeliveries()).toHaveLength(first)
  })

  it("refuses an audience above the platform cap and fails the broadcast", async () => {
    const h = harness({ config: { maxRecipients: 2 }, members: 5 })
    const id = await draftSending(h)
    const outcome = await h.pipeline.plan(id)
    expect(outcome.kind).toBe("too_many")
    expect((await h.repo.findById(id))?.status).toBe("failed")
    expect(h.repo.allDeliveries()).toHaveLength(0)
  })

  it("finishes an empty audience without sending anything", async () => {
    const h = harness({ members: 0 })
    const id = await draftSending(h)
    const outcome = await h.pipeline.plan(id)
    expect(outcome.kind).toBe("empty")
    expect((await h.repo.findById(id))?.status).toBe("sent")
  })

  it("kills the broadcast when the host is suspended", async () => {
    const h = harness()
    h.repo.seedHost(HOST, { suspended: true })
    const id = await draftSending(h)
    expect((await h.pipeline.plan(id)).kind).toBe("killed")
    expect((await h.repo.findById(id))?.status).toBe("cancelled")
    expect(h.audits.map((a) => a.action)).toContain("event.broadcast_killed")
  })

  it("refuses when the host's daily recipient budget is exhausted", async () => {
    const h = harness({ config: { recipientsPerDay: 2 }, members: 5 })
    const id = await draftSending(h)
    const outcome = await h.pipeline.plan(id)
    expect(outcome.kind).toBe("over_budget")
    expect((await h.repo.findById(id))?.status).toBe("failed")
  })

  it("charges the recipient budget exactly once across replans", async () => {
    const h = harness({ members: 3 })
    const id = await draftSending(h)
    await h.pipeline.plan(id)
    await h.pipeline.plan(id)
    expect(h.counters.peek(`bcast:host:${HOST}:${new Date().toISOString().slice(0, 10)}`)).toBe(3)
  })
})

describe("broadcast chunk", () => {
  it("sends one email per recipient with the one-click unsubscribe headers", async () => {
    const h = harness({ members: 2 })
    const id = await draftSending(h)
    await h.pipeline.plan(id)
    await h.pipeline.runChunk(id, 0)
    const outbound = h.mailer.lastOutbound() as OutboundEmail
    expect(outbound.from).toBe("events@civfix.org")
    expect(outbound.headers?.["List-Unsubscribe"]).toMatch(
      /^<https:\/\/api\.civfix\.org\/v1\/broadcasts\/unsubscribe\?t=/,
    )
    expect(outbound.text).toContain("https://civfix.org/unsubscribe?t=")
    expect(outbound.text).not.toContain("https://api.civfix.org/v1/broadcasts/unsubscribe")
    expect(outbound.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click")
    expect(outbound.headers?.["Auto-Submitted"]).toBeUndefined()
    expect(outbound.messageId).toMatch(/^<bcast-.*@civfix\.org>$/)
    expect(outbound.replyTo).toBeUndefined()
  })

  it("stamps Auto-Submitted on an automated kind", async () => {
    const h = harness({ members: 1 })
    const record = await h.repo.create({
      cleanupId: EVENT,
      createdBy: null,
      kind: "event_cancelled",
      subject: "Cancelled",
      bodyMd: "Sorry.",
      segment: { kind: "all_registered" },
      channels: ["email"],
      status: "sending",
    })
    await h.pipeline.plan(record.id)
    await h.pipeline.runChunk(record.id, 0)
    expect(h.mailer.lastOutbound()?.headers?.["Auto-Submitted"]).toBe("auto-generated")
  })

  it("marks every delivery sent and finalizes the broadcast", async () => {
    const h = harness({ members: 2 })
    const id = await draftSending(h)
    await h.pipeline.plan(id)
    await h.pipeline.runChunk(id, 0)
    expect(h.repo.allDeliveries().every((d) => d.status === "sent")).toBe(true)
    expect((await h.repo.findById(id))?.status).toBe("sent")
  })

  it("resumes after an interruption without sending a recipient twice", async () => {
    let failNext = true
    const flaky: Mailer = {
      sendOtp: () => Promise.resolve(),
      sendTransactional: () => Promise.resolve(),
      sendOutbound: (email: OutboundEmail): Promise<SentMail> => {
        if (failNext) {
          failNext = false
          return Promise.reject({ responseCode: 451, response: "451 try later" })
        }
        return Promise.resolve({ messageId: email.messageId ?? "<x@civfix.org>" })
      },
    }
    const h = harness({ members: 2, mailer: flaky as unknown as FakeMailer })
    const id = await draftSending(h)
    await h.pipeline.plan(id)
    await h.pipeline.runChunk(id, 0)
    await h.pipeline.runChunk(id, 0)
    const sent = h.repo.allDeliveries().filter((d) => d.status === "sent")
    expect(sent).toHaveLength(2)
    expect(new Set(sent.map((d) => d.userId)).size).toBe(2)
  })

  it("stops retrying a transient failure after the attempt cap", async () => {
    const alwaysFails: Mailer = {
      sendOtp: () => Promise.resolve(),
      sendTransactional: () => Promise.resolve(),
      sendOutbound: () => Promise.reject({ responseCode: 451 }),
    }
    const h = harness({ members: 1, mailer: alwaysFails as unknown as FakeMailer })
    const id = await draftSending(h)
    await h.pipeline.plan(id)
    for (let i = 0; i < 5; i += 1) await h.pipeline.runChunk(id, 0)
    const rows = h.repo.allDeliveries()
    expect(rows[0]?.status).toBe("failed")
    expect(rows[0]?.attempts).toBeLessThanOrEqual(3)
  })

  it("suppresses an address on a permanent failure and skips it next time", async () => {
    const bounces: Mailer = {
      sendOtp: () => Promise.resolve(),
      sendTransactional: () => Promise.resolve(),
      sendOutbound: () => Promise.reject({ responseCode: 550, response: "550 no such user" }),
    }
    const h = harness({ members: 1, mailer: bounces as unknown as FakeMailer })
    const id = await draftSending(h)
    await h.pipeline.plan(id)
    await h.pipeline.runChunk(id, 0)
    expect(h.repo.allDeliveries()[0]?.failureKind).toBe("permanent")

    const second = await draftSending(h)
    await h.pipeline.plan(second)
    await h.pipeline.runChunk(second, 0)
    const suppressed = h.repo
      .allDeliveries()
      .filter((d) => d.broadcastId === second && d.suppressionReason === "bounce_suppressed")
    expect(suppressed).toHaveLength(1)
  })

  it("aborts the chunk on an auth failure instead of failing every row", async () => {
    const badAuth: Mailer = {
      sendOtp: () => Promise.resolve(),
      sendTransactional: () => Promise.resolve(),
      sendOutbound: () => Promise.reject({ code: "EAUTH" }),
    }
    const h = harness({ members: 2, mailer: badAuth as unknown as FakeMailer })
    const id = await draftSending(h)
    await h.pipeline.plan(id)
    h.chunks.length = 0
    await h.pipeline.runChunk(id, 0)
    expect(h.repo.allDeliveries().some((d) => d.status === "failed")).toBe(false)
    expect(h.repo.allDeliveries().every((d) => d.status === "pending")).toBe(true)
  })

  it("an auth abort does NOT consume a delivery attempt, and backs off instead of hot-retrying", async () => {
    const badAuth: Mailer = {
      sendOtp: () => Promise.resolve(),
      sendTransactional: () => Promise.resolve(),
      sendOutbound: () => Promise.reject({ code: "EAUTH", response: "535 bad creds" }),
    }
    const h = harness({ members: 2, mailer: badAuth as unknown as FakeMailer })
    const id = await draftSending(h)
    await h.pipeline.plan(id)
    h.chunks.length = 0

    await h.pipeline.runChunk(id, 0, 0)
    await h.pipeline.runChunk(id, 0, 1)
    await h.pipeline.runChunk(id, 0, 2)

    const rows = h.repo.allDeliveries().filter((d) => d.broadcastId === id)
    expect(rows).toHaveLength(2)
    expect(rows.every((d) => d.status === "pending")).toBe(true)
    expect(rows.every((d) => d.attempts === 0)).toBe(true)
    expect((await h.repo.findById(id))?.status).toBe("sending")
    expect(h.chunks.map((c) => c.startAfterSec)).toEqual([...AUTH_ABORT_BACKOFF_SEC])
  })

  it("rethrows once the auth backoff ladder is spent, so the failure is not swallowed", async () => {
    const badAuth: Mailer = {
      sendOtp: () => Promise.resolve(),
      sendTransactional: () => Promise.resolve(),
      sendOutbound: () => Promise.reject({ code: "EAUTH" }),
    }
    const h = harness({ members: 1, mailer: badAuth as unknown as FakeMailer })
    const id = await draftSending(h)
    await h.pipeline.plan(id)
    await expect(h.pipeline.runChunk(id, 0, AUTH_ABORT_BACKOFF_SEC.length)).rejects.toBeDefined()
  })

  it("suppresses the remainder when the kill switch trips mid-send", async () => {
    const h = harness({ members: 5 })
    const id = await draftSending(h)
    await h.pipeline.plan(id)
    await h.pipeline.runChunk(id, 0)
    h.repo.seedHost(HOST, { suspended: true })
    await h.pipeline.runChunk(id, 1)
    const rows = h.repo.allDeliveries()
    expect(rows.filter((d) => d.status === "sent")).toHaveLength(2)
    expect(rows.filter((d) => d.suppressionReason === "kill_switch").length).toBeGreaterThan(0)
    expect((await h.repo.findById(id))?.status).toBe("cancelled")
  })

  it("labels a deleted member on the email arm deleted_user, not contact_scrubbed", async () => {
    const h = harness({ members: 0 })
    h.repo.seedMembers(EVENT, [{ userId: u(1) }])
    const id = await draftSending(h)
    await h.pipeline.plan(id)
    h.repo.seedMembers(EVENT, [{ userId: u(1), deleted: true }])
    await h.pipeline.runChunk(id, 0)
    expect(h.repo.allDeliveries()[0]?.suppressionReason).toBe("deleted_user")
  })

  it("deduplicates recipients that share an email address within one broadcast", async () => {
    const h = harness({ members: 0 })
    h.repo.seedMembers(EVENT, [
      { userId: u(1), contact: { email: "same@example.test" } },
      { userId: u(2), contact: { email: "same@example.test" } },
    ])
    const id = await draftSending(h)
    await h.pipeline.plan(id)
    await h.pipeline.runChunk(id, 0)
    const rows = h.repo.allDeliveries()
    expect(rows.filter((d) => d.status === "sent")).toHaveLength(1)
    expect(rows.filter((d) => d.status === "skipped")).toHaveLength(1)
  })

  it("suppresses a push when the recipient turned push off", async () => {
    const h = harness({ members: 0 })
    h.repo.seedMembers(EVENT, [{ userId: u(1), pushPref: false }])
    const id = await draftSending(h, ["inapp", "push"])
    await h.pipeline.plan(id)
    await h.pipeline.runChunk(id, 0)
    const rows = h.repo.allDeliveries()
    expect(rows.find((d) => d.channel === "push")?.suppressionReason).toBe("prefs_off")
    expect(rows.find((d) => d.channel === "inapp")?.status).toBe("sent")
  })

  it("pushes a CRITICAL kind past the host-broadcasts preference", async () => {
    const h = harness({ members: 0 })
    h.repo.seedMembers(EVENT, [{ userId: u(1), hostBroadcastsPref: false }])
    const record = await h.repo.create({
      cleanupId: EVENT,
      createdBy: null,
      kind: "event_cancelled",
      subject: "Cancelled",
      bodyMd: "Sorry.",
      segment: { kind: "all_registered" },
      channels: ["inapp", "push"],
      status: "sending",
    })
    await h.pipeline.plan(record.id)
    await h.pipeline.runChunk(record.id, 0)
    const rows = h.repo.allDeliveries()
    expect(rows.find((d) => d.channel === "push")?.status).toBe("sent")
    const call = h.notifications.calls[0] as { input: { type: string; push: string } }
    expect(call.input.type).toBe("cleanup_cancelled")
    expect(call.input.push).toBe("always")
  })

  it("never pushes when the host chose in-app only", async () => {
    const h = harness({ members: 2 })
    const id = await draftSending(h, ["inapp"])
    await h.pipeline.plan(id)
    await h.pipeline.runChunk(id, 0)
    const call = h.notifications.calls[0] as { input: { type: string; push: string } }
    expect(call.input.push).toBe("never")
    expect(call.input.type).toBe("event_broadcast")
    expect(h.repo.allDeliveries().some((d) => d.channel === "push")).toBe(false)
  })

  it("asks for a push when the host chose in-app + push", async () => {
    const h = harness({ members: 2 })
    const id = await draftSending(h, ["inapp", "push"])
    await h.pipeline.plan(id)
    await h.pipeline.runChunk(id, 0)
    const call = h.notifications.calls[0] as { input: { push: string } }
    expect(call.input.push).toBe("auto")
    expect(h.repo.allDeliveries().filter((d) => d.channel === "push")).toHaveLength(2)
  })

  it("makes exactly one createNotifications call per chunk", async () => {
    const h = harness({ members: 4 })
    const id = await draftSending(h, ["inapp"])
    await h.pipeline.plan(id)
    await h.pipeline.runChunk(id, 0)
    expect(h.notifications.calls).toHaveLength(1)
  })
})

/**
 * Guests have no account, so the bell and push are structurally unreachable for them: email is the
 * whole channel set. Every producing lane asks for ["inapp","push","email"], so if the guest half of
 * the planner ever stopped filtering, a guest would get a delivery row on a channel that can never be
 * processed and the broadcast would sit unfinished.
 */
describe("broadcast to guests", () => {
  const GUEST_A = u(101)
  const GUEST_B = u(102)

  function withGuests(guests: Parameters<InMemoryBroadcastRepository["seedGuests"]>[1]): Harness {
    const h = harness({ members: 0 })
    h.repo.seedMembers(EVENT, [{ userId: u(1) }])
    h.repo.seedGuests(EVENT, guests)
    return h
  }

  it("plans EMAIL ONLY for a guest, whatever channels the host picked", async () => {
    const h = withGuests([{ guestId: GUEST_A, email: "ada@example.test", name: "Ada" }])
    const id = await draftSending(h, ["inapp", "push", "email"])
    await h.pipeline.plan(id)

    const rows = h.repo.allDeliveries()
    const guestRows = rows.filter((d) => d.guestId === GUEST_A)
    expect(guestRows.map((d) => d.channel)).toEqual(["email"])
    expect(rows.filter((d) => d.userId === u(1))).toHaveLength(3)
  })

  it("sends the guest their email and leaves them out of the in-app fan-out", async () => {
    const h = withGuests([{ guestId: GUEST_A, email: "ada@example.test", name: "Ada" }])
    const id = await draftSending(h, ["inapp", "email"])
    await h.pipeline.plan(id)
    await h.pipeline.runChunk(id, 0)
    await h.pipeline.runChunk(id, 1)

    const guestRow = h.repo.allDeliveries().find((d) => d.guestId === GUEST_A)
    expect(guestRow?.status).toBe("sent")
    const envelope = h.mailer.sent.find((m) => m.to === "ada@example.test")?.outbound
    expect(envelope?.headers?.["List-Unsubscribe"]).toContain("/v1/broadcasts/unsubscribe?t=")
    expect(envelope?.text).toContain("Beach Cleanup")
    const fanout = h.notifications.calls as { userIds: string[] }[]
    expect(fanout.flatMap((c) => c.userIds)).toEqual([u(1)])
  })

  it("greets the guest by the name they gave at RSVP", async () => {
    const h = withGuests([{ guestId: GUEST_A, email: "ada@example.test", name: "Ada" }])
    const record = await h.repo.create({
      cleanupId: EVENT,
      createdBy: HOST,
      kind: "host_broadcast",
      subject: "Hello {first_name}",
      bodyMd: "See you soon, {first_name}.",
      segment: { kind: "guests_only" },
      channels: ["email"],
      status: "sending",
    })
    await h.pipeline.plan(record.id)
    await h.pipeline.runChunk(record.id, 0)

    const envelope = h.mailer.sent.find((m) => m.to === "ada@example.test")?.outbound
    expect(envelope?.subject).toBe("Hello Ada")
    expect(envelope?.text).toContain("See you soon, Ada.")
  })

  it("labels a guest whose contact was scrubbed between plan and send contact_scrubbed", async () => {
    const h = withGuests([{ guestId: GUEST_A, email: "ada@example.test", name: "Ada" }])
    const id = await draftSending(h)
    await h.pipeline.plan(id)
    h.repo.seedGuests(EVENT, [
      { guestId: GUEST_A, email: "ada@example.test", name: "Ada", scrubbed: true },
    ])
    await h.pipeline.runChunk(id, 0)

    const guestRow = h.repo.allDeliveries().find((d) => d.guestId === GUEST_A)
    expect(guestRow?.status).toBe("suppressed")
    expect(guestRow?.suppressionReason).toBe("contact_scrubbed")
  })

  it("blocks a guest on the address-level bounce suppression list, like any member", async () => {
    const h = withGuests([
      { guestId: GUEST_A, email: "bounced@example.test", name: "Ada" },
      { guestId: GUEST_B, email: "fine@example.test", name: "Grace" },
    ])
    await h.repo.suppressEmail(emailHashOf("bounced@example.test"), "hard_bounce")
    const id = await draftSending(h)
    await h.pipeline.plan(id)
    for (const chunk of [...h.chunks]) await h.pipeline.runChunk(id, chunk.chunkNo)

    const rows = h.repo.allDeliveries()
    expect(rows.find((d) => d.guestId === GUEST_A)?.suppressionReason).toBe("bounce_suppressed")
    expect(rows.find((d) => d.guestId === GUEST_B)?.status).toBe("sent")
  })

  it("reaches guests on the ANNOUNCEMENT kind, which asks for inapp + push + email", async () => {
    const h = withGuests([{ guestId: GUEST_A, email: "ada@example.test", name: "Ada" }])
    const record = await h.repo.create({
      cleanupId: EVENT,
      createdBy: HOST,
      kind: "announcement",
      subject: "Parking has moved",
      bodyMd: "Use the north lot.",
      segment: { kind: "all_registered" },
      channels: ["inapp", "push", "email"],
      status: "sending",
    })
    await h.pipeline.plan(record.id)
    for (const chunk of [...h.chunks]) await h.pipeline.runChunk(record.id, chunk.chunkNo)

    const guestRows = h.repo.allDeliveries().filter((d) => d.guestId === GUEST_A)
    expect(guestRows.map((d) => d.channel)).toEqual(["email"])
    expect(guestRows[0]?.status).toBe("sent")
    expect(h.mailer.sent.some((m) => m.to === "ada@example.test")).toBe(true)
  })
})

describe("broadcast template variables", () => {
  it("renders every allow-listed variable non-empty on the real send path", async () => {
    const h = harness({ members: 0 })
    h.repo.seedMembers(EVENT, [
      { userId: u(1), ticketTypeName: "General", contact: { firstName: "Alex" } },
    ])
    const body = BROADCAST_VARS.map((name) => `${name}=[{${name}}]`).join("\n\n")
    const record = await h.repo.create({
      cleanupId: EVENT,
      createdBy: HOST,
      kind: "host_broadcast",
      subject: "Hi {first_name}",
      bodyMd: body,
      segment: { kind: "all_registered" },
      channels: ["email"],
      chunkSize: 2,
    })
    await h.repo.transition(record.id, ["draft"], "sending", { startedAt: new Date() })
    await h.pipeline.plan(record.id)
    await h.pipeline.runChunk(record.id, 0)
    const outbound = h.mailer.lastOutbound() as OutboundEmail
    expect(outbound.subject).toBe("Hi Alex")
    for (const name of BROADCAST_VARS) {
      expect(outbound.text).toContain(`${name}=[`)
      expect(outbound.text).not.toContain(`${name}=[]`)
      expect(outbound.text).not.toContain(`{${name}}`)
    }
    expect(outbound.text).toContain("Ocean Ave")
    expect(outbound.text).toContain("https://civfix.org/e/beach-cleanup")
    expect(outbound.text).toContain("General")
  })

  it("links the in-app row at the event page when the event has a slug, matching the email", async () => {
    const h = harness({ members: 1 })
    const id = await draftSending(h, ["inapp"])
    await h.pipeline.plan(id)
    await h.pipeline.runChunk(id, 0)
    const links = (h.notifications.calls as Array<{ input: { link: string } }>).map(
      (c) => c.input.link,
    )
    expect(links).toEqual(["/e/beach-cleanup"])
  })

  it("falls back to the cleanup path when the event has no page slug", async () => {
    const h = harness({ members: 1 })
    h.repo.seedEvent({ ...EVENT_CONTEXT, pageSlug: null })
    const id = await draftSending(h, ["inapp"])
    await h.pipeline.plan(id)
    await h.pipeline.runChunk(id, 0)
    const links = (h.notifications.calls as Array<{ input: { link: string } }>).map(
      (c) => c.input.link,
    )
    expect(links).toEqual([`/cleanups/${EVENT}`])
  })

  it("renders per-recipient variables per recipient on the in-app arm", async () => {
    const h = harness({ members: 0 })
    h.repo.seedMembers(EVENT, [
      { userId: u(1), contact: { firstName: "Alex" } },
      { userId: u(2), contact: { firstName: "Bo" } },
    ])
    const record = await h.repo.create({
      cleanupId: EVENT,
      createdBy: HOST,
      kind: "host_broadcast",
      subject: "Hi {first_name}",
      bodyMd: "See you at {event_where}.",
      segment: { kind: "all_registered" },
      channels: ["inapp"],
      chunkSize: 5,
    })
    await h.repo.transition(record.id, ["draft"], "sending", { startedAt: new Date() })
    await h.pipeline.plan(record.id)
    await h.pipeline.runChunk(record.id, 0)
    const titles = (h.notifications.calls as Array<{ input: { title: string } }>).map(
      (c) => c.input.title,
    )
    expect(titles.sort()).toEqual(["Hi Alex", "Hi Bo"])
  })
})

describe("broadcast in-app partial failure", () => {
  it("re-pends ONLY the rows whose group failed, so a retry cannot duplicate the delivered ones", async () => {
    const h = harness({
      members: 0,
      notificationsFail: (userIds) => userIds.includes(u(2)),
    })
    h.repo.seedMembers(EVENT, [
      { userId: u(1), contact: { firstName: "Alex" } },
      { userId: u(2), contact: { firstName: "Bo" } },
    ])
    const record = await h.repo.create({
      cleanupId: EVENT,
      createdBy: HOST,
      kind: "host_broadcast",
      subject: "Hi {first_name}",
      bodyMd: "See you there.",
      segment: { kind: "all_registered" },
      channels: ["inapp"],
      chunkSize: 5,
    })
    await h.repo.transition(record.id, ["draft"], "sending", { startedAt: new Date() })
    await h.pipeline.plan(record.id)
    await h.pipeline.runChunk(record.id, 0)

    const rows = h.repo.allDeliveries().filter((d) => d.broadcastId === record.id)
    const byUser = new Map(rows.map((d) => [d.userId, d]))
    expect(byUser.get(u(1))?.status).toBe("sent")
    expect(byUser.get(u(2))?.status).toBe("pending")

    await h.pipeline.runChunk(record.id, 0)
    const titles = (h.notifications.calls as Array<{ input: { title: string } }>).map(
      (c) => c.input.title,
    )
    expect(titles.filter((t) => t === "Hi Alex")).toHaveLength(1)
    expect(titles.filter((t) => t === "Hi Bo")).toHaveLength(2)
  })
})

describe("broadcast in-app per-recipient failure", () => {
  it("re-pends a recipient whose row the fan-out reported unwritten, and only that one", async () => {
    const h = harness({
      members: 0,
      notificationsFailedRecipients: (userIds) => userIds.filter((id) => id === u(2)),
    })
    h.repo.seedMembers(EVENT, [
      { userId: u(1), contact: { firstName: "Alex" } },
      { userId: u(2), contact: { firstName: "Bo" } },
    ])
    const id = await draftSending(h, ["inapp"])
    await h.pipeline.plan(id)
    await h.pipeline.runChunk(id, 0)

    const byUser = new Map(
      h.repo
        .allDeliveries()
        .filter((d) => d.broadcastId === id)
        .map((d) => [d.userId, d]),
    )
    expect(byUser.get(u(1))?.status).toBe("sent")
    expect(byUser.get(u(2))?.status).toBe("pending")
    expect((await h.repo.findById(id))?.status).toBe("sending")
  })
})

describe("broadcast terminalization", () => {
  it("fails the broadcast after the attempt cap instead of churning forever", async () => {
    const h = harness({ members: 2, notificationsFail: true })
    const id = await draftSending(h, ["inapp"])
    await h.pipeline.plan(id)
    for (let i = 0; i < 3; i += 1) await h.pipeline.runChunk(id, 0)
    const rows = h.repo.allDeliveries()
    expect(rows.every((d) => d.status === "failed")).toBe(true)
    expect(rows.every((d) => d.attempts <= 3)).toBe(true)
    const counts = await h.repo.deliveryCounts(id)
    expect(counts.pending).toBe(0)
    expect((await h.repo.findById(id))?.status).toBe("failed")
  })

  it("terminalizes rows a crash left in_flight past the cap", async () => {
    const h = harness({ members: 1 })
    const id = await draftSending(h)
    await h.pipeline.plan(id)
    for (const row of h.repo.allDeliveries()) {
      row.status = "in_flight"
      row.attempts = 3
    }
    const record = await h.repo.findById(id)
    await h.pipeline.finalizeIfDrained(record!)
    expect(h.repo.allDeliveries()[0]?.status).toBe("failed")
    expect((await h.repo.findById(id))?.status).toBe("failed")
  })
})

describe("broadcast state machine", () => {
  it("refuses an illegal transition by returning no row", async () => {
    const h = harness()
    const id = await draftSending(h)
    expect(await h.repo.transition(id, ["draft"], "sending")).toBeNull()
  })

  it("lets exactly one concurrent send win", async () => {
    const h = harness()
    const record = await h.repo.create({
      cleanupId: EVENT,
      createdBy: HOST,
      kind: "host_broadcast",
      subject: "s",
      bodyMd: "b",
      segment: { kind: "all_registered" },
      channels: ["email"],
    })
    const results = await Promise.all([
      h.repo.transition(record.id, ["draft"], "sending"),
      h.repo.transition(record.id, ["draft"], "sending"),
    ])
    expect(results.filter((r) => r !== null)).toHaveLength(1)
  })
})

describe("broadcast schedule sweep", () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it("consumes the per-event/day cap at release: a 4th scheduled send is refused", async () => {
    const base = Date.parse("2026-02-01T00:00:00Z")
    let nowMs = base
    const h = harness({
      members: 2,
      config: { perEventPerDay: 3, cooldownSec: 900 },
      clock: () => nowMs,
    })
    const ids: string[] = []
    for (let i = 0; i < 4; i += 1) {
      const record = await h.repo.create({
        cleanupId: EVENT,
        createdBy: HOST,
        kind: "host_broadcast",
        subject: "s",
        bodyMd: "b",
        segment: { kind: "all_registered" },
        channels: ["email"],
        status: "scheduled",
        scheduledAt: new Date(base + i * 3_600_000),
      })
      ids.push(record.id)
    }
    for (let i = 0; i < 4; i += 1) {
      nowMs = base + i * 3_600_000 + 1000
      await h.pipeline.sweep()
    }
    const statuses = await Promise.all(ids.map(async (id) => (await h.repo.findById(id))?.status))
    expect(statuses.filter((status) => status !== "failed")).toHaveLength(3)
    expect(statuses.filter((status) => status === "failed")).toHaveLength(1)
    const refused = ids[3] as string
    expect((await h.repo.findById(refused))?.status).toBe("failed")
    expect(h.repo.allDeliveries().filter((d) => d.broadcastId === refused)).toHaveLength(0)
  })

  it("returns a scheduled broadcast to `scheduled` when the cap counters are unreachable", async () => {
    const h = harness({ members: 2 })
    h.counters.incr = () => Promise.reject(new Error("redis down"))
    const record = await h.repo.create({
      cleanupId: EVENT,
      createdBy: HOST,
      kind: "host_broadcast",
      subject: "s",
      bodyMd: "b",
      segment: { kind: "all_registered" },
      channels: ["email"],
      status: "scheduled",
      scheduledAt: new Date(Date.now() - 1000),
    })
    const result = await h.pipeline.sweep()
    expect(result.released).toBe(0)
    const after = await h.repo.findById(record.id)
    expect(after?.status).toBe("scheduled")
    expect(after?.plannedAt).toBeNull()
    expect(h.repo.allDeliveries()).toHaveLength(0)
  })

  it("releases a due scheduled broadcast and plans it", async () => {
    const h = harness({ members: 2 })
    const record = await h.repo.create({
      cleanupId: EVENT,
      createdBy: HOST,
      kind: "host_broadcast",
      subject: "s",
      bodyMd: "b",
      segment: { kind: "all_registered" },
      channels: ["email"],
      status: "scheduled",
      scheduledAt: new Date(Date.now() - 1000),
    })
    const result = await h.pipeline.sweep()
    expect(result.released).toBe(1)
    expect((await h.repo.findById(record.id))?.plannedAt).not.toBeNull()
  })
})

describe("broadcast insights invalidation", () => {
  it("bumps the event insights generation when the send finishes", async () => {
    const h = harness({ members: 5 })
    const id = await draftSending(h)
    await h.pipeline.plan(id)
    const planned = Number(await h.cache.get(insightsGenerationKey(EVENT)))

    for (const chunk of [...h.chunks]) await h.pipeline.runChunk(id, chunk.chunkNo)

    expect((await h.repo.findById(id))?.status).toBe("sent")
    expect(Number(await h.cache.get(insightsGenerationKey(EVENT)))).toBeGreaterThan(planned)
  })

  it("leaves the generation alone while the send is still draining", async () => {
    const h = harness({ members: 5 })
    const id = await draftSending(h)
    await h.pipeline.plan(id)
    const planned = await h.cache.get(insightsGenerationKey(EVENT))

    await h.pipeline.runChunk(id, 0)

    expect((await h.repo.findById(id))?.status).toBe("sending")
    expect(await h.cache.get(insightsGenerationKey(EVENT))).toBe(planned)
  })
})
