/**
 * The developer console's jobs reads against real pg-boss 12 tables. pg-boss is started once to create
 * its schema and the queues, then stopped, so its maintenance never moves the rows these tests write.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { FakeJobs } from "@civfix/seams"
import type { AdminDevQueue } from "@civfix/contract"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleDevJobsRepository } from "../../src/services/admin/dev-jobs-repository.drizzle.js"
import type { DevJobsRepository } from "../../src/services/admin/dev-jobs-repository.js"
import { makeDevJobsService } from "../../src/services/admin/dev-jobs-service.js"
import { ALL_QUEUE_NAMES, PGBOSS_SCHEMA } from "../../src/lib/queue-names.js"

const pg = await withPg()

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const QUEUES = [
  "inbound.sweep",
  "outreach.digest",
  "event.metrics.rollup",
  "data.export",
  "host.export",
]
// Queues of their own for this slice's cases, so no real queue's rows can leak into them.
const Q = "gh297.q"
const R = "gh297.r"

type State = "created" | "retry" | "active" | "completed" | "failed"

describe.skipIf(!pg)("developer jobs reads (pg-boss 12)", () => {
  let h: PgHarness
  let repo: DevJobsRepository
  let t0: Date

  function ago(ms: number): Date {
    return new Date(t0.getTime() - ms)
  }

  async function job(
    name: string,
    state: State,
    at: { startAfter?: Date; completedOn?: Date | null } = {},
  ): Promise<void> {
    await h.sql`
      INSERT INTO pgboss_v12.job (name, state, start_after, started_on, completed_on)
      VALUES (
        ${name},
        ${state}::pgboss_v12.job_state,
        ${at.startAfter ?? ago(HOUR)},
        ${state === "created" || state === "retry" ? null : ago(HOUR)},
        ${at.completedOn ?? null}
      )
    `
  }

  function service() {
    return makeDevJobsService({
      repo,
      jobs: new FakeJobs(),
      jobsIsFake: false,
      audit: () => Promise.resolve(),
      now: () => t0,
    })
  }

  async function queue(name: string): Promise<AdminDevQueue> {
    const found = (await service().view()).queues.find((q) => q.name === name)
    if (found === undefined) throw new Error(`no ${name} in the view`)
    return found
  }

  beforeAll(async () => {
    h = pg as PgHarness
    const { PgBoss } = await import("pg-boss")
    const boss = new PgBoss({ connectionString: h.uri, schema: PGBOSS_SCHEMA })
    await boss.start()
    for (const name of [...QUEUES, Q, R]) await boss.createQueue(name)
    await boss.stop({ graceful: false })
    repo = makeDrizzleDevJobsRepository(h.sql)
  })

  beforeEach(async () => {
    await h.sql`DELETE FROM pgboss_v12.job`
    await h.sql`DELETE FROM pgboss_v12.schedule`
    t0 = new Date()
  })

  afterAll(async () => {
    await h?.teardown()
  })

  it("T28: reads the job table and the schedule", async () => {
    for (const state of ["created", "retry", "active"] as const) await job("inbound.sweep", state)
    await job("inbound.sweep", "failed", { completedOn: t0 })
    await job("inbound.sweep", "completed", { completedOn: ago(47 * HOUR) })
    await job("inbound.sweep", "completed", { completedOn: ago(48 * HOUR) })
    await h.sql`INSERT INTO pgboss_v12.schedule (name, cron) VALUES ('inbound.sweep', '*/5 * * * *')`

    const snapshot = await repo.snapshot(ALL_QUEUE_NAMES)
    expect(snapshot.stats).toEqual([
      {
        name: "inbound.sweep",
        created: 1,
        retry: 1,
        active: 1,
        failed: 1,
        failedLast24h: 1,
        oldestDueAt: ago(HOUR),
        lastCompletedAt: ago(47 * HOUR),
      },
    ])
    expect(snapshot.schedules).toEqual([{ name: "inbound.sweep", cron: "*/5 * * * *" }])
  })

  it("T28/T19: counts per state, end to end", async () => {
    for (const state of ["created", "created", "retry", "active"] as const) {
      await job("inbound.sweep", state)
    }
    for (let i = 0; i < 3; i += 1) await job("inbound.sweep", "failed", { completedOn: ago(HOUR) })
    const { queues } = await service().view()
    for (const q of queues) {
      expect(q.counts, q.name).toEqual(
        q.name === "inbound.sweep"
          ? { created: 2, retry: 1, active: 1, failed: 3 }
          : { created: 0, retry: 0, active: 0, failed: 0 },
      )
    }
  })

  it("T28/T20: failedLast24h, end to end", async () => {
    await job("outreach.digest", "failed", { completedOn: ago(2 * HOUR) })
    await job("outreach.digest", "failed", { completedOn: ago(20 * HOUR) })
    await job("outreach.digest", "failed", { completedOn: ago(30 * HOUR) })
    await job("outreach.digest", "failed", { completedOn: ago(25 * HOUR) })
    expect((await queue("outreach.digest")).failedLast24h).toBe(2)
  })

  it("T28/T21: oldestPendingSeconds, end to end", async () => {
    await job("inbound.sweep", "created", { startAfter: ago(300 * SECOND) })
    await job("inbound.sweep", "retry", { startAfter: ago(90 * SECOND) })
    await job("inbound.sweep", "created", { startAfter: ago(-600 * SECOND) })
    await job("inbound.sweep", "active", { startAfter: ago(1000 * SECOND) })
    expect((await queue("inbound.sweep")).oldestPendingSeconds).toBe(300)

    await h.sql`DELETE FROM pgboss_v12.job WHERE state IN ('created', 'retry') AND start_after <= now()`
    expect((await queue("inbound.sweep")).oldestPendingSeconds).toBe(0)
  })

  it("T28/T22: lastCompletedAt, end to end", async () => {
    await job("event.metrics.rollup", "completed", { completedOn: ago(2 * HOUR) })
    await job("event.metrics.rollup", "completed", { completedOn: ago(HOUR) })
    await job("event.metrics.rollup", "failed", { completedOn: ago(MINUTE) })
    expect((await queue("event.metrics.rollup")).lastCompletedAt).toBe(ago(HOUR).toISOString())
  })

  it("T28/T23: schedule, end to end", async () => {
    await h.sql`INSERT INTO pgboss_v12.schedule (name, cron) VALUES ('inbound.sweep', '*/5 * * * *')`
    expect((await queue("inbound.sweep")).schedule).toBe("*/5 * * * *")
    expect((await queue("data.export")).schedule).toBe(null)
  })

  it("T28/T24: a queue with no rows, end to end", async () => {
    await job("inbound.sweep", "created")
    expect(await queue("host.export")).toMatchObject({
      counts: { created: 0, retry: 0, active: 0, failed: 0 },
      failedLast24h: 0,
      oldestPendingSeconds: 0,
      lastCompletedAt: null,
    })
  })

  it("GH297-T18: live counts, the last day's failures and the last completion from pgboss_v12.job", async () => {
    await job(Q, "created", { startAfter: ago(10 * MINUTE) })
    await job(Q, "retry", { startAfter: ago(5 * MINUTE) })
    await job(Q, "active")
    await job(Q, "failed", { completedOn: ago(HOUR) })
    await job(Q, "failed", { completedOn: ago(25 * HOUR) })
    await job(Q, "completed", { completedOn: ago(HOUR) })
    await job(Q, "completed", { completedOn: ago(25 * HOUR) })

    const { stats } = await repo.snapshot([Q])
    expect(stats).toEqual([
      {
        name: Q,
        created: 1,
        retry: 1,
        active: 1,
        failed: 2,
        failedLast24h: 1,
        oldestDueAt: ago(10 * MINUTE),
        lastCompletedAt: ago(HOUR),
      },
    ])
  })

  it("GH297-T19: a queue with only day-old finished jobs still reports its last completion", async () => {
    await job(R, "completed", { completedOn: ago(25 * HOUR) })
    await job(R, "failed", { completedOn: ago(25 * HOUR) })

    const { stats } = await repo.snapshot([R])
    expect(stats).toEqual([
      {
        name: R,
        created: 0,
        retry: 0,
        active: 0,
        failed: 1,
        failedLast24h: 0,
        oldestDueAt: null,
        lastCompletedAt: ago(25 * HOUR),
      },
    ])
  })

  it("GH297-T20: each entry keeps the response keys, and schedules come from pgboss_v12.schedule", async () => {
    await job(Q, "created")
    await job(R, "completed", { completedOn: ago(HOUR) })
    await h.sql`INSERT INTO pgboss_v12.schedule (name, cron) VALUES ('inbound.sweep', '*/5 * * * *')`

    const snapshot = await repo.snapshot([Q, R, "inbound.sweep"])
    expect(snapshot.stats).toHaveLength(2)
    for (const entry of snapshot.stats) {
      expect(Object.keys(entry).sort()).toEqual(
        [
          "name",
          "created",
          "retry",
          "active",
          "failed",
          "failedLast24h",
          "oldestDueAt",
          "lastCompletedAt",
        ].sort(),
      )
    }
    expect(snapshot.schedules).toEqual([{ name: "inbound.sweep", cron: "*/5 * * * *" }])
  })

  it("GH297-T21: runState reads pgboss_v12.queue and pgboss_v12.job", async () => {
    await job(Q, "created", { startAfter: ago(MINUTE) })
    expect(await repo.runState(Q)).toEqual({ exists: true, waiting: true })
    expect(await repo.runState("no.such.queue")).toEqual({ exists: false, waiting: false })
  })

  it("T29/GH297-T22: a read gives up after the 2-second statement timeout", async () => {
    const holder = await h.sql.reserve()
    try {
      await holder`BEGIN`
      await holder`LOCK TABLE pgboss_v12.job IN ACCESS EXCLUSIVE MODE`
      const started = Date.now()
      const error = await repo.snapshot(ALL_QUEUE_NAMES).then(
        () => null,
        (err: unknown) => err,
      )
      const elapsed = Date.now() - started
      expect((error as { code?: string } | null)?.code).toBe("57014")
      expect(elapsed).toBeGreaterThanOrEqual(1900)
      expect(elapsed).toBeLessThan(5000)
    } finally {
      await holder`ROLLBACK`
      holder.release()
    }
  })

  it("T30: whether a queue exists and has a job waiting", async () => {
    expect((await repo.runState("inbound.sweep")).exists).toBe(true)
    expect((await repo.runState("chat.partition.maintenance")).exists).toBe(false)

    await job("inbound.sweep", "active")
    await job("inbound.sweep", "completed", { completedOn: ago(MINUTE) })
    expect(await repo.runState("inbound.sweep")).toEqual({ exists: true, waiting: false })

    await job("inbound.sweep", "created", { startAfter: ago(-HOUR) })
    expect(await repo.runState("inbound.sweep")).toEqual({ exists: true, waiting: true })

    await h.sql`DELETE FROM pgboss_v12.job`
    await job("inbound.sweep", "retry")
    expect(await repo.runState("inbound.sweep")).toEqual({ exists: true, waiting: true })
  })
})
