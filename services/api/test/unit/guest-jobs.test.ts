import { describe, expect, it } from "vitest"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { InMemoryBroadcastRepository } from "../helpers/host/broadcast-repository.memory.js"
import { makeBroadcastLanes } from "../../src/services/host/broadcast-lanes.js"
import type { EventBroadcastContext } from "../../src/services/host/broadcast-types.js"
import { runGuestUpdateFanout } from "../../src/services/guest-jobs.js"

const EVENT = "00000000-0000-0000-0000-0000000000ee"

const CONTEXT: EventBroadcastContext = {
  cleanupId: EVENT,
  pageSlug: "beach-cleanup",
  title: "Beach Cleanup",
  scheduledAt: new Date(Date.now() + 7 * 86_400_000),
  endsAt: new Date(Date.now() + 7 * 86_400_000 + 4 * 60 * 60 * 1000),
  timezone: "America/Los_Angeles",
  address: null,
  status: "upcoming",
  organizerUserId: "00000000-0000-0000-0000-0000000000aa",
  organizationSuspended: false,
  replyTo: null,
  replyToVerified: false,
}

interface Deferred {
  cleanupId: string
  startAfterSec: number
}

function harness(perEventPerHour = 3) {
  const repo = new InMemoryBroadcastRepository()
  repo.seedEvent(CONTEXT)
  const planned: string[] = []
  const lanes = makeBroadcastLanes({
    repo,
    counters: new InMemoryCounterStore(),
    perEventPerHour,
    enqueuePlan: (id) => {
      planned.push(id)
      return Promise.resolve()
    },
  })
  const smsSends: string[] = []
  const deferred: Deferred[] = []
  const deps = {
    announce: (cleanupId: string) => lanes.eventUpdated(cleanupId),
    notifyBySms: (cleanupId: string) => {
      smsSends.push(cleanupId)
      return Promise.resolve()
    },
    deferFanout: (cleanupId: string, startAfterSec: number) => {
      deferred.push({ cleanupId, startAfterSec })
      return Promise.resolve()
    },
  }
  return { repo, planned, smsSends, deferred, deps }
}

describe("guest update fan-out", () => {
  it("texts SMS-only guests exactly when the pipeline lane actually started", async () => {
    const { deps, smsSends, planned } = harness()
    const verdict = await runGuestUpdateFanout(deps, { cleanupId: EVENT })
    expect(verdict.status).toBe("started")
    expect(smsSends).toEqual([EVENT])
    expect(planned).toHaveLength(1)
  })

  it("throttles repeated UPDATE fan-outs for one event so an edit loop cannot text-bomb guests", async () => {
    const { deps, smsSends } = harness(3)
    for (let i = 0; i < 3; i += 1) {
      await runGuestUpdateFanout(deps, { cleanupId: EVENT })
    }
    expect(smsSends).toHaveLength(3)

    await runGuestUpdateFanout(deps, { cleanupId: EVENT })
    expect(smsSends).toHaveLength(3)
  })

  it("COALESCES a throttled change into one deferred announcement instead of dropping it", async () => {
    const { deps, deferred, smsSends } = harness(1)
    await runGuestUpdateFanout(deps, { cleanupId: EVENT })
    expect(deferred).toHaveLength(0)

    const verdict = await runGuestUpdateFanout(deps, { cleanupId: EVENT })
    expect(verdict.status).toBe("throttled")
    expect(smsSends).toHaveLength(1)
    expect(deferred).toHaveLength(1)
    expect(deferred[0]?.cleanupId).toBe(EVENT)
    expect(deferred[0]?.startAfterSec).toBeGreaterThan(0)
  })

  it("re-defers rather than dropping while the window is still spent", async () => {
    const { deps, deferred } = harness(1)
    await runGuestUpdateFanout(deps, { cleanupId: EVENT })
    await runGuestUpdateFanout(deps, { cleanupId: EVENT })
    await runGuestUpdateFanout(deps, { cleanupId: EVENT })
    expect(deferred).toHaveLength(2)
  })

  it("does not text guests, and does not defer, when the event is no longer live", async () => {
    const { repo, deps, smsSends, deferred } = harness()
    repo.seedEvent({ ...CONTEXT, status: "cancelled" })
    const verdict = await runGuestUpdateFanout(deps, { cleanupId: EVENT })
    expect(verdict).toEqual({ status: "skipped" })
    expect(smsSends).toEqual([])
    expect(deferred).toEqual([])
  })

  it("fails the fan-out CLOSED when the throttle counter is unreachable, and retries later", async () => {
    const repo = new InMemoryBroadcastRepository()
    repo.seedEvent(CONTEXT)
    const lanes = makeBroadcastLanes({
      repo,
      counters: {
        incr: () => Promise.reject(new Error("redis down")),
        incrBy: () => Promise.reject(new Error("redis down")),
        decrBy: () => Promise.reject(new Error("redis down")),
      },
      perEventPerHour: 3,
      enqueuePlan: () => Promise.resolve(),
    })
    const smsSends: string[] = []
    const deferred: Deferred[] = []
    const verdict = await runGuestUpdateFanout(
      {
        announce: (cleanupId) => lanes.eventUpdated(cleanupId),
        notifyBySms: (cleanupId) => {
          smsSends.push(cleanupId)
          return Promise.resolve()
        },
        deferFanout: (cleanupId, startAfterSec) => {
          deferred.push({ cleanupId, startAfterSec })
          return Promise.resolve()
        },
      },
      { cleanupId: EVENT },
    )
    expect(verdict.status).toBe("throttled")
    expect(smsSends).toEqual([])
    expect(deferred).toHaveLength(1)
  })
})
