import { describe, it, expect, vi, beforeEach } from "vitest"
import { PgBossJobs, API_QUEUE_NAMES } from "../../src/adapters/jobs.pgboss.js"

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
  // The adapter does `const { default: PgBossCtor } = await import("pg-boss")` then `new PgBossCtor(...)`.
  return {
    default: class {
      constructor(opts: unknown) {
        ctor(opts)
        return lastBoss as unknown as object
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
  it("start() constructs pg-boss with the connection string, starts it, and creates the API queues", async () => {
    const jobs = new PgBossJobs({ connectionString: "postgres://u:p@localhost:5432/civfix" })
    await jobs.start()

    // Constructed with the connection string.
    expect(ctor).toHaveBeenCalledTimes(1)
    expect(ctor.mock.calls[0]![0]).toMatchObject({
      connectionString: "postgres://u:p@localhost:5432/civfix",
    })
    expect(lastBoss.start).toHaveBeenCalledTimes(1)

    // Creates EXACTLY the queues the API enqueues onto (media.checks + jurisdiction.discovery), so a
    // send() can never race a missing queue in pg-boss v10.
    const created = lastBoss.createQueue.mock.calls.map((c) => c[0])
    expect(created).toEqual([...API_QUEUE_NAMES])
    expect(created).toContain("media.checks")
    expect(created).toContain("jurisdiction.discovery")

    // Each queue is created AND updated with the "short" policy so a singletonKey actually dedupes
    // pending jobs in pg-boss v10 (the default "standard" policy does not, and createQueue is a no-op on
    // an already-existing queue — so updateQueue is what fixes a pre-existing default-policy queue).
    for (const name of API_QUEUE_NAMES) {
      expect(lastBoss.createQueue).toHaveBeenCalledWith(
        name,
        expect.objectContaining({ policy: "short" }),
      )
      expect(lastBoss.updateQueue).toHaveBeenCalledWith(
        name,
        expect.objectContaining({ policy: "short" }),
      )
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

  it("stop() stops pg-boss gracefully and is safe to call when never started", async () => {
    const jobs = new PgBossJobs({ connectionString: "postgres://localhost/civfix" })
    // Never started: no boss, so stop is a no-op.
    await expect(jobs.stop()).resolves.toBeUndefined()

    await jobs.start()
    await jobs.stop()
    expect(lastBoss.stop).toHaveBeenCalledWith({ graceful: true, wait: true })
  })
})
