import { describe, expect, it } from "vitest"
import { FakeJobs } from "@civfix/seams"
import type { AdminDevQueue } from "@civfix/contract"
import * as queueNames from "../../src/lib/queue-names.js"
import { ALL_QUEUE_NAMES } from "../../src/lib/queue-names.js"
import { makeDevJobsService } from "../../src/services/admin/dev-jobs-service.js"
import {
  InMemoryDevJobsRepository,
  type MemoryJobState,
} from "../helpers/admin/dev-jobs-repository.memory.js"

const NOW = new Date(Date.UTC(2026, 9, 26, 12, 0, 0, 0))
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms)
}

function setup() {
  const clock = { now: NOW }
  const repo = new InMemoryDevJobsRepository(() => clock.now)
  const service = makeDevJobsService({
    repo,
    jobs: new FakeJobs(),
    jobsIsFake: false,
    audit: () => Promise.resolve(),
    now: () => clock.now,
  })
  return { clock, repo, service }
}

async function queue(
  service: ReturnType<typeof setup>["service"],
  name: string,
): Promise<AdminDevQueue> {
  const found = (await service.view()).queues.find((q) => q.name === name)
  if (found === undefined) throw new Error(`no ${name} in the view`)
  return found
}

describe("ALL_QUEUE_NAMES", () => {
  it("T15: holds every *_JOB export of queue-names, each once", () => {
    const jobExports = Object.entries(queueNames)
      .filter(([key]) => key.endsWith("_JOB"))
      .map(([, value]) => value as string)
    expect(jobExports).toHaveLength(28)
    expect(new Set(ALL_QUEUE_NAMES).size).toBe(ALL_QUEUE_NAMES.length)
    expect([...ALL_QUEUE_NAMES].sort()).toEqual([...jobExports].sort())
  })
})

describe("makeDevJobsService view", () => {
  it("T19: counts the job table's rows per state, per queue", async () => {
    const { repo, service } = setup()
    const states: MemoryJobState[] = [
      "created",
      "created",
      "retry",
      "active",
      "failed",
      "failed",
      "failed",
    ]
    for (const state of states) {
      repo.addJob("inbound.sweep", state, { startAfter: ago(HOUR), completedOn: ago(HOUR) })
    }
    const { queues } = await service.view()
    for (const q of queues) {
      expect(q.counts, q.name).toEqual(
        q.name === "inbound.sweep"
          ? { created: 2, retry: 1, active: 1, failed: 3 }
          : { created: 0, retry: 0, active: 0, failed: 0 },
      )
    }
  })

  it("T20: failedLast24h counts failures in the job table and the archive window", async () => {
    const { repo, service } = setup()
    repo.addJob("outreach.digest", "failed", { completedOn: ago(2 * HOUR) })
    repo.addArchived("outreach.digest", "failed", ago(20 * HOUR), ago(8 * HOUR))
    repo.addArchived("outreach.digest", "failed", ago(30 * HOUR), ago(8 * HOUR))
    repo.addJob("outreach.digest", "failed", { completedOn: ago(25 * HOUR) })
    expect((await queue(service, "outreach.digest")).failedLast24h).toBe(2)
  })

  it("T21: oldestPendingSeconds is the age of the oldest due, unstarted job", async () => {
    const { repo, service } = setup()
    repo.addJob("inbound.sweep", "created", { startAfter: ago(300 * SECOND) })
    repo.addJob("inbound.sweep", "retry", { startAfter: ago(90 * SECOND) })
    repo.addJob("inbound.sweep", "created", { startAfter: ago(-600 * SECOND) })
    repo.addJob("inbound.sweep", "active", { startAfter: ago(1000 * SECOND) })
    expect((await queue(service, "inbound.sweep")).oldestPendingSeconds).toBe(300)

    const later = setup()
    later.repo.addJob("inbound.sweep", "created", { startAfter: ago(-600 * SECOND) })
    later.repo.addJob("inbound.sweep", "active", { startAfter: ago(1000 * SECOND) })
    expect((await queue(later.service, "inbound.sweep")).oldestPendingSeconds).toBe(0)
  })

  it("T22: lastCompletedAt is the newest completion in the job table or archive window", async () => {
    const { repo, service } = setup()
    repo.addJob("event.metrics.rollup", "completed", { completedOn: ago(2 * HOUR) })
    repo.addArchived("event.metrics.rollup", "completed", ago(HOUR), ago(HOUR))
    repo.addJob("event.metrics.rollup", "failed", { completedOn: ago(MINUTE) })
    expect((await queue(service, "event.metrics.rollup")).lastCompletedAt).toBe(
      ago(HOUR).toISOString(),
    )
  })

  it("T23: schedule is the queue's cron, or null", async () => {
    const { repo, service } = setup()
    repo.schedules.set("inbound.sweep", "*/5 * * * *")
    expect((await queue(service, "inbound.sweep")).schedule).toBe("*/5 * * * *")
    expect((await queue(service, "data.export")).schedule).toBe(null)
  })

  it("T24: a queue with no rows shows zero counts and null times", async () => {
    const { repo, service } = setup()
    repo.addJob("inbound.sweep", "created", { startAfter: ago(HOUR) })
    expect(await queue(service, "host.export")).toMatchObject({
      counts: { created: 0, retry: 0, active: 0, failed: 0 },
      failedLast24h: 0,
      oldestPendingSeconds: 0,
      lastCompletedAt: null,
    })
  })

  it("T25: one uncached view reads the repository once, whatever the number of queues", async () => {
    const { repo, service } = setup()
    const { queues } = await service.view()
    expect(queues).toHaveLength(ALL_QUEUE_NAMES.length)
    expect(repo.snapshotCalls).toHaveLength(1)
    expect(repo.runStateCalls).toBe(0)
  })

  it("T26: a view is cached for 30 seconds", async () => {
    const { clock, repo, service } = setup()
    const first = await service.view()
    clock.now = new Date(NOW.getTime() + 29 * SECOND)
    repo.addJob("inbound.sweep", "created", { startAfter: ago(HOUR) })
    expect(await service.view()).toEqual(first)
    clock.now = new Date(NOW.getTime() + 31 * SECOND)
    const third = await service.view()
    expect(repo.snapshotCalls).toEqual([NOW, new Date(NOW.getTime() + 31 * SECOND)])
    expect(third).not.toEqual(first)
  })
})
