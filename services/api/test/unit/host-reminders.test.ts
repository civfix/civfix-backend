import { describe, expect, it } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import { makeDrizzleBroadcastRepository } from "../../src/services/host/broadcast-repository.drizzle.js"
import type { Sql } from "../../src/db/client.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { InMemoryBroadcastRepository } from "../../src/services/host/broadcast-repository.memory.js"
import {
  DEFAULT_REMINDER_OFFSETS_MIN,
  makeBroadcastLanes,
} from "../../src/services/host/broadcast-lanes.js"
import type { EventBroadcastContext } from "../../src/services/host/broadcast-types.js"

const EVENT = "00000000-0000-0000-0000-0000000000ee"

const CONTEXT: EventBroadcastContext = {
  cleanupId: EVENT,
  pageSlug: "beach-cleanup",
  title: "Beach Cleanup",
  scheduledAt: new Date(Date.now() + 7 * 86_400_000),
  endsAt: new Date(Date.now() + 7 * 86_400_000 + 4 * 60 * 60 * 1000),
  timezone: "UTC",
  address: null,
  status: "upcoming",
  organizerUserId: "00000000-0000-0000-0000-0000000000aa",
  organizationSuspended: false,
  replyTo: null,
  replyToVerified: false,
}

function build(perEventPerHour = 3) {
  const repo = new InMemoryBroadcastRepository()
  repo.seedEvent(CONTEXT)
  const planned: string[] = []
  const counters = new InMemoryCounterStore()
  const lanes = makeBroadcastLanes({
    repo,
    counters,
    perEventPerHour,
    enqueuePlan: (id) => {
      planned.push(id)
      return Promise.resolve()
    },
  })
  return { repo, lanes, planned, counters }
}

describe("reminder sweep", () => {
  it("creates one reminder per due offset", async () => {
    const { repo, lanes, planned } = build()
    repo.seedDueReminders([
      { cleanupId: EVENT, offsetMin: 1440 },
      { cleanupId: EVENT, offsetMin: 120 },
    ])
    expect(await lanes.runReminderSweep()).toEqual({ created: 2 })
    expect(planned).toHaveLength(2)
  })

  it("is idempotent: a second tick inserts nothing", async () => {
    const { repo, lanes, planned } = build()
    repo.seedDueReminders([{ cleanupId: EVENT, offsetMin: 1440 }])
    await lanes.runReminderSweep()
    expect(await lanes.runReminderSweep()).toEqual({ created: 0 })
    expect(planned).toHaveLength(1)
  })

  it("ships the platform default offsets", () => {
    expect([...DEFAULT_REMINDER_OFFSETS_MIN]).toEqual([1440, 180])
  })
})

describe("critical lanes", () => {
  it("starts an event_cancelled broadcast that includes the reason", async () => {
    const { repo, lanes, planned } = build()
    const id = await lanes.eventCancelled(EVENT, "storm warning")
    expect(id).not.toBeNull()
    expect(planned).toEqual([id])
    const record = await repo.findById(id!)
    expect(record?.kind).toBe("event_cancelled")
    expect(record?.status).toBe("sending")
    expect(record?.bodyMd).toContain("storm warning")
    expect(record?.createdBy).toBeNull()
  })

  it("starts an event_updated broadcast for a live event only", async () => {
    const { repo, lanes } = build()
    expect(await lanes.eventUpdated(EVENT)).toMatchObject({ status: "started" })
    repo.seedEvent({ ...CONTEXT, status: "cancelled" })
    expect(await lanes.eventUpdated(EVENT)).toEqual({ status: "skipped" })
  })

  it("does nothing for an unknown event", async () => {
    const { lanes } = build()
    expect(await lanes.eventCancelled("00000000-0000-0000-0000-000000000099", null)).toBeNull()
  })

  it("creates ONE event_cancelled broadcast per event, so a job retry cannot mail it twice", async () => {
    const { repo, lanes, planned } = build()
    const first = await lanes.eventCancelled(EVENT, "storm warning")
    const second = await lanes.eventCancelled(EVENT, "storm warning")
    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(planned).toEqual([first])
    const rows = await repo.list({ cleanupId: EVENT, cursor: null, limit: 50 })
    expect(rows.filter((b) => b.kind === "event_cancelled")).toHaveLength(1)
  })
})

describe("event_updated lane", () => {
  it("throttles repeat announcements for the same event inside the hour", async () => {
    const { lanes, repo } = build(2)
    expect(await lanes.eventUpdated(EVENT)).toMatchObject({ status: "started" })
    expect(await lanes.eventUpdated(EVENT)).toMatchObject({ status: "started" })
    expect(await lanes.eventUpdated(EVENT)).toMatchObject({ status: "throttled" })
    const updates = await repo.list({ cleanupId: EVENT, cursor: null, limit: 50 })
    expect(updates.filter((b) => b.kind === "event_updated")).toHaveLength(2)
  })

  it("hands back a retry deadline inside the throttle window, never zero", async () => {
    const { lanes } = build(1)
    await lanes.eventUpdated(EVENT)
    const verdict = await lanes.eventUpdated(EVENT)
    expect(verdict.status).toBe("throttled")
    if (verdict.status !== "throttled") return
    expect(verdict.retryAfterSec).toBeGreaterThan(0)
    expect(verdict.retryAfterSec).toBeLessThanOrEqual(3600)
  })

  it("refuses the lane when the throttle counter is unavailable", async () => {
    const repo = new InMemoryBroadcastRepository()
    repo.seedEvent(CONTEXT)
    const lanes = makeBroadcastLanes({
      repo,
      counters: {
        incr: () => Promise.reject(new Error("redis down")),
        incrBy: () => Promise.reject(new Error("redis down")),
      },
      perEventPerHour: 3,
      enqueuePlan: () => Promise.resolve(),
    })
    expect(await lanes.eventUpdated(EVENT)).toMatchObject({ status: "throttled" })
  })
})

describe("the reminder sweep's candidate predicate (0.46.0)", () => {
  it("selects every event that is not cancelled, so a legacy 'active' future row is swept too", async () => {
    // 0135's index and predicate were both `status = 'upcoming'`, which silently skipped a future event
    // an operator (or the retired mark-completed action) had left stored as 'active'. Status is a clock
    // reading now, so the only stored value that can rule a row out is 'cancelled'; the existing
    // `scheduled_at > now` bound is what keeps past rows out.
    const fake = makeFakeSql([{ match: /FROM cleanups/, rows: [] }])
    const repo = makeDrizzleBroadcastRepository(fake.sql as unknown as Sql)

    await repo.listDueReminders({
      now: new Date(),
      staleAfter: new Date(),
      defaultOffsets: DEFAULT_REMINDER_OFFSETS_MIN,
      limit: 50,
    })

    const statement = fake.statements.at(-1)?.sql ?? ""
    expect(statement).toContain("WHERE c.status <> 'cancelled'")
    expect(statement).not.toContain("c.status = 'upcoming'")
    expect(statement).toContain("c.scheduled_at > ")
  })
})
