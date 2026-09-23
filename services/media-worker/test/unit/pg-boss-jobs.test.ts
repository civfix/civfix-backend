/**
 * PgBossWorkerJobs against a STUBBED pg-boss (the real adapter, offline).
 *
 * Everything else in the suite runs on FakeWorkerJobs, whose `work()` just invokes handlers inline from
 * `enqueue()`. That cannot reach the piece of this class that actually carries risk: pg-boss v10 hands the
 * work callback a BATCH and treats the callback's outcome as a verdict on the WHOLE batch, so the adapter
 * completes/fails each job INDIVIDUALLY by id and resolves. Before that change, one job's retryable throw
 * re-delivered every clean sibling (burning its retry budget and duplicating its side effects), and before
 * the change to fail on ANY throw, an unexpected error silently marked the job COMPLETE and wedged the
 * asset. Neither had a test; both are pinned here, together with the queue-policy writes (whose omission
 * silently clobbers the API's `short` policy) and the DERIVED graceful-stop timeout.
 *
 * The stub records calls only - it never mimics pg-boss semantics, so nothing here can pass by pretending.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { FakeJobs } from "@civfix/shared/fakes"
import type { JobHandler } from "@civfix/shared/interfaces"

/** The recorded surface of the stub (kept in a hoisted box so the vi.mock factory can reach it). */
interface StubBoss {
  connectionString: string
  events: string[]
  startCount: number
  stopCalls: { graceful?: boolean; wait?: boolean; timeout?: number }[]
  createQueueCalls: { name: string; policy: Record<string, unknown> }[]
  updateQueueCalls: { name: string; policy: Record<string, unknown> }[]
  sendCalls: { name: string; data: unknown; opts: Record<string, unknown> }[]
  scheduleCalls: { name: string; cron: string; data: unknown; opts: Record<string, unknown> }[]
  workCalls: { name: string; options: Record<string, unknown> }[]
  completeCalls: { name: string; id: string }[]
  failCalls: { name: string; id: string; output: unknown }[]
  /** Configurable: what send() resolves to (pg-boss returns null for a deduped singleton). */
  sendResult: string | null
  /** Configurable: ids for which complete()/fail() reject (a DB blip on the outcome write). */
  rejectCompleteFor: string | null
  rejectFailFor: string | null
  /** The batch callback registered by the last work() call. */
  deliver(jobs: { id: string; data: unknown }[]): Promise<void>
}

const boxed = vi.hoisted(() => ({ instances: [] as unknown[] }))

vi.mock("pg-boss", () => {
  class StubPgBoss {
    connectionString: string
    events: string[] = []
    startCount = 0
    stopCalls: unknown[] = []
    createQueueCalls: unknown[] = []
    updateQueueCalls: unknown[] = []
    sendCalls: unknown[] = []
    scheduleCalls: unknown[] = []
    workCalls: unknown[] = []
    completeCalls: unknown[] = []
    failCalls: unknown[] = []
    sendResult: string | null = "job-id-1"
    rejectCompleteFor: string | null = null
    rejectFailFor: string | null = null
    private handler: ((jobs: unknown[]) => Promise<void>) | undefined

    constructor(connectionString: string) {
      this.connectionString = connectionString
      boxed.instances.push(this)
    }
    on(event: string): this {
      this.events.push(event)
      return this
    }
    start(): Promise<void> {
      this.startCount++
      return Promise.resolve()
    }
    stop(opts: unknown): Promise<void> {
      this.stopCalls.push(opts)
      return Promise.resolve()
    }
    createQueue(name: string, policy: unknown): Promise<void> {
      this.createQueueCalls.push({ name, policy })
      return Promise.resolve()
    }
    updateQueue(name: string, policy: unknown): Promise<void> {
      this.updateQueueCalls.push({ name, policy })
      return Promise.resolve()
    }
    send(name: string, data: unknown, opts: unknown): Promise<string | null> {
      this.sendCalls.push({ name, data, opts })
      return Promise.resolve(this.sendResult)
    }
    schedule(name: string, cron: string, data: unknown, opts: unknown): Promise<void> {
      this.scheduleCalls.push({ name, cron, data, opts })
      return Promise.resolve()
    }
    work(
      name: string,
      options: unknown,
      handler: (jobs: unknown[]) => Promise<void>,
    ): Promise<void> {
      this.workCalls.push({ name, options })
      this.handler = handler
      return Promise.resolve()
    }
    complete(name: string, id: string): Promise<void> {
      if (this.rejectCompleteFor === id)
        return Promise.reject(new Error(`complete write failed ${id}`))
      this.completeCalls.push({ name, id })
      return Promise.resolve()
    }
    fail(name: string, id: string, output: unknown): Promise<void> {
      if (this.rejectFailFor === id) return Promise.reject(new Error(`fail write failed ${id}`))
      this.failCalls.push({ name, id, output })
      return Promise.resolve()
    }
    deliver(jobs: { id: string; data: unknown }[]): Promise<void> {
      if (!this.handler) throw new Error("no work handler registered")
      return this.handler(jobs)
    }
  }
  return { default: StubPgBoss }
})

const { PgBossWorkerJobs, buildJobs, stopGraceMsFor } = await import("../../src/jobs.js")

/** The stub instance created by the most recent start(). */
function lastBoss(): StubBoss {
  const last = boxed.instances[boxed.instances.length - 1]
  if (!last) throw new Error("no stub pg-boss was constructed")
  return last as StubBoss
}

beforeEach(() => {
  boxed.instances.length = 0
})

const QUEUE = "media.checks"

describe("PgBossWorkerJobs lifecycle", () => {
  it("start() constructs pg-boss with the connection string, listens for errors, and is idempotent", async () => {
    const jobs = new PgBossWorkerJobs("postgres://stub/civfix")
    await jobs.start()
    await jobs.start()

    expect(boxed.instances).toHaveLength(1)
    expect(lastBoss().connectionString).toBe("postgres://stub/civfix")
    expect(lastBoss().events).toEqual(["error"])
    expect(lastBoss().startCount).toBe(1)
  })

  it("every operation before start() throws instead of silently no-oping", async () => {
    const jobs = new PgBossWorkerJobs("postgres://stub/civfix")
    await expect(jobs.createQueue(QUEUE)).rejects.toThrow(/pg-boss not started/)
    await expect(jobs.enqueue(QUEUE, {})).rejects.toThrow(/pg-boss not started/)
    await expect(jobs.schedule(QUEUE, "* * * * *")).rejects.toThrow(/pg-boss not started/)
    await expect(jobs.work(QUEUE, () => Promise.resolve())).rejects.toThrow(/pg-boss not started/)
    expect(boxed.instances).toHaveLength(0)
  })

  it("stop() passes the DERIVED graceful timeout (every phase's budget + margin), then forgets the boss", async () => {
    const jobs = new PgBossWorkerJobs("postgres://stub/civfix", 20_000)
    await jobs.start()
    await jobs.stop()

    expect(lastBoss().stopCalls).toEqual([
      { graceful: true, wait: true, timeout: stopGraceMsFor(20_000) },
    ])
    // A second stop is a no-op (the handle dropped the boss), not a second pg-boss stop.
    await jobs.stop()
    expect(lastBoss().stopCalls).toHaveLength(1)
  })

  it("stop() before start() is a no-op", async () => {
    const jobs = new PgBossWorkerJobs("postgres://stub/civfix")
    await expect(jobs.stop()).resolves.toBeUndefined()
    expect(boxed.instances).toHaveLength(0)
  })

  /**
   * The grace MUST exceed the per-job budget charged ONCE PER PHASE (download, then processMedia), which is
   * what a 1x derivation got wrong: SIGTERM abandoned a job that was still inside its own budget and left
   * the asset `validating`.
   */
  it("stopGraceMsFor covers BOTH job phases plus persist margin", () => {
    expect(stopGraceMsFor(60_000)).toBe(125_000)
    expect(stopGraceMsFor(1_000)).toBe(7_000)
    for (const budget of [1_000, 60_000, 300_000]) {
      expect(stopGraceMsFor(budget)).toBeGreaterThan(2 * budget)
    }
  })
})

describe("PgBossWorkerJobs queue policy", () => {
  it("createQueue writes the policy AND re-applies it via updateQueue (existing queues are not left stale)", async () => {
    const jobs = new PgBossWorkerJobs("postgres://stub/civfix")
    await jobs.start()
    await jobs.createQueue(QUEUE, { policy: "short", retryLimit: 5, retryBackoff: true })

    const expected = { name: QUEUE, retryLimit: 5, retryBackoff: true, policy: "short" }
    expect(lastBoss().createQueueCalls).toEqual([{ name: QUEUE, policy: expected }])
    // updateQueue is what actually migrates a queue created earlier with a different policy - and it must
    // carry `policy`, because pg-boss rewrites an omitted policy back to "standard" (clobbering the API's).
    expect(lastBoss().updateQueueCalls).toEqual([{ name: QUEUE, policy: expected }])
  })

  it("createQueue with NO options does not issue an updateQueue (nothing to migrate)", async () => {
    const jobs = new PgBossWorkerJobs("postgres://stub/civfix")
    await jobs.start()
    await jobs.createQueue("orphan.sweep")

    expect(lastBoss().createQueueCalls).toEqual([
      { name: "orphan.sweep", policy: { name: "orphan.sweep" } },
    ])
    expect(lastBoss().updateQueueCalls).toEqual([])
  })

  it("a policy-only queue still gets the updateQueue write", async () => {
    const jobs = new PgBossWorkerJobs("postgres://stub/civfix")
    await jobs.start()
    await jobs.createQueue("anon.hold.release", { policy: "short" })

    expect(lastBoss().updateQueueCalls).toEqual([
      { name: "anon.hold.release", policy: { name: "anon.hold.release", policy: "short" } },
    ])
  })
})

describe("PgBossWorkerJobs enqueue / schedule mapping", () => {
  it("maps EnqueueOptions onto pg-boss send options and returns the job id", async () => {
    const jobs = new PgBossWorkerJobs("postgres://stub/civfix")
    await jobs.start()

    const id = await jobs.enqueue(
      QUEUE,
      { mediaId: "m1" },
      // startAfter is a DELAY IN SECONDS in the shared interface (pg-boss also accepts that form).
      { singletonKey: "m1", startAfter: 30, retryLimit: 3 },
    )

    expect(id).toBe("job-id-1")
    expect(lastBoss().sendCalls).toEqual([
      {
        name: QUEUE,
        data: { mediaId: "m1" },
        opts: { singletonKey: "m1", startAfter: 30, retryLimit: 3 },
      },
    ])
  })

  it("omits unset options entirely and maps a deduped (null) send to an empty id", async () => {
    const jobs = new PgBossWorkerJobs("postgres://stub/civfix")
    await jobs.start()
    lastBoss().sendResult = null

    const id = await jobs.enqueue(QUEUE, { mediaId: "m2" })

    expect(id).toBe("")
    expect(lastBoss().sendCalls[0]!.opts).toEqual({})
  })

  it("schedule maps expire/singleton options and defaults empty data to {}", async () => {
    const jobs = new PgBossWorkerJobs("postgres://stub/civfix")
    await jobs.start()

    await jobs.schedule("orphan.sweep", "17 * * * *", undefined, {
      expireInSeconds: 1500,
      singletonKey: "orphan.sweep",
    })
    await jobs.schedule("retention.sweep", "37 4 * * *", { why: "privacy" })

    expect(lastBoss().scheduleCalls).toEqual([
      {
        name: "orphan.sweep",
        cron: "17 * * * *",
        data: {},
        opts: { expireInSeconds: 1500, singletonKey: "orphan.sweep" },
      },
      { name: "retention.sweep", cron: "37 4 * * *", data: { why: "privacy" }, opts: {} },
    ])
  })
})

describe("PgBossWorkerJobs work(): PER-JOB completion of a delivered batch", () => {
  async function startWithHandler(
    handler: JobHandler,
    settings?: { batchSize?: number },
  ): Promise<void> {
    const jobs = new PgBossWorkerJobs("postgres://stub/civfix")
    await jobs.start()
    await jobs.workWithSettings(QUEUE, handler, settings)
  }

  it("passes the concurrency settings through to pg-boss work options", async () => {
    const jobs = new PgBossWorkerJobs("postgres://stub/civfix")
    await jobs.start()
    await jobs.workWithSettings(QUEUE, () => Promise.resolve(), {
      batchSize: 2,
      pollingIntervalSeconds: 4,
    })
    await jobs.work("orphan.sweep", () => Promise.resolve())

    expect(lastBoss().workCalls).toEqual([
      { name: QUEUE, options: { batchSize: 2, pollingIntervalSeconds: 4 } },
      { name: "orphan.sweep", options: {} },
    ])
  })

  it("invokes the shared single-job handler once per delivered job with {id, data}", async () => {
    const seen: { id: string; data: unknown }[] = []
    await startWithHandler((job) => {
      seen.push({ id: job.id, data: job.data })
      return Promise.resolve()
    })

    await lastBoss().deliver([
      { id: "j1", data: { uploadId: "u1" } },
      { id: "j2", data: { uploadId: "u2" } },
    ])

    expect(seen).toEqual([
      { id: "j1", data: { uploadId: "u1" } },
      { id: "j2", data: { uploadId: "u2" } },
    ])
    expect(lastBoss().completeCalls).toEqual([
      { name: QUEUE, id: "j1" },
      { name: QUEUE, id: "j2" },
    ])
    expect(lastBoss().failCalls).toEqual([])
  })

  /**
   * The regression this class exists for: one job's retryable failure must NOT re-deliver its clean
   * siblings. Throwing out of the callback failed all three ids; resolving would have marked the failed one
   * complete and lost it.
   */
  it("fails ONLY the throwing job and completes its siblings, without rejecting the batch", async () => {
    const boom = new Error("media.checks infra failure (persist, retryable): db down")
    await startWithHandler((job) => (job.id === "j2" ? Promise.reject(boom) : Promise.resolve()))

    await expect(
      lastBoss().deliver([
        { id: "j1", data: 1 },
        { id: "j2", data: 2 },
        { id: "j3", data: 3 },
      ]),
    ).resolves.toBeUndefined()

    expect(lastBoss().failCalls).toEqual([{ name: QUEUE, id: "j2", output: boom }])
    expect(lastBoss().completeCalls.map((c) => c.id)).toEqual(["j1", "j3"])
  })

  it("fails the job for ANY throw, not just the retryable infra error (never silently completes)", async () => {
    await startWithHandler(() => Promise.reject(new TypeError("undefined is not a function")))

    await lastBoss().deliver([{ id: "only", data: null }])

    expect(lastBoss().completeCalls).toEqual([])
    expect(lastBoss().failCalls).toHaveLength(1)
    expect(lastBoss().failCalls[0]!.output).toBeInstanceOf(TypeError)
  })

  it("wraps a non-Error rejection so the reason still reaches the job's output column", async () => {
    await startWithHandler(() => Promise.reject("stringly-typed failure"))

    await lastBoss().deliver([{ id: "only", data: null }])

    expect(lastBoss().failCalls[0]!.output).toEqual({ message: "stringly-typed failure" })
  })

  it("RETHROWS when the outcome WRITE fails, so pg-boss retries instead of losing the verdict", async () => {
    await startWithHandler(() => Promise.resolve())
    lastBoss().rejectCompleteFor = "j2"

    await expect(
      lastBoss().deliver([
        { id: "j1", data: 1 },
        { id: "j2", data: 2 },
      ]),
    ).rejects.toThrow(/complete write failed j2/)

    // The sibling's completion still landed before the rethrow.
    expect(lastBoss().completeCalls).toEqual([{ name: QUEUE, id: "j1" }])
  })

  it("RETHROWS when the FAIL write fails too (the failure must not be swallowed)", async () => {
    await startWithHandler((job) =>
      job.id === "j1" ? Promise.reject(new Error("nope")) : Promise.resolve(),
    )
    lastBoss().rejectFailFor = "j1"

    await expect(
      lastBoss().deliver([
        { id: "j1", data: 1 },
        { id: "j2", data: 2 },
      ]),
    ).rejects.toThrow(/fail write failed j1/)
    expect(lastBoss().completeCalls).toEqual([{ name: QUEUE, id: "j2" }])
  })

  it("an empty batch is a no-op that resolves", async () => {
    await startWithHandler(() => Promise.reject(new Error("must not run")))
    await expect(lastBoss().deliver([])).resolves.toBeUndefined()
    expect(lastBoss().completeCalls).toEqual([])
    expect(lastBoss().failCalls).toEqual([])
  })
})

describe("PgBossWorkerJobs unsupported name-agnostic complete/fail", () => {
  it("never guesses a queue name: they resolve without touching pg-boss", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const jobs = new PgBossWorkerJobs("postgres://stub/civfix")
      await jobs.start()

      await expect(jobs.complete("j1")).resolves.toBeUndefined()
      await expect(jobs.fail("j1", new Error("x"))).resolves.toBeUndefined()

      expect(lastBoss().completeCalls).toEqual([])
      expect(lastBoss().failCalls).toEqual([])
      // The misuse is surfaced rather than silently swallowed.
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })
})

describe("buildJobs seam selection", () => {
  it("defaults to the fake outside production (the worker boots offline)", () => {
    const handle = buildJobs({ NODE_ENV: "test" } as NodeJS.ProcessEnv)
    expect(handle.jobs).toBeInstanceOf(FakeJobs)
  })

  /**
   * FakeJobs consumes NOTHING from pg-boss, so a prod worker booted with it looks healthy while every
   * upload stays `validating` forever - the exact silent no-op the storage guard already fails boot on.
   */
  it("THROWS when USE_FAKE_JOBS is explicitly on in production", () => {
    expect(() =>
      buildJobs({
        NODE_ENV: "production",
        USE_FAKE_JOBS: "1",
        DATABASE_URL: "postgres://stub/civfix",
      } as NodeJS.ProcessEnv),
    ).toThrow(/USE_FAKE_JOBS must be 0 in production/)
  })

  it("THROWS when the real seam is selected without a DATABASE_URL", () => {
    expect(() => buildJobs({ NODE_ENV: "test", USE_FAKE_JOBS: "0" } as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL is required when USE_FAKE_JOBS is off/,
    )
  })

  it("builds the real handle in production and derives its stop grace from MEDIA_JOB_TIMEOUT_MS", async () => {
    const handle = buildJobs({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://stub/civfix",
      MEDIA_JOB_TIMEOUT_MS: "1000",
    } as NodeJS.ProcessEnv)
    expect(handle.jobs).toBeInstanceOf(PgBossWorkerJobs)

    await handle.start()
    await handle.stop()

    expect(lastBoss().connectionString).toBe("postgres://stub/civfix")
    expect(lastBoss().stopCalls).toEqual([{ graceful: true, wait: true, timeout: 7_000 }])
  })
})
