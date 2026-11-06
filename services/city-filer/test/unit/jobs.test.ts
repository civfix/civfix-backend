import { beforeEach, describe, expect, it, vi } from "vitest"
import { FILING_QUEUE_OPTIONS, type FilingQueueName } from "@civfix/api/filings-worker"

/** What the stub pg-boss recorded; it records calls only and mimics nothing. */
const boxed = vi.hoisted(() => ({
  options: [] as unknown[],
  createQueue: [] as [string, object][],
  updateQueue: [] as [string, object][],
  stop: [] as unknown[],
}))

vi.mock("pg-boss", () => ({
  PgBoss: class {
    constructor(options: unknown) {
      boxed.options.push(options)
    }
    on(): this {
      return this
    }
    start(): Promise<this> {
      return Promise.resolve(this)
    }
    stop(options: unknown): Promise<void> {
      boxed.stop.push(options)
      return Promise.resolve()
    }
    createQueue(name: string, options: object): Promise<void> {
      boxed.createQueue.push([name, options])
      return Promise.resolve()
    }
    updateQueue(name: string, options: object): Promise<void> {
      boxed.updateQueue.push([name, options])
      return Promise.resolve()
    }
  },
}))

const { PgBossFilerJobs } = await import("../../src/jobs.js")

beforeEach(() => {
  boxed.options.length = 0
  boxed.createQueue.length = 0
  boxed.updateQueue.length = 0
  boxed.stop.length = 0
})

describe("PgBossFilerJobs (stubbed pg-boss)", () => {
  it("T8: starts on pgboss_v12, creates each filing queue with its entry, updates only its retries, stops within 30s", async () => {
    const jobs = new PgBossFilerJobs("postgres://stub/civfix")
    await jobs.start()
    const names = Object.keys(FILING_QUEUE_OPTIONS) as FilingQueueName[]
    for (const name of names) await jobs.createQueue(name, FILING_QUEUE_OPTIONS[name])
    await jobs.stop()

    expect(boxed.options).toHaveLength(1)
    expect(boxed.options[0]).toMatchObject({
      connectionString: "postgres://stub/civfix",
      schema: "pgboss_v12",
    })
    expect(boxed.createQueue.map(([name]) => name)).toEqual(names)
    expect(boxed.updateQueue.map(([name]) => name)).toEqual(names)
    for (const name of names) {
      const { policy, ...retries } = FILING_QUEUE_OPTIONS[name]
      expect(policy).toBe("short")
      expect(boxed.createQueue.find(([n]) => n === name)?.[1], name).toEqual({
        policy,
        ...retries,
      })
      expect(boxed.updateQueue.find(([n]) => n === name)?.[1], name).toStrictEqual(retries)
    }
    expect(boxed.updateQueue.find(([n]) => n === "filing.run")?.[1]).toStrictEqual({
      retryLimit: 0,
      expireInSeconds: 3600,
    })
    expect(boxed.stop).toHaveLength(1)
    expect(boxed.stop[0]).toStrictEqual({ graceful: true, timeout: 30000 })
  })
})
