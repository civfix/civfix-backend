import { describe, it, expect, vi, beforeEach } from "vitest"
import { PgBossJobs, API_QUEUE_NAMES } from "../../src/adapters/jobs.pgboss.js"
import { FILING_QUEUE_OPTIONS, PGBOSS_SCHEMA } from "../../src/lib/queue-names.js"

/**
 * Unit test for the API-side pg-boss Jobs adapter. pg-boss is MOCKED (no Postgres) so we can prove the
 * wiring without infra: start() opens the boss + creates exactly the queues the API enqueues, and
 * enqueue()/schedule() delegate to boss.send/boss.schedule with the right name/data/options.
 *
 * The point of this test is the regression that mattered: the adapter used to reject every call with
 * "adapter not implemented: jobs.pgboss", so the hot paths (media finalize, jurisdiction discovery)
 * 500'd in production. Here we assert enqueue RESOLVES and forwards the call instead of throwing.
 */

/** A spyable stand-in for a pg-boss instance. */
interface MockBoss {
  on: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  createQueue: ReturnType<typeof vi.fn>
  updateQueue: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  schedule: ReturnType<typeof vi.fn>
  work: ReturnType<typeof vi.fn>
}

// Created fresh per test and returned by the mocked pg-boss constructor.
let lastBoss: MockBoss
const ctor = vi.fn()

vi.mock("pg-boss", () => {
  // The adapter does `const { PgBoss } = await import("pg-boss")` then `new PgBoss(...)`.
  return {
    PgBoss: class {
      constructor(opts: unknown) {
        ctor(opts)
        return lastBoss
      }
    },
  }
})

function freshBoss(sendReturns: string | null = "job-123"): MockBoss {
  return {
    on: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createQueue: vi.fn().mockResolvedValue(undefined),
    updateQueue: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(sendReturns),
    schedule: vi.fn().mockResolvedValue(undefined),
    work: vi.fn().mockResolvedValue(undefined),
  }
}

beforeEach(() => {
  ctor.mockClear()
  lastBoss = freshBoss()
})

describe("PgBossJobs (API enqueue adapter)", () => {
  it("T1: start() constructs pg-boss once on the pgboss_v12 schema with the connection string", async () => {
    expect(PGBOSS_SCHEMA).toBe("pgboss_v12")
    const jobs = new PgBossJobs({ connectionString: "postgres://u:p@localhost:5432/civfix" })
    await jobs.start()

    expect(ctor).toHaveBeenCalledTimes(1)
    expect(ctor.mock.calls[0]![0]).toMatchObject({
      connectionString: "postgres://u:p@localhost:5432/civfix",
      schema: "pgboss_v12",
    })
    expect(lastBoss.start).toHaveBeenCalledTimes(1)

    // Creates EXACTLY the queues the API enqueues onto, so a send() can never race a missing queue.
    const created = lastBoss.createQueue.mock.calls.map((c) => c[0])
    expect(created).toEqual([...API_QUEUE_NAMES])
  })

  it("T2: start() creates every API queue short, with that queue's retry settings", async () => {
    const jobs = new PgBossJobs({ connectionString: "postgres://localhost/civfix" })
    await jobs.start()
    const filing: Record<string, object> = FILING_QUEUE_OPTIONS
    const retryFields = ["retryLimit", "retryDelay", "retryBackoff", "expireInSeconds"] as const
    for (const name of API_QUEUE_NAMES) {
      const calls = lastBoss.createQueue.mock.calls.filter((c) => c[0] === name)
      expect(calls, name).toHaveLength(1)
      const opts = calls[0]![1] as Record<string, unknown>
      expect(opts.policy, name).toBe("short")
      const today: Record<string, unknown> =
        name === "data.export"
          ? { retryLimit: 10, retryDelay: 60, retryBackoff: true }
          : { ...filing[name] }
      for (const field of retryFields) expect(opts[field], `${name} ${field}`).toBe(today[field])
    }
  })

  it("T3: start() never hands updateQueue a policy or an empty update", async () => {
    lastBoss.updateQueue = vi.fn((_name: string, options: object) => {
      if ("policy" in options) {
        return Promise.reject(new Error("queue policy cannot be changed after creation"))
      }
      if (Object.keys(options).length === 0) {
        return Promise.reject(new Error("no properties found to update"))
      }
      return Promise.resolve()
    })
    const jobs = new PgBossJobs({ connectionString: "postgres://localhost/civfix" })
    await expect(jobs.start()).resolves.toBeUndefined()
    expect(lastBoss.updateQueue).toHaveBeenCalled()
    for (const [name, options] of lastBoss.updateQueue.mock.calls as [string, object][]) {
      expect(options, name).not.toHaveProperty("policy")
      expect(Object.keys(options).length, name).toBeGreaterThan(0)
    }
  })

  it("C34: start() brings each filing queue to its FILING_QUEUE_OPTIONS entry", async () => {
    const jobs = new PgBossJobs({ connectionString: "postgres://localhost/civfix" })
    await jobs.start()
    for (const [name, options] of Object.entries(FILING_QUEUE_OPTIONS)) {
      const { policy, ...retries } = options
      expect(lastBoss.createQueue).toHaveBeenCalledWith(name, { policy, ...retries })
      expect(lastBoss.updateQueue).toHaveBeenCalledWith(name, retries)
    }
  })

  it("start() is idempotent (a second call does not re-open pg-boss)", async () => {
    const jobs = new PgBossJobs({ connectionString: "postgres://localhost/civfix" })
    await jobs.start()
    await jobs.start()
    expect(ctor).toHaveBeenCalledTimes(1)
    expect(lastBoss.start).toHaveBeenCalledTimes(1)
  })

  it("enqueue() forwards name + data + mapped options to boss.send and returns the job id (NO throw)", async () => {
    const jobs = new PgBossJobs({ connectionString: "postgres://localhost/civfix" })
    await jobs.start()

    const data = { mediaId: "m1", uploadId: "u1", r2Key: "uploads/x", kind: "image" }
    const id = await jobs.enqueue("media.checks", data, {
      singletonKey: "u1",
      startAfter: 5,
      retryLimit: 3,
    })

    expect(id).toBe("job-123")
    expect(lastBoss.send).toHaveBeenCalledTimes(1)
    const [name, sentData, options] = lastBoss.send.mock.calls[0]!
    expect(name).toBe("media.checks")
    expect(sentData).toEqual(data)
    // Only the provided options are mapped onto pg-boss SendOptions.
    expect(options).toEqual({ singletonKey: "u1", startAfter: 5, retryLimit: 3 })
  })

  it("enqueue() omits unset options and returns '' when send dedupes to null", async () => {
    lastBoss = freshBoss(null) // singletonKey dedupe -> pg-boss returns null
    const jobs = new PgBossJobs({ connectionString: "postgres://localhost/civfix" })
    await jobs.start()

    const id = await jobs.enqueue("jurisdiction.discovery", { geoid: "0644000" })
    expect(id).toBe("")
    const [name, , options] = lastBoss.send.mock.calls[0]!
    expect(name).toBe("jurisdiction.discovery")
    expect(options).toEqual({}) // no singletonKey/startAfter/retryLimit provided
  })

  it("enqueue() before start() rejects clearly (rather than silently dropping the job)", async () => {
    const jobs = new PgBossJobs({ connectionString: "postgres://localhost/civfix" })
    await expect(jobs.enqueue("media.checks", {})).rejects.toThrow(/not started/)
  })

  it("schedule() forwards to boss.schedule with a default empty data object", async () => {
    const jobs = new PgBossJobs({ connectionString: "postgres://localhost/civfix" })
    await jobs.start()
    await jobs.schedule("jurisdiction.discovery", "0 * * * *")
    expect(lastBoss.schedule).toHaveBeenCalledWith("jurisdiction.discovery", "0 * * * *", {})
  })

  it("stop() is safe to call when never started", async () => {
    const jobs = new PgBossJobs({ connectionString: "postgres://localhost/civfix" })
    await expect(jobs.stop()).resolves.toBeUndefined()
    expect(ctor).not.toHaveBeenCalled()
  })

  it("T4: stop() stops pg-boss gracefully within 30 seconds", async () => {
    const jobs = new PgBossJobs({ connectionString: "postgres://localhost/civfix" })
    await jobs.start()
    await jobs.stop()
    expect(lastBoss.stop).toHaveBeenCalledTimes(1)
    expect(lastBoss.stop.mock.calls[0]![0]).toStrictEqual({ graceful: true, timeout: 30000 })
  })

  it("gives data.export a backoff retry policy that outlasts a mail config outage", async () => {
    const OUTAGE_SECONDS = 6 * 60 * 60
    const jobs = new PgBossJobs({ connectionString: "postgres://localhost/civfix" })
    await jobs.start()
    for (const call of [lastBoss.createQueue, lastBoss.updateQueue]) {
      const policy = call.mock.calls.find((c) => c[0] === "data.export")?.[1] as {
        retryLimit: number
        retryDelay: number
        retryBackoff: boolean
      }
      expect(policy).toMatchObject({ retryBackoff: true })
      const minimumSpan = policy.retryDelay * (2 ** policy.retryLimit - 1)
      expect(minimumSpan).toBeGreaterThanOrEqual(OUTAGE_SECONDS)
    }
    const other = lastBoss.createQueue.mock.calls.find((c) => c[0] === "media.checks")?.[1]
    expect(other).toEqual({ policy: "short" })
    expect(lastBoss.updateQueue.mock.calls.some((c) => c[0] === "media.checks")).toBe(false)
  })

  it("work() hands each job its retry count and limit", async () => {
    const jobs = new PgBossJobs({ connectionString: "postgres://localhost/civfix" })
    await jobs.start()
    const seen: unknown[] = []
    await jobs.work("data.export", (job) => {
      seen.push(job)
      return Promise.resolve()
    })
    const [name, options, poll] = lastBoss.work.mock.calls[0]! as [
      string,
      { includeMetadata: boolean },
      (batch: unknown[]) => Promise<void>,
    ]
    expect(name).toBe("data.export")
    expect(options).toMatchObject({ includeMetadata: true })
    await poll([{ id: "j1", data: { userId: "u1" }, retryCount: 3, retryLimit: 10 }])
    expect(seen).toEqual([{ id: "j1", data: { userId: "u1" }, retryCount: 3, retryLimit: 10 }])
  })
})
